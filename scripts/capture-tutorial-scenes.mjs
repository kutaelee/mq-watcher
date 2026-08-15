import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "work", "tutorial-video-v2", "captures");
const screenshotRoot = path.join(repositoryRoot, "docs", "screenshots");
const temporaryPrefix = "mq-watcher-tutorial-capture-";
const requestedLocale = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : "both";
const guideOnly = process.argv.includes("--guide-only");
if (!["en", "ko", "both"].includes(requestedLocale)) {
  throw new Error("--only must be en, ko, or both");
}
const sceneNames = [
  "01-overview",
  "02-snapshot-compare",
  "03-journal-retention",
  "04-message-trace",
  "05-incident-case",
  "06-evidence-export",
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
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

async function findBrowserExecutable() {
  const configured = process.env.MQ_WATCHER_E2E_BROWSER;
  const candidates = configured
    ? [configured]
    : process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && await pathExists(candidate)) return candidate;
    if (!path.isAbsolute(candidate)) {
      const lookup = spawnSync("which", [candidate], { encoding: "utf8", windowsHide: true });
      if (lookup.status === 0 && lookup.stdout.trim()) return lookup.stdout.trim();
    }
  }
  throw new Error("Chrome or Edge was not found. Set MQ_WATCHER_E2E_BROWSER to its executable path.");
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

async function waitForHttp(url, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Application server exited early:\n${output()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Keep polling the task-owned loopback listener.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}:\n${output()}`);
}

async function waitForPageTarget(port, child, output) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      const targets = response.ok ? await response.json() : [];
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome may still be starting.
    }
    if (child.exitCode !== null) throw new Error(`Browser exited early:\n${output()}`);
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Chrome DevTools:\n${output()}`);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Chrome DevTools WebSocket failed to open")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeout = 10_000) {
    return new Promise((resolve, reject) => {
      const listener = (params) => {
        clearTimeout(timer);
        this.listeners.get(method)?.delete(listener);
        resolve(params);
      };
      const timer = setTimeout(() => {
        this.listeners.get(method)?.delete(listener);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      const listeners = this.listeners.get(method) ?? new Set();
      listeners.add(listener);
      this.listeners.set(method, listeners);
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}

async function navigate(client, url) {
  const loaded = client.waitFor("Page.loadEventFired");
  const result = await client.send("Page.navigate", { url });
  assert.equal(result.errorText, undefined);
  await loaded;
}

async function waitForExpression(client, expression, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for browser expression: ${expression}`);
}

async function clickPointer(client, selector) {
  const point = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  })()`);
  assert.ok(point, `click target is unavailable: ${selector}`);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function terminateOwnedProcess(child) {
  if (!child || child.exitCode !== null) return true;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(5_000).then(() => false),
  ]);
  if (exited) return true;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
  }
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(5_000).then(() => false),
  ]);
}

