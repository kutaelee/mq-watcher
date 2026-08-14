import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT_DATABASE_VERSION = 4;
const E2E_PREFIX = "mq-watcher-indexeddb-e2e-";
const PROCESS_EXIT_TIMEOUT_MS = 5_000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findBrowserExecutable() {
  const configured = process.env.MQ_WATCHER_E2E_BROWSER;
  if (configured) {
    assert.equal(await pathExists(configured), true, `MQ_WATCHER_E2E_BROWSER does not exist: ${configured}`);
    return path.resolve(configured);
  }

  const candidates = process.platform === "win32"
    ? [
        path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && await pathExists(candidate)) return candidate;
    if (!path.isAbsolute(candidate)) {
      const lookup = spawnSync("which", [candidate], { encoding: "utf8", windowsHide: true });
      if (lookup.status === 0 && lookup.stdout.trim()) return lookup.stdout.trim();
    }
  }
  throw new Error("Chrome or Edge was not found. Set MQ_WATCHER_E2E_BROWSER to an executable path.");
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function captureOutput(child) {
  const chunks = [];
  const append = (chunk) => {
    chunks.push(String(chunk));
    if (chunks.length > 100) chunks.shift();
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => chunks.join("").trim();
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vinext exited before becoming ready (${child.exitCode}):\n${output()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The loopback listener is not ready yet.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}:\n${output()}`);
}

async function waitForDevToolsPort(userDataDirectory, child) {
  const activePortFile = path.join(userDataDirectory, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Browser exited before DevTools became ready (${child.exitCode})`);
    try {
      const [port] = (await readFile(activePortFile, "utf8")).split(/\r?\n/u);
      if (/^\d+$/u.test(port)) return Number(port);
    } catch {
      // Chrome creates this file after its isolated profile is initialized.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${activePortFile}`);
}

async function waitForPageTarget(debugPort) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      }).then((response) => response.json());
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // DevTools HTTP discovery can lag behind DevToolsActivePort creation.
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for a Chrome page target");
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.webSocket.addEventListener("open", resolve, { once: true });
      this.webSocket.addEventListener("error", () => reject(new Error("Chrome DevTools WebSocket failed to open")), { once: true });
    });
    this.webSocket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
    this.webSocket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Chrome DevTools WebSocket closed"));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.webSocket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  waitFor(method, timeoutMilliseconds = 10_000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        remove();
        reject(new Error(`Timed out waiting for Chrome event ${method}`));
      }, timeoutMilliseconds);
      const remove = this.on(method, (params) => {
        clearTimeout(timeout);
        remove();
        resolve(params);
      });
    });
  }

  close() {
    if (this.webSocket.readyState === WebSocket.OPEN) this.webSocket.close();
  }
}

async function navigate(client, url) {
  const loaded = client.waitFor("Page.loadEventFired");
  const navigation = await client.send("Page.navigate", { url });
  assert.equal(navigation.errorText, undefined, `Navigation failed: ${navigation.errorText}`);
  await loaded;
}

async function reload(client) {
  const loaded = client.waitFor("Page.loadEventFired");
  await client.send("Page.reload", { ignoreCache: true });
  await loaded;
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result.value;
}

