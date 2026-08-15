import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT_DATABASE_VERSION = 4;
const E2E_PREFIX = "mq-watcher-indexeddb-e2e-";
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const DEVTOOLS_READY_TIMEOUT_MS = 30_000;

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

async function waitForPageTarget(debugPort, child, output) {
  const endpoint = `http://127.0.0.1:${debugPort}/json/list`;
  const deadline = Date.now() + DEVTOOLS_READY_TIMEOUT_MS;
  let lastError = "DevTools endpoint did not respond";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
      lastError = `DevTools returned ${targets.length} target(s), but no page target`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Browser exited before DevTools became ready (exit=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"}).\n`
        + `endpoint: ${endpoint}\nlast error: ${lastError}\nbrowser output:\n${output() || "<empty>"}`,
      );
    }
    await sleep(100);
  }
  throw new Error(
    `Timed out after ${DEVTOOLS_READY_TIMEOUT_MS}ms waiting for a Chrome page target.\n`
    + `endpoint: ${endpoint}\nlast error: ${lastError}\nbrowser output:\n${output() || "<empty>"}`,
  );
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
  demoResult.correlation.links.push(...Array.from({ length: 140 }, (_, index) => ({
    id: `scenario-link-${index}`,
    kind: "message",
    primaryId: `ID:SCENARIO:${index}`,
    destination: "ORDERS",
    destinationType: "Queue",
    journal: "db-1.log",
    offset: 1000 + index,
    ackStatus: "Not observed in scanned evidence",
    interpretation: "Synthetic evidence reference used to verify progressive disclosure.",
    interpretationCode: "ack.notObserved",
    transactionId: "Unknown",
    confidence: "Observed",
    evidenceRefs: [{ id: `scenario-ref-${index}`, kind: "parsed-record", file: "db-1.log", offset: 1000 + index, label: `ID:SCENARIO:${index}`, confidence: "Observed" }],
  })));
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
    storeSignature: "current-schema-store",
    storeName: "current-schema-demo",
    title: "Unresolved reference sentinel",
    hypothesis: "UI must preserve and mark this reference unresolved",
    notes: [],
    pins: [{
      id: "foreign-pin",
      semanticKey: "message:ID:FOREIGN:UNRESOLVED",
      storeSignature: "current-schema-store",
      storeName: "current-schema-demo",
      kind: "message",
      label: "Unresolved message evidence",
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
    if ((text.includes("현재 미해결") || text.includes("Currently unresolved")) && text.includes("Unresolved message evidence")) {
      return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the restored same-Store semantic reference was not rendered as unresolved");
}})()`;

const setKoreanLocaleExpression = `(${async function setKoreanLocale() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === "한국어");
    button?.click();
    if (document.documentElement.lang === "ko" && localStorage.getItem("mq-watcher-locale") === "ko") return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Korean locale was not applied and persisted");
}})()`;

const pinEvidenceFromCaseExpression = `(${async function pinEvidenceFromCase() {
  const deadline = Date.now() + 10_000;
  const input = document.querySelector(".case-evidence-search input");
  if (!input) throw new Error("case evidence search is unavailable");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter.call(input, "ORDERS");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  while (Date.now() < deadline) {
    const candidate = document.querySelector(".case-candidate-select");
    if (candidate) {
      candidate.click();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  while (Date.now() < deadline) {
    const selected = document.querySelector(".case-pin-action small")?.textContent ?? "";
    const pin = document.querySelector(".case-pin-action .button");
    if (selected.includes("ORDERS") && pin) {
      pin.click();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  while (Date.now() < deadline) {
    const text = document.querySelector(".case-pins")?.textContent ?? "";
    if (text.includes("ORDERS")) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("case evidence picker did not pin the selected evidence");
}})()`;

const createAndDeleteCaseExpression = `(${async function createAndDeleteCase() {
  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const readKeys = async () => {
    const database = await requestResult(indexedDB.open("mq-watcher"));
    const keys = await requestResult(database.transaction("incident-cases", "readonly").objectStore("incident-cases").getAllKeys());
    database.close();
    return keys;
  };
  const before = await readKeys();
  const create = document.querySelector(".case-list-head button");
  if (!create) throw new Error("new case action is unavailable");
  create.click();
  const deadline = Date.now() + 10_000;
  let createdId = "";
  while (Date.now() < deadline) {
    const afterCreate = await readKeys();
    createdId = afterCreate.find((key) => !before.includes(key)) ?? "";
    if (createdId && document.querySelector(".case-editor-actions button")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!createdId) throw new Error("new case was not persisted");
  window.confirm = () => true;
  document.querySelector(".case-editor-actions button").click();
  while (Date.now() < deadline) {
    if (!(await readKeys()).includes(createdId)) return createdId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("deleted case remained in IndexedDB");
}})()`;

const inspectProgressiveJournalExpression = `(${async function inspectProgressiveJournal() {
  const deadline = Date.now() + 10_000;
  const journalButton = () => Array.from(document.querySelectorAll("button")).find((candidate) => /저널 보존 탐색|Journal retention/u.test(candidate.textContent ?? ""));
  while (Date.now() < deadline && !document.querySelector(".journal-layout")) {
    journalButton()?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const before = document.querySelectorAll(".journal-refs > div").length;
  const loadMore = document.querySelector(".journal-load-more");
  if (before !== 50 || !loadMore) throw new Error(`expected 50 initial references and a load-more action, received ${before}`);
  loadMore.click();
  while (Date.now() < deadline) {
    const after = document.querySelectorAll(".journal-refs > div").length;
    if (after > before) return { before, after };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("journal references did not continue after user request");
}})()`;

const closeStoreAndReadToastExpression = `(${async function closeStoreAndReadToast() {
  const deadline = Date.now() + 10_000;
  document.querySelector(".store-tab-close")?.click();
  while (Date.now() < deadline && document.querySelector(".store-tab")) await new Promise((resolve) => setTimeout(resolve, 50));
  const messages = Array.from(document.querySelectorAll(".nav-item")).find((candidate) => /메시지|Messages/u.test(candidate.textContent ?? ""));
  if (!messages) throw new Error("messages navigation action is unavailable");
  messages.click();
  while (Date.now() < deadline) {
    const text = document.querySelector(".app-toast")?.textContent ?? "";
    if (/저장소를 먼저 열어|Open a Store first/u.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("empty navigation did not explain why the view is unavailable");
}})()`;

const loadSyntheticDemoTwiceExpression = `(${async function loadSyntheticDemoTwice() {
  const deadline = Date.now() + 10_000;
  const button = document.querySelector(".empty-actions button:last-child");
  if (!button) throw new Error("synthetic demo action is unavailable");
  button.click();
  button.click();
  while (Date.now() < deadline) {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.replace(/복원됨|restored/gu, "").trim() ?? "");
    if (tabs.length === 2) {
      if (new Set(tabs).size !== 2) throw new Error(`duplicate synthetic Store tabs were created: ${tabs.join(", ")}`);
      return tabs;
    }
    if (tabs.length > 2) throw new Error(`double-click opened ${tabs.length} synthetic Store tabs`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("synthetic demo did not open exactly two snapshots");
}})()`;

const verifyDirectMessagePageExpression = `(${async function verifyDirectMessagePage() {
  const deadline = Date.now() + 10_000;
  const messagesButton = () => Array.from(document.querySelectorAll(".nav-item")).find((candidate) => /메시지|Message and record/u.test(candidate.textContent ?? ""));
  while (Date.now() < deadline && !document.querySelector(".table-footer .page-jump")) {
    messagesButton()?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const footer = document.querySelector(".table-footer");
  const pageSize = footer?.querySelector("select");
  if (!footer || !pageSize) throw new Error("message pagination controls are unavailable");
  const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  selectSetter.call(pageSize, "25");
  pageSize.dispatchEvent(new Event("change", { bubbles: true }));

  const waitForPage = async (page, rowCount, rangePattern) => {
    while (Date.now() < deadline) {
      const current = document.querySelector('.page-numbers button[aria-current="page"]')?.textContent?.trim();
      const rows = document.querySelectorAll(".table-card tbody tr").length;
      const text = document.querySelector(".table-footer")?.textContent ?? "";
      if (current === String(page) && rows === rowCount && rangePattern.test(text)) return text;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`message page ${page} did not render the expected rows`);
  };
  await waitForPage(1, 25, /(?:1–25.*41|41.*1–25)/u);

  const input = document.querySelector(".page-jump input");
  const go = document.querySelector(".page-jump button");
  const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!input || !go) throw new Error("direct page input is unavailable");
  inputSetter.call(input, "2");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  go.click();
  const second = await waitForPage(2, 16, /(?:26–41.*41|41.*26–41)/u);

  inputSetter.call(input, "1");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  const first = await waitForPage(1, 25, /(?:1–25.*41|41.*1–25)/u);
  return { second, first };
}})()`;

const traceComparisonOnlyMessageExpression = `(${async function traceComparisonOnlyMessage() {
  const deadline = Date.now() + 10_000;
  const targetId = "ID:SYNTHETIC:ADVISORY:0001";
  while (Date.now() < deadline && !document.querySelector(".compare-picker")) {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) => /스냅샷 비교|Snapshot compare/u.test(candidate.textContent ?? ""));
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  while (Date.now() < deadline) {
    const target = Array.from(document.querySelectorAll("button.text-link")).find((button) => button.textContent?.trim() === targetId);
    if (target) {
      target.click();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  while (Date.now() < deadline) {
    const allScope = Array.from(document.querySelectorAll(".trace-scope label")).find((label) => /열린 모든 Store|All Open Stores/u.test(label.textContent ?? ""));
    const input = allScope?.querySelector("input");
    const text = document.querySelector(".trace-view")?.textContent ?? "";
    if (input?.checked && text.includes(targetId) && text.includes("synthetic-advisory-investigation")) return { targetId, allScope: true };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("a comparison-only Message ID did not open an all-Store trace with its source Store evidence");
}})()`;

const pinTraceEvidenceInOwningStoreExpression = `(${async function pinTraceEvidenceInOwningStore() {
  const deadline = Date.now() + 10_000;
  const targetId = "ID:SYNTHETIC:ADVISORY:0001";
  const select = document.querySelector(".trace-evidence-row button");
  if (!select) throw new Error("the trace result does not expose a case selection action");
  select.click();
  while (Date.now() < deadline && !document.querySelector(".case-layout")) await new Promise((resolve) => setTimeout(resolve, 50));
  const storeName = document.querySelector(".source-name")?.textContent ?? "";
  if (!storeName.includes("synthetic-advisory-investigation")) throw new Error(`trace evidence opened the wrong Store: ${storeName}`);

  if (!document.querySelector(".case-editor")) {
    const create = document.querySelector(".case-list-empty button") ?? document.querySelector(".case-list-head button");
    if (!create) throw new Error("a Store-scoped case could not be created from the trace selection");
    create.click();
  }
  while (Date.now() < deadline && !document.querySelector(".case-pin-action")) await new Promise((resolve) => setTimeout(resolve, 50));
  const selected = document.querySelector(".case-pin-action small")?.textContent?.trim() ?? "";
  const pin = Array.from(document.querySelectorAll(".case-pin-action button")).find((button) => /증거 고정|Pin evidence/u.test(button.textContent ?? ""));
  if (!selected || !pin || pin.disabled) throw new Error("the trace selection was not retained as the case's current evidence");
  pin.click();
  while (Date.now() < deadline) {
    const semanticKey = Array.from(document.querySelectorAll(".case-pins code")).find((code) => code.textContent === `message:${targetId}`)?.textContent;
    if (semanticKey) return { storeName, selected, semanticKey };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the selected trace occurrence was not pinned to its owning Store case");
}})()`;

const rejectInvalidExportTraceExpression = `(${async function rejectInvalidExportTrace() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !document.querySelector("#export-trace")) {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) => /증거 번들 내보내기|Evidence bundle/u.test(candidate.textContent ?? ""));
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const input = document.querySelector("#export-trace");
  if (!input) throw new Error("Evidence Export trace input is unavailable");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter.call(input, "ID: INVALID VALUE");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  document.querySelector(".export-button")?.click();
  while (Date.now() < deadline) {
    const alert = document.querySelector('[role="alert"]')?.textContent ?? "";
    if (/정확한 JMSMessageID|exact JMSMessageID/u.test(alert) && !document.querySelector(".export-progress")) return alert;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("an invalid non-empty export Message ID did not block bundle creation with a visible error");
}})()`;

const inspectJournalStoreIsolationExpression = `(${async function inspectJournalStoreIsolation() {
  const deadline = Date.now() + 10_000;
  const clickButton = (pattern) => Array.from(document.querySelectorAll("button")).find((candidate) => pattern.test(candidate.textContent ?? ""))?.click();
  clickButton(/저널 보존 탐색|Journal retention/u);
  while (Date.now() < deadline && !document.querySelector(".journal-layout")) await new Promise((resolve) => setTimeout(resolve, 50));
  Array.from(document.querySelectorAll(".journal-row-select")).find((candidate) => candidate.textContent?.trim() === "db-2.log")?.click();
  while (Date.now() < deadline && document.querySelectorAll(".journal-refs > div").length !== 50) await new Promise((resolve) => setTimeout(resolve, 50));
  document.querySelector(".journal-load-more")?.click();
  while (Date.now() < deadline && document.querySelectorAll(".journal-refs > div").length !== 150) await new Promise((resolve) => setTimeout(resolve, 50));
  const expanded = document.querySelectorAll(".journal-refs > div").length;
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const baseline = tabs.find((tab) => /synthetic-advisory-baseline/u.test(tab.textContent ?? ""));
  const investigation = tabs.find((tab) => /synthetic-advisory-investigation/u.test(tab.textContent ?? ""));
  baseline?.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  clickButton(/저널 보존 탐색|Journal retention/u);
  while (Date.now() < deadline && !document.querySelector(".journal-layout")) await new Promise((resolve) => setTimeout(resolve, 50));
  investigation?.click();
  while (Date.now() < deadline) {
    const reset = document.querySelectorAll(".journal-refs > div").length;
    if (reset === 19) return { expanded, reset };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`journal state leaked across Store tabs; expanded=${expanded}, reset=${document.querySelectorAll(".journal-refs > div").length}`);
}})()`;

const verifyAnnotatedGuideExpression = `(${async function verifyAnnotatedGuide() {
  const deadline = Date.now() + 10_000;
  const guide = document.querySelector(".view-guide-button");
  if (!guide) throw new Error("screen annotation action is unavailable");
  guide.click();
  while (Date.now() < deadline && !document.querySelector(".screen-tour-callout")) await new Promise((resolve) => setTimeout(resolve, 50));
  const firstTarget = document.querySelector(".screen-tour-highlight")?.getBoundingClientRect();
  const firstTitle = document.querySelector(".screen-tour-callout h2")?.textContent?.trim() ?? "";
  const next = document.querySelector(".screen-tour-actions .primary");
  if (!firstTarget?.width || !firstTitle || !next) throw new Error("the guide did not annotate an actual screen element");
  next.click();
  while (Date.now() < deadline) {
    const secondTitle = document.querySelector(".screen-tour-callout h2")?.textContent?.trim() ?? "";
    if (secondTitle && secondTitle !== firstTitle) {
      document.querySelector(".screen-tour-head button")?.click();
      return { firstTitle, secondTitle, highlighted: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the screen annotation did not advance to the next actual element");
}})()`;

const verifyActionableGuidesExpression = `(${async function verifyActionableGuides() {
  const cases = [
    { labels: ["메시지", "Messages"], title: /2,500/u, target: ".message-load-more, .best-effort" },
    { labels: ["저널 보존 탐색", "Journal retention"], title: /역색인 참조|reverse-index references/iu, target: ".journal-reference-head" },
    { labels: ["조사 케이스", "Incident case"], title: /케이스를 만든 뒤|Create a case/iu, target: ".case-list" },
    { labels: ["메시지 추적", "Trace a Message"], title: /Store 범위|Store search scope/iu, target: ".trace-scope" },
    { labels: ["증거 번들 내보내기", "Evidence bundle"], title: /Message Trace/iu, target: ".export-trace-option" },
  ];
  const results = [];
  for (const item of cases) {
    const deadline = Date.now() + 15_000;
    const navigation = Array.from(document.querySelectorAll(".nav-item")).find((button) => item.labels.includes(button.querySelector("span")?.textContent?.trim() ?? ""));
    if (!navigation) throw new Error(`missing guide navigation: ${item.labels.join("/")}`);
    navigation.click();
    while (Date.now() < deadline && !navigation.classList.contains("active")) await new Promise((resolve) => setTimeout(resolve, 50));
    const guide = document.querySelector(".view-guide-button");
    if (!guide) throw new Error(`missing guide action: ${item.labels[0]}`);
    guide.click();
    while (Date.now() < deadline && !document.querySelector(".screen-tour-callout")) await new Promise((resolve) => setTimeout(resolve, 50));
    let matched = false;
    for (let step = 0; step < 12 && Date.now() < deadline; step += 1) {
      const title = document.querySelector(".screen-tour-callout h2")?.textContent?.trim() ?? "";
      if (item.title.test(title)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const target = document.querySelector(item.target)?.getBoundingClientRect();
        const highlight = document.querySelector(".screen-tour-highlight")?.getBoundingClientRect();
        if (!target?.width || !highlight?.width) throw new Error(`guide target was not highlighted: ${title}`);
        const overlapWidth = Math.max(0, Math.min(highlight.right, target.right) - Math.max(highlight.left, target.left));
        const overlapHeight = Math.max(0, Math.min(highlight.bottom, target.bottom) - Math.max(highlight.top, target.top));
        const overlapRatio = (overlapWidth * overlapHeight) / Math.max(1, target.width * target.height);
        if (overlapRatio < 0.5) throw new Error(`guide highlight missed its control: ${title} (${overlapRatio.toFixed(2)})`);
        document.querySelector(".screen-tour-head button")?.click();
        results.push({ view: item.labels[0], title });
        matched = true;
        break;
      }
      const previousTitle = title;
      document.querySelector(".screen-tour-actions .primary")?.click();
      while (Date.now() < deadline) {
        const nextTitle = document.querySelector(".screen-tour-callout h2")?.textContent?.trim() ?? "";
        if (!nextTitle || nextTitle !== previousTitle) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!matched) throw new Error(`actionable guide step was not found: ${item.labels[0]}`);
  }
  return results;
}})()`;

const verifySyntheticTutorialExpression = `(${async function verifySyntheticTutorial() {
  const deadline = Date.now() + 15_000;
  document.querySelector(".tutorial-button")?.click();
  while (Date.now() < deadline && !document.querySelector(".tutorial-preview video")) await new Promise((resolve) => setTimeout(resolve, 50));
  const video = document.querySelector(".tutorial-preview video");
  const track = video?.querySelector("track[kind='captions']");
  const start = document.querySelector(".dialog-actions .button-primary") ?? document.querySelector(".dialog-actions button:last-child");
  if (!video?.querySelector("source") || !track || !start) throw new Error("the tutorial preview video or localized captions are unavailable");
  start.click();
  while (Date.now() < deadline && !document.querySelector(".screen-tour-callout")) await new Promise((resolve) => setTimeout(resolve, 50));
  const views = [];
  for (let index = 0; index < 6; index += 1) {
    let title = "";
    let activeView = "";
    let highlight;
    while (Date.now() < deadline) {
      title = document.querySelector(".screen-tour-callout h2")?.textContent?.trim() ?? "";
      activeView = document.querySelector(".nav-item.active")?.textContent?.trim() ?? "";
      highlight = document.querySelector(".screen-tour-highlight")?.getBoundingClientRect();
      if (title && activeView && highlight?.width) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!title || !activeView || !highlight?.width) throw new Error(`tutorial step ${index + 1} is not attached to the actual workspace`);
    views.push(activeView);
    document.querySelector(".screen-tour-actions .primary")?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (document.querySelector(".screen-tour-callout")) throw new Error("the tutorial did not finish after six steps");
  return { views, video: true, captions: true };
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
  let browserOutput = () => "";
  let testError;
  const browserErrors = [];
  const cleanup = { browserPid: null, browserStopped: false, serverPid: null, firstServerStopped: false, serverStopped: false, temporaryRoot, temporaryRootRemoved: false };

  const launchServer = async () => {
    const child = spawn(process.execPath, [vinextCli, "start", "--port", String(serverPort), "--hostname", "127.0.0.1"], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const output = captureOutput(child);
    await waitForServer(`${origin}/favicon.svg`, child, output);
    return { child, output };
  };

  try {
    ({ child: serverProcess, output: serverOutput } = await launchServer());
    cleanup.serverPid = serverProcess.pid;

    const debugPort = await reserveLoopbackPort();
    const browserArguments = [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
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
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    cleanup.browserPid = browserProcess.pid;
    browserOutput = captureOutput(browserProcess);

    client = new CdpClient(await waitForPageTarget(debugPort, browserProcess, browserOutput));
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
    assert.equal(await evaluate(client, "document.documentElement.lang"), "en", "a first-time workspace must start in English");
    const firstReload = await evaluate(client, inspectCurrentDatabaseExpression);
    assertMigratedDatabase(firstReload);

    await evaluate(client, addIdempotenceSentinelsExpression);
    await reload(client);
    const secondReload = await evaluate(client, inspectCurrentDatabaseExpression);
    assertIdempotentReload(secondReload);
    const caseText = await evaluate(client, openCaseAndReadUnresolvedExpression);
    assert.match(caseText, /현재 미해결|Currently unresolved/u);
    assert.match(caseText, /Unresolved message evidence/u);
    assert.match(await evaluate(client, pinEvidenceFromCaseExpression), /ORDERS/u);
    assert.equal(typeof await evaluate(client, createAndDeleteCaseExpression), "string");
    const progressiveJournal = await evaluate(client, inspectProgressiveJournalExpression);
    assert.deepEqual(progressiveJournal, { before: 50, after: 150 });
    assert.equal(await evaluate(client, setKoreanLocaleExpression), true);

    cleanup.firstServerStopped = await terminateOwnedProcess(serverProcess);
    assert.equal(cleanup.firstServerStopped, true, "the first application server must stop before restart");
    ({ child: serverProcess, output: serverOutput } = await launchServer());
    cleanup.serverPid = serverProcess.pid;
    await reload(client);
    const restoredState = await evaluate(client, `new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        const store = document.querySelector(".source-name")?.textContent ?? "";
        const journalVisible = Boolean(document.querySelector(".journal-layout"));
        const journalNavigation = Array.from(document.querySelectorAll(".nav-item")).some((item) => item.textContent?.includes("저널 보존 탐색"));
        if (document.documentElement.lang === "ko" && localStorage.getItem("mq-watcher-locale") === "ko" && store.includes("current-schema-demo") && journalVisible && journalNavigation) resolve({ locale: document.documentElement.lang, store, journalVisible });
        else if (Date.now() >= deadline) reject(new Error("locale or cached Store was not restored after server restart"));
        else setTimeout(check, 50);
      };
      check();
    })`);
    assert.equal(restoredState.locale, "ko");
    assert.match(restoredState.store, /current-schema-demo/u);
    assert.equal(restoredState.journalVisible, true, "the active Journal view must survive a server restart");
    const restartedCaseText = await evaluate(client, openCaseAndReadUnresolvedExpression);
    assert.match(restartedCaseText, /현재 미해결|Currently unresolved/u);
    assert.match(restartedCaseText, /Unresolved message evidence/u);
    assert.match(await evaluate(client, closeStoreAndReadToastExpression), /저장소를 먼저 열어|Open a Store first/u);
    const syntheticTabs = await evaluate(client, loadSyntheticDemoTwiceExpression);
    assert.equal(syntheticTabs.length, 2, "double-clicking the demo action must open each synthetic snapshot once");
    const directMessagePage = await evaluate(client, verifyDirectMessagePageExpression);
    assert.match(directMessagePage.second, /26–41/u, "the Go action must jump directly to message page 2");
    assert.match(directMessagePage.first, /1–25/u, "pressing Enter must return directly to message page 1");
    assert.deepEqual(await evaluate(client, traceComparisonOnlyMessageExpression), { targetId: "ID:SYNTHETIC:ADVISORY:0001", allScope: true });
    const pinnedTrace = await evaluate(client, pinTraceEvidenceInOwningStoreExpression);
    assert.match(pinnedTrace.storeName, /synthetic-advisory-investigation/u);
    assert.equal(pinnedTrace.semanticKey, "message:ID:SYNTHETIC:ADVISORY:0001");
    assert.match(await evaluate(client, rejectInvalidExportTraceExpression), /정확한 JMSMessageID|exact JMSMessageID/u);
    const isolatedJournal = await evaluate(client, inspectJournalStoreIsolationExpression);
    assert.deepEqual(isolatedJournal, { expanded: 150, reset: 19 });
    const annotatedGuide = await evaluate(client, verifyAnnotatedGuideExpression);
    assert.equal(annotatedGuide.highlighted, true);
    assert.notEqual(annotatedGuide.firstTitle, annotatedGuide.secondTitle);
    const actionableGuides = await evaluate(client, verifyActionableGuidesExpression);
    assert.equal(actionableGuides.length, 5, "five workflow-specific guides must highlight their real controls");
    const tutorial = await evaluate(client, verifySyntheticTutorialExpression);
    assert.equal(tutorial.video, true);
    assert.equal(tutorial.captions, true);
    assert.equal(tutorial.views.length, 6);
    assert.equal(new Set(tutorial.views).size, 6, "the tutorial must move through six distinct investigation views");

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
    const browserDiagnostics = browserOutput();
    if (browserDiagnostics && !testError.message.includes("browser output:")) {
      testError.message += `\nbrowser output:\n${browserDiagnostics}`;
    }
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
      "restored same-Store semantic reference rendered as unresolved",
      "case evidence picker pinned a selected observation",
      "case creation and deletion persisted to IndexedDB",
      "journal references loaded 50 initially and continued to 150 on request",
      "first-time workspace started in English",
      "selected Korean locale survived an application server restart",
      "cached Store, active Journal view, and unresolved case survived an application server restart on the same origin",
      "navigation without a Store displayed an explanatory toast",
      "double-clicking the synthetic demo opened two unique snapshots without a duplicate race",
      "message pagination jumped 1→2 with Go and 2→1 with Enter",
      "Snapshot Compare opened a B-only Message ID in an all-Store trace",
      "a trace occurrence opened its owning Store case, preserved the selection, and pinned one semantic reference",
      "Evidence Export blocked an invalid non-empty Message ID with a visible error",
      "Journal selection and progressive reference count reset between Store tabs",
      "the screen guide annotated and advanced across actual UI elements",
      "message loading, journal references, case selection, trace scope, and export trace guides highlighted their actual controls",
      "the localized video tutorial drove six distinct views over the synthetic incident data",
      "application rendered without browser errors",
    ],
    cleanup,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