async function captureLocale({ locale, origin, browserExecutable, temporaryRoot }) {
  const debugPort = await reserveLoopbackPort();
  const profile = path.join(temporaryRoot, `profile-${locale}`);
  const cache = path.join(temporaryRoot, `cache-${locale}`);
  const args = [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--disk-cache-dir=${cache}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-extensions",
    "--disable-sync",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=2560,1440",
    "about:blank",
  ];
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
  const browser = spawn(browserExecutable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const output = captureOutput(browser);
  let client;
  try {
    client = new CdpClient(await waitForPageTarget(debugPort, browser, output));
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 2560,
      height: 1440,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate(client, `${origin}/`);
    await waitForExpression(client, "document.body && document.body.innerText.length > 100");
    if (locale === "ko") {
      await evaluate(client, "localStorage.setItem('mq-watcher-locale', 'ko')");
      const loaded = client.waitFor("Page.loadEventFired");
      await client.send("Page.reload", { ignoreCache: true });
      await loaded;
      await waitForExpression(client, "document.documentElement.lang === 'ko'");
    }

    await waitForExpression(client, "Boolean(document.querySelector('.tutorial-button:not(:disabled)'))");
    await evaluate(client, "document.querySelector('.tutorial-button')?.click()");
    await waitForExpression(client, "Boolean(document.querySelector('.tutorial-preview video'))");
    await evaluate(client, "(document.querySelector('.dialog-actions .button-primary') ?? document.querySelector('.dialog-actions button:last-child'))?.click()");
    await waitForExpression(client, "Boolean(document.querySelector('.screen-tour-callout'))");
    const outputDirectory = path.join(outputRoot, locale);
    await mkdir(outputDirectory, { recursive: true });

    for (let index = 0; !guideOnly && index < sceneNames.length; index += 1) {
      await waitForExpression(client, `document.querySelectorAll('.screen-tour-progress i')[${index}]?.classList.contains('active') === true`);
      await evaluate(client, "window.scrollTo(0, 0)");
      await sleep(350);
      const activeView = await evaluate(client, "document.querySelector('.nav-item.active')?.textContent?.trim() ?? ''");
      const title = await evaluate(client, "document.querySelector('.screen-tour-callout h2')?.textContent?.trim() ?? ''");
      assert.ok(activeView && title, `tutorial scene ${index + 1} is missing its live UI annotation`);
      await evaluate(client, `(() => {
        const shade = document.querySelector('.screen-tour-shade');
        const callout = document.querySelector('.screen-tour-callout');
        if (shade instanceof HTMLElement) {
          shade.style.background = 'transparent';
          shade.style.pointerEvents = 'none';
        }
        if (callout instanceof HTMLElement) callout.style.display = 'none';
      })()`);
      await sleep(120);
      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      await evaluate(client, `(() => {
        const shade = document.querySelector('.screen-tour-shade');
        const callout = document.querySelector('.screen-tour-callout');
        if (shade instanceof HTMLElement) {
          shade.style.removeProperty('background');
          shade.style.removeProperty('pointer-events');
        }
        if (callout instanceof HTMLElement) callout.style.removeProperty('display');
      })()`);
      const target = path.join(outputDirectory, `${sceneNames[index]}.png`);
      await writeFile(target, Buffer.from(screenshot.data, "base64"));
      process.stdout.write(`${locale} ${index + 1}: ${activeView} — ${title}\n`);
      if (index < sceneNames.length - 1) {
        await evaluate(client, "document.querySelector('.screen-tour-actions .primary')?.click()");
        await sleep(750);
        const advanced = await evaluate(client, `({
          title: document.querySelector('.screen-tour-callout h2')?.textContent?.trim() ?? '',
          progress: Array.from(document.querySelectorAll('.screen-tour-progress i')).findIndex((item) => item.classList.contains('active')),
        })`);
        assert.equal(advanced.progress, index + 1, `tutorial did not advance after scene ${index + 1}: ${JSON.stringify(advanced)}`);
      }
    }

    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitForExpression(client, "!document.querySelector('.screen-tour-callout')");
    await sleep(300);
    const reloaded = client.waitFor("Page.loadEventFired");
    await client.send("Page.reload", { ignoreCache: true });
    await reloaded;
    await waitForExpression(client, "Boolean(document.querySelector('.source-name'))");
    const messageNavigationLabel = locale === "ko" ? "메시지" : "Messages";
    const messageNavigationFocused = await evaluate(client, `(() => {
      const label = ${JSON.stringify(messageNavigationLabel)};
      const navigation = Array.from(document.querySelectorAll('.nav-item')).find((button) => button.querySelector('span')?.textContent?.trim() === label);
      if (!(navigation instanceof HTMLButtonElement)) return false;
      navigation.dataset.captureClick = 'message-navigation';
      return true;
    })()`);
    assert.equal(messageNavigationFocused, true, `message navigation is unavailable: ${messageNavigationLabel}`);
    await clickPointer(client, "[data-capture-click='message-navigation']");
    await waitForExpression(client, `document.querySelector('.nav-item.active span')?.textContent?.trim() === ${JSON.stringify(messageNavigationLabel)}`);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await clickPointer(client, ".view-guide-button");
    await waitForExpression(client, "Boolean(document.querySelector('.screen-tour-callout'))");
    for (let index = 0; index < 5; index += 1) {
      await evaluate(client, "document.querySelector('.screen-tour-actions .primary')?.click()");
      await sleep(420);
    }
    const expectedGuideTitle = locale === "ko" ? "최초 2,500건 이후 계속 불러오기" : "Continue beyond the first 2,500 candidates";
    await waitForExpression(client, `document.querySelector('.screen-tour-callout h2')?.textContent?.trim() === ${JSON.stringify(expectedGuideTitle)}`);
    await sleep(500);
    const guideScreenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const guideDirectory = path.join(screenshotRoot, locale);
    await mkdir(guideDirectory, { recursive: true });
    await writeFile(path.join(guideDirectory, "view-guide.png"), Buffer.from(guideScreenshot.data, "base64"));
    process.stdout.write(`${locale} guide: ${expectedGuideTitle}\n`);
  } finally {
    if (client) {
      try { await Promise.race([client.send("Browser.close"), sleep(1_000)]); } catch { /* cleanup remains authoritative */ }
      client.close();
    }
    assert.equal(await terminateOwnedProcess(browser), true, `browser PID ${browser.pid} must stop`);
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), temporaryPrefix));
  const browserExecutable = await findBrowserExecutable();
  const serverPort = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${serverPort}`;
  const vinextCli = path.join(repositoryRoot, "node_modules", "vinext", "dist", "cli.js");
  const server = spawn(process.execPath, [vinextCli, "start", "--port", String(serverPort), "--hostname", "127.0.0.1"], {
    cwd: repositoryRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const serverOutput = captureOutput(server);
  try {
    await waitForHttp(`${origin}/favicon.svg`, server, serverOutput);
    for (const locale of ["en", "ko"].filter((value) => requestedLocale === "both" || requestedLocale === value)) {
      await captureLocale({ locale, origin, browserExecutable, temporaryRoot });
    }
  } finally {
    assert.equal(await terminateOwnedProcess(server), true, `server PID ${server.pid} must stop`);
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    assert.equal(resolvedTemporaryRoot.startsWith(`${path.resolve(tmpdir())}${path.sep}`), true);
    assert.equal(path.basename(resolvedTemporaryRoot).startsWith(temporaryPrefix), true);
    await rm(resolvedTemporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

await main();