const seedLegacyDatabaseExpression = `(${async function seedLegacyDatabase() {
  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transactionComplete = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });

  await requestResult(indexedDB.deleteDatabase("mq-watcher"));
  const openRequest = indexedDB.open("mq-watcher", 1);
  openRequest.onupgradeneeded = () => {
    openRequest.result.createObjectStore("scan-results", { keyPath: "signature" });
    openRequest.result.createObjectStore("workbench-state", { keyPath: "id" });
    openRequest.result.createObjectStore("incident-cases", { keyPath: "id" });
  };
  const database = await requestResult(openRequest);
  const transaction = database.transaction(["scan-results", "workbench-state", "incident-cases"], "readwrite");
  transaction.objectStore("scan-results").put({ signature: "legacy-scan-result", marker: "must-be-invalidated" });
  transaction.objectStore("workbench-state").put({
    id: "current",
    activeSessionId: "legacy-session",
    sessions: [{ id: "legacy-session", signature: "legacy-scan-result", marker: "must-be-invalidated" }],
  });
  transaction.objectStore("incident-cases").put({
    id: "legacy-case-preserved",
    title: "Legacy case must survive",
    hypothesis: "preservation sentinel",
    notes: [{ id: "legacy-note", text: "keep this note", createdAt: "2026-01-01T00:00:00.000Z" }],
    pins: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    marker: "must-be-preserved",
  });
  await transactionComplete(transaction);
  const summary = {
    version: database.version,
    stores: Array.from(database.objectStoreNames),
  };
  database.close();
  return summary;
}})()`;

const inspectCurrentDatabaseExpression = `(${async function inspectCurrentDatabase() {
  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transactionComplete = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const databases = await indexedDB.databases();
    if (databases.find((entry) => entry.name === "mq-watcher")?.version === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const database = await requestResult(indexedDB.open("mq-watcher"));
  const stores = Array.from(database.objectStoreNames);
  const transaction = database.transaction(stores, "readonly");
  const rows = Object.fromEntries(await Promise.all(stores.map(async (storeName) => [
    storeName,
    await requestResult(transaction.objectStore(storeName).getAll()),
  ])));
  await transactionComplete(transaction);
  const result = { version: database.version, stores, rows };
  database.close();
  return result;
}})()`;

const addIdempotenceSentinelsExpression = `(${async function addIdempotenceSentinels() {
  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transactionComplete = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
  const demoResult = await fetch("/demo-result.json", { cache: "no-store" }).then((response) => response.json());
  demoResult.signature = "current-schema-store";
  demoResult.directoryName = "current-schema-demo";
  const database = await requestResult(indexedDB.open("mq-watcher"));
  const transaction = database.transaction(["scan-results", "workbench-state", "incident-cases"], "readwrite");
  transaction.objectStore("scan-results").put({ signature: "current-schema-scan", marker: "must-survive-reload" });
  transaction.objectStore("workbench-state").put({ id: "idempotence-sentinel", marker: "must-survive-reload" });
  transaction.objectStore("workbench-state").put({
    id: "current",
    activeSessionId: "current-schema-session",
    sessions: [{
      id: "current-schema-session",
      signature: demoResult.signature,
      name: demoResult.directoryName,
      result: demoResult,
      activeView: "overview",
      selected: null,
      openedAt: "2026-08-14T00:00:00.000Z",
    }],
  });
  transaction.objectStore("incident-cases").put({
    id: "current-schema-case",
    title: "Unresolved reference sentinel",
    hypothesis: "UI must preserve and mark this reference unresolved",
    notes: [],
    pins: [{
      id: "foreign-pin",
      semanticKey: "message:ID:FOREIGN:UNRESOLVED",
      storeSignature: "foreign-store-signature",
      storeName: "foreign-store",
      kind: "message",
      label: "Foreign unresolved evidence",
      provenance: { file: "db-99.log", offset: 99 },
      confidence: "Observed",
      pinnedAt: "2026-08-14T00:00:00.000Z",
    }],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    marker: "must-survive-reload",
  });
  await transactionComplete(transaction);
  database.close();
  return true;
}})()`;

