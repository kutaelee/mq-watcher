import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultExecutable = path.join(repositoryRoot, "outputs", process.platform === "win32" ? "mq-watcher.exe" : "mq-watcher");
const executable = path.resolve(process.argv[2] || defaultExecutable);
const previousExecutable = process.argv[3] ? path.resolve(process.argv[3]) : null;
const taskChildren = new Set();

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (!await waitForExit(child, 5_000)) {
    child.kill("SIGKILL");
    if (!await waitForExit(child, 5_000)) throw new Error(`Portable process did not exit: ${child.pid}`);
  }
}

function spawnOwned(command, args, environment) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  taskChildren.add(child);
  child.once("exit", () => taskChildren.delete(child));
  return child;
}

async function runCommand(command, args, environment, timeoutMs = 60_000) {
  const child = spawnOwned(command, args, environment);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = await waitForExit(child, timeoutMs);
  if (!exited) {
    await stopChild(child);
    throw new Error(`Portable command timed out: ${command} ${args.join(" ")}`);
  }
  if (child.exitCode !== 0) throw new Error(`Portable command failed (${child.exitCode})\n${stderr}`);
  return { stdout, stderr };
}

async function treeHash(root) {
  const hash = createHash("sha256");
  async function walk(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      hash.update(childRelative).update("\0");
      if (entry.isDirectory()) await walk(absolute, childRelative);
      else hash.update(await readFile(absolute));
    }
  }
  await walk(root, "");
  return hash.digest("hex");
}

function assertInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${child} is outside ${parent}`);
}

async function smokeServer(command, environment, args = ["--no-open", "--port", "0"]) {
  const child = spawnOwned(command, args, environment);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const deadline = Date.now() + 30_000;
    let url;
    while (Date.now() < deadline) {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        url = match[0];
        break;
      }
      if (child.exitCode !== null) throw new Error(`Portable executable exited early (${child.exitCode})\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!url) throw new Error(`Portable executable did not report a loopback URL\nstdout: ${stdout}\nstderr: ${stderr}`);
    const response = await fetch(url);
    const html = await response.text();
    assert.equal(response.status, 200, `Portable HTTP smoke failed: ${stderr}`);
    assert.match(html, /<title>MQ Watcher<\/title>/);
    assert.match(url, /^http:\/\/127\.0\.0\.1:/);
    return { pid: child.pid, url, status: response.status };
  } finally {
    await stopChild(child);
  }
}

const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-portable-smoke-"));
const environment = {
  ...process.env,
  LOCALAPPDATA: path.join(isolatedRoot, "LocalAppData"),
  XDG_CACHE_HOME: path.join(isolatedRoot, "xdg-cache"),
};

try {
  let previousEvidence = null;
  if (previousExecutable) {
    const previousVersion = (await runCommand(previousExecutable, ["--version"], environment)).stdout.trim();
    const previousCache = (await runCommand(previousExecutable, ["--cache-info"], environment)).stdout.trim();
    assertInside(isolatedRoot, previousCache);
    previousEvidence = { executable: previousExecutable, version: previousVersion, cache: previousCache, before: await treeHash(previousCache) };
  }

  const coldLaunches = await Promise.all([
    runCommand(executable, ["--cache-info"], environment),
    runCommand(executable, ["--cache-info"], environment),
  ]);
  const cachePaths = coldLaunches.map((result) => result.stdout.trim());
  assert.equal(new Set(cachePaths).size, 1);
  const cache = cachePaths[0];
  assertInside(isolatedRoot, cache);
  const version = (await runCommand(executable, ["--version"], environment)).stdout.trim();
  const currentBefore = await treeHash(cache);

  if (previousEvidence) {
    assert.notEqual(version, previousEvidence.version, "Previous and current portable versions must differ");
    assert.notEqual(cache, previousEvidence.cache);
    assert.equal(await treeHash(previousEvidence.cache), previousEvidence.before);
    const downgradeCache = (await runCommand(previousExecutable, ["--cache-info"], environment)).stdout.trim();
    assert.equal(downgradeCache, previousEvidence.cache);
    assert.equal(await treeHash(previousEvidence.cache), previousEvidence.before);
    assert.equal(await treeHash(cache), currentBefore);
  }

  const marker = path.join(cache, ".manifest-sha256");
  const expectedMarker = await readFile(marker, "utf8");
  await writeFile(marker, "mismatched-manifest\n");
  assert.equal((await runCommand(executable, ["--cache-info"], environment)).stdout.trim(), cache);
  assert.equal(await readFile(marker, "utf8"), expectedMarker);

  const packageFile = path.join(cache, "package.json");
  const expectedPackage = await readFile(packageFile);
  await writeFile(packageFile, "corrupt-version-and-content\n");
  await runCommand(executable, ["--cache-info"], environment);
  assert.deepEqual(await readFile(packageFile), expectedPackage);

  const extraFile = path.join(cache, "dist", "client", "unmanifested-smoke.html");
  await mkdir(path.dirname(extraFile), { recursive: true });
  await writeFile(extraFile, "not in manifest\n");
  await runCommand(executable, ["--cache-info"], environment);
  assert.equal(existsSync(extraFile), false);

  const server = await smokeServer(executable, environment);
  const stableFirst = await smokeServer(executable, environment, ["--no-open"]);
  const stableSecond = await smokeServer(executable, environment, ["--no-open"]);
  assert.equal(stableFirst.url, "http://127.0.0.1:38921");
  assert.equal(stableSecond.url, stableFirst.url, "Portable restarts must preserve the browser origin");
  const cacheEntries = await readdir(path.dirname(cache));
  assert.equal(cacheEntries.some((entry) => /\.(tmp|lock|invalid|stale)$/.test(entry)), false);
  process.stdout.write(`${JSON.stringify({
    executable,
    version,
    isolatedRoot,
    cache,
    concurrentColdLaunches: 2,
    markerSelfHeal: true,
    assetSelfHeal: true,
    extraFileSelfHeal: true,
    stableOriginRestart: {
      first: stableFirst.url,
      second: stableSecond.url,
    },
    upgradeDowngrade: previousEvidence ? {
      previousVersion: previousEvidence.version,
      previousCache: previousEvidence.cache,
      oldTreeUnchanged: true,
      newTreeUnchanged: true,
    } : "covered by synthetic portable-cache regression",
    server,
  }, null, 2)}\n`);
} finally {
  for (const child of [...taskChildren]) await stopChild(child);
  await rm(isolatedRoot, { recursive: true, force: true });
}