function assertMigratedDatabase(snapshot) {
  assert.equal(snapshot.version, CURRENT_DATABASE_VERSION, "the application must open IndexedDB at version 4");
  assert.deepEqual(snapshot.stores, ["incident-cases", "scan-results", "schema-meta", "workbench-state"]);
  assert.equal(snapshot.rows["scan-results"].some((row) => row.signature === "legacy-scan-result"), false, "legacy scan cache must be invalidated");
  assert.equal(snapshot.rows["workbench-state"].some((row) => row.sessions?.some((session) => session.id === "legacy-session")), false, "legacy workbench sessions must be invalidated");
  const legacyCase = snapshot.rows["incident-cases"].find((row) => row.id === "legacy-case-preserved");
  assert.equal(legacyCase?.marker, "must-be-preserved", "incident cases must survive migration");
  assert.equal(legacyCase?.notes?.[0]?.text, "keep this note", "incident case content must remain intact");
  assert.deepEqual(snapshot.rows["schema-meta"], [{ id: "schema", version: CURRENT_DATABASE_VERSION }]);
}

function assertIdempotentReload(snapshot) {
  assertMigratedDatabase(snapshot);
  assert.equal(snapshot.rows["scan-results"].some((row) => row.signature === "current-schema-scan" && row.marker === "must-survive-reload"), true, "current scan cache must survive a same-version reload");
  assert.equal(snapshot.rows["workbench-state"].some((row) => row.id === "idempotence-sentinel" && row.marker === "must-survive-reload"), true, "current workbench data must survive a same-version reload");
  assert.equal(snapshot.rows["incident-cases"].some((row) => row.id === "current-schema-case" && row.marker === "must-survive-reload"), true, "current incident cases must survive a same-version reload");
}

const openCaseAndReadUnresolvedExpression = `(${async function openCaseAndReadUnresolved() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (document.querySelector(".case-layout")) break;
    const button = Array.from(document.querySelectorAll("button")).find((candidate) => {
      const text = candidate.textContent ?? "";
      return text.includes("조사 케이스") || text.includes("Incident case");
    });
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!document.querySelector(".case-layout")) throw new Error("the hydrated Incident Case view did not open");
  while (Date.now() < deadline) {
    const text = document.body?.innerText ?? "";
    if ((text.includes("현재 미해결") || text.includes("Currently unresolved")) && text.includes("Foreign unresolved evidence")) {
      return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the restored foreign evidence reference was not rendered as unresolved");
}})()`;

function waitForExit(child, timeoutMilliseconds) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMilliseconds);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function terminateOwnedProcess(child) {
  if (!child || child.exitCode !== null) return true;
  child.kill("SIGTERM");
  if (await waitForExit(child, PROCESS_EXIT_TIMEOUT_MS)) return true;

  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process group may have exited between the bounded wait and cleanup.
    }
  }
  return waitForExit(child, PROCESS_EXIT_TIMEOUT_MS);
}

async function removeOwnedTemporaryDirectory(temporaryRoot) {
  const resolvedBase = path.resolve(tmpdir());
  const resolvedTarget = path.resolve(temporaryRoot);
  assert.equal(resolvedTarget.startsWith(`${resolvedBase}${path.sep}`), true, "temporary root must stay inside the OS temp directory");
  assert.equal(path.basename(resolvedTarget).startsWith(E2E_PREFIX), true, "temporary root must use the task-owned prefix");
  await rm(resolvedTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return !(await pathExists(resolvedTarget));
}

async function main() {
  const browserExecutable = await findBrowserExecutable();
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), E2E_PREFIX));
  const userDataDirectory = path.join(temporaryRoot, "profile");
  const cacheDirectory = path.join(temporaryRoot, "cache");
  const vinextCli = path.join(REPOSITORY_ROOT, "node_modules", "vinext", "dist", "cli.js");
  const serverPort = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${serverPort}`;
  let serverProcess;
  let browserProcess;
  let client;
  let serverOutput = () => "";
  let testError;
  const browserErrors = [];
  const cleanup = { browserPid: null, browserStopped: false, serverPid: null, serverStopped: false, temporaryRoot, temporaryRootRemoved: false };

  try {
    serverProcess = spawn(process.execPath, [vinextCli, "start", "--port", String(serverPort), "--hostname", "127.0.0.1"], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    cleanup.serverPid = serverProcess.pid;
    serverOutput = captureOutput(serverProcess);
    await waitForServer(`${origin}/favicon.svg`, serverProcess, serverOutput);

    const browserArguments = [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDirectory}`,
      `--disk-cache-dir=${cacheDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--window-size=1280,800",
    ];
    if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) browserArguments.push("--no-sandbox");
    browserArguments.push("about:blank");
    browserProcess = spawn(browserExecutable, browserArguments, {
      stdio: "ignore",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    cleanup.browserPid = browserProcess.pid;

    const debugPort = await waitForDevToolsPort(userDataDirectory, browserProcess);
    client = new CdpClient(await waitForPageTarget(debugPort));
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => browserErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    client.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type === "error") browserErrors.push(args.map((argument) => argument.value ?? argument.description ?? "").join(" "));
    });

    await navigate(client, `${origin}/favicon.svg`);
    assert.equal(await evaluate(client, "location.origin"), origin, "the seed document must use the application origin");
    const seeded = await evaluate(client, seedLegacyDatabaseExpression);
    assert.equal(seeded.version, 1);
    assert.deepEqual(seeded.stores, ["incident-cases", "scan-results", "workbench-state"]);

    await navigate(client, `${origin}/`);
    const bodyLength = await evaluate(client, `new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        const length = document.body?.innerText.trim().length ?? 0;
        if (length > 100) resolve(length);
        else if (Date.now() >= deadline) reject(new Error("application body remained blank"));
        else setTimeout(check, 50);
      };
      check();
    })`);
    assert.ok(bodyLength > 100, "the application must render meaningful content");
    const firstReload = await evaluate(client, inspectCurrentDatabaseExpression);
    assertMigratedDatabase(firstReload);

    await evaluate(client, addIdempotenceSentinelsExpression);
    await reload(client);
    const secondReload = await evaluate(client, inspectCurrentDatabaseExpression);
    assertIdempotentReload(secondReload);
    const caseText = await evaluate(client, openCaseAndReadUnresolvedExpression);
    assert.match(caseText, /현재 미해결|Currently unresolved/u);
    assert.match(caseText, /Foreign unresolved evidence/u);

    const overlay = await evaluate(client, "Boolean(document.querySelector('[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay'))");
    assert.equal(overlay, false, "the application must not show a framework error overlay");
    assert.deepEqual(browserErrors, [], "the browser must not report console errors or uncaught exceptions");
  } catch (error) {
    testError = error;
  } finally {
    if (client) {
      try {
        await Promise.race([client.send("Browser.close"), sleep(1_000)]);
      } catch {
        // Process cleanup below remains authoritative.
      }
      client.close();
    }
    cleanup.browserStopped = await terminateOwnedProcess(browserProcess);
    cleanup.serverStopped = await terminateOwnedProcess(serverProcess);
    cleanup.temporaryRootRemoved = await removeOwnedTemporaryDirectory(temporaryRoot);
  }

  if (testError) {
    const diagnostics = serverOutput();
    if (diagnostics) testError.message += `\nvinext output:\n${diagnostics}`;
    testError.message += `\ncleanup: ${JSON.stringify(cleanup)}`;
    throw testError;
  }
  assert.equal(cleanup.browserStopped, true, `browser PID ${cleanup.browserPid} must be stopped`);
  assert.equal(cleanup.serverStopped, true, `server PID ${cleanup.serverPid} must be stopped`);
  assert.equal(cleanup.temporaryRootRemoved, true, `temporary root must be removed: ${cleanup.temporaryRoot}`);

  console.log(JSON.stringify({
    browser: browserExecutable,
    assertions: [
      "legacy database seeded at version 1",
      "application upgraded database to version 4",
      "legacy scan cache invalidated",
      "legacy workbench state invalidated",
      "incident case preserved",
      "schema-meta version recorded",
      "same-version reload preserved current-schema sentinels",
      "restored foreign case reference rendered as unresolved",
      "application rendered without browser errors",
    ],
    cleanup,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
