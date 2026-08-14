import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authorizeInstallRequest,
  checkForUpdate,
  compareSemver,
  launchPortableReplacement,
  RELEASE_API_URL,
  stagePortableUpdate,
} from "../app/lib/updater.mjs";

const tag = "v1.2.0";
const executableName = "mq-watcher.exe";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function releaseMetadata(binary, overrides = {}) {
  const digest = sha256(binary);
  const checksumText = `${digest} *${executableName}\n`;
  return {
    tag_name: tag,
    html_url: `https://github.com/kutaelee/mq-watcher/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    published_at: "2026-08-14T00:00:00Z",
    assets: [
      {
        name: executableName,
        browser_download_url: `https://github.com/kutaelee/mq-watcher/releases/download/${tag}/${executableName}`,
        size: binary.length,
        digest: `sha256:${digest}`,
      },
      {
        name: "SHA256SUMS.txt",
        browser_download_url: `https://github.com/kutaelee/mq-watcher/releases/download/${tag}/SHA256SUMS.txt`,
        size: Buffer.byteLength(checksumText),
        digest: null,
      },
    ],
    ...overrides,
  };
}

function responseAt(url, body, init) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: String(url) });
  return response;
}

function commandFile(version, markerName) {
  return [
    "@echo off",
    "if \"%~1\"==\"--version\" (",
    `  echo ${version}`,
    "  exit /b 0",
    ")",
    `> "%~dp0${markerName}" echo restarted`,
    "exit /b 0",
    "",
  ].join("\r\n");
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for replacement helper evidence");
}

function metadataFetch(metadata, calls) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    assert.equal(String(url), RELEASE_API_URL);
    return Response.json(metadata);
  };
}

async function portableCheck(binary, fetchImpl) {
  return checkForUpdate({
    currentVersion: "1.1.0",
    mode: "portable",
    platform: "win32",
    arch: "x64",
    fetchImpl,
  });
}

test("strict semver comparison blocks prerelease promotion and downgrade candidates", async () => {
  assert.equal(compareSemver("1.2.0", "1.1.9"), 1);
  assert.equal(compareSemver("1.2.0-beta.2", "1.2.0-beta.11"), -1);
  assert.equal(compareSemver("v1.2.0+build.4", "1.2.0"), 0);

  const calls = [];
  const prerelease = await checkForUpdate({
    currentVersion: "1.1.0",
    mode: "portable",
    fetchImpl: metadataFetch(releaseMetadata(Buffer.from("binary"), { tag_name: "v1.2.0-rc.1", html_url: "https://github.com/kutaelee/mq-watcher/releases/tag/v1.2.0-rc.1", prerelease: true }), calls),
  });
  assert.equal(prerelease.status, "blocked-prerelease");
  assert.equal(prerelease.canInstall, false);

  const downgrade = await checkForUpdate({
    currentVersion: "2.0.0",
    mode: "portable",
    fetchImpl: metadataFetch(releaseMetadata(Buffer.from("binary")), []),
  });
  assert.equal(downgrade.status, "blocked-downgrade");
  assert.equal(downgrade.canInstall, false);
});

test("metadata check contacts only the fixed official endpoint and downloads zero assets before the button action", async () => {
  const calls = [];
  const update = await checkForUpdate({
    currentVersion: "1.1.0",
    mode: "npm",
    fetchImpl: metadataFetch(releaseMetadata(Buffer.from("portable")), calls),
  });

  assert.equal(update.status, "update-available");
  assert.equal(update.canInstall, false);
  assert.equal(update.reason, "manual-distribution");
  assert.equal(update.releaseUrl, `https://github.com/kutaelee/mq-watcher/releases/tag/${tag}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RELEASE_API_URL);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers["X-GitHub-Api-Version"], "2022-11-28");
});

test("install authorization requires the instance token and same-origin browser metadata", () => {
  const token = "instance-token-for-test";
  const request = (headers) => new Request("http://127.0.0.1:3210/api/update", { headers });
  assert.equal(authorizeInstallRequest(request({
    Origin: "http://127.0.0.1:3210",
    "Sec-Fetch-Site": "same-origin",
    "X-MQ-Watcher-Install-Token": token,
  }), token), true);
  assert.equal(authorizeInstallRequest(request({ Origin: "http://127.0.0.1:3210", "Sec-Fetch-Site": "same-origin" }), token), false);
  assert.equal(authorizeInstallRequest(request({ Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "X-MQ-Watcher-Install-Token": token }), token), false);
  assert.equal(authorizeInstallRequest(request({ "X-MQ-Watcher-Install-Token": token }), token), false);
});

test("final redirect to an untrusted host is rejected and leaves no staging files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-updater-redirect-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, executableName);
  const oldBinary = Buffer.from("old executable");
  const newBinary = Buffer.from("new executable");
  await writeFile(current, oldBinary);
  const update = await portableCheck(newBinary, metadataFetch(releaseMetadata(newBinary), []));

  await assert.rejects(stagePortableUpdate({
    update,
    currentExecutable: current,
    randomBytesImpl: () => Buffer.from("1111222233334444", "hex"),
    fetchImpl: async (url) => responseAt("https://evil.example/redirect-target", String(url).endsWith("/SHA256SUMS.txt")
      ? `${sha256(newBinary)} *${executableName}\n`
      : newBinary),
  }), (error) => error?.code === "untrusted-redirect");
  assert.deepEqual(await readFile(current), oldBinary);
  assert.deepEqual(await readdir(root), [executableName]);
});

test("zero release metadata size rejects a non-empty portable response", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-updater-zero-size-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, executableName);
  const oldBinary = Buffer.from("old executable");
  const newBinary = Buffer.from("non-empty release executable");
  await writeFile(current, oldBinary);
  const metadata = releaseMetadata(newBinary);
  metadata.assets[0].size = 0;
  const update = await portableCheck(newBinary, metadataFetch(metadata, []));

  await assert.rejects(stagePortableUpdate({
    update,
    currentExecutable: current,
    randomBytesImpl: () => Buffer.from("5555666677778888", "hex"),
    fetchImpl: async (url) => responseAt(url, String(url).endsWith("/SHA256SUMS.txt")
      ? `${sha256(newBinary)} *${executableName}\n`
      : newBinary),
  }), (error) => error?.code === "download-size-mismatch" || error?.code === "download-too-large");
  assert.deepEqual(await readFile(current), oldBinary);
  assert.deepEqual(await readdir(root), [executableName]);
});

test("portable staging verifies SHA256SUMS.txt and GitHub digest without changing the running binary", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-updater-success-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, executableName);
  const oldBinary = Buffer.from("old executable");
  const newBinary = Buffer.from("new verified executable");
  await writeFile(current, oldBinary);
  const metadata = releaseMetadata(newBinary);
  const update = await portableCheck(newBinary, metadataFetch(metadata, []));
  const expected = sha256(newBinary);
  const downloads = [];
  const staged = await stagePortableUpdate({
    update,
    currentExecutable: current,
    randomBytesImpl: () => Buffer.from("0011223344556677", "hex"),
    fetchImpl: async (url) => {
      downloads.push(String(url));
      if (String(url).endsWith("/SHA256SUMS.txt")) {
        const body = `${expected} *${executableName}\n`;
        return responseAt(url, body, { headers: { "content-length": String(Buffer.byteLength(body)) } });
      }
      return responseAt("https://release-assets.githubusercontent.com/github-production-release-asset/12345?token=test", newBinary, { headers: { "content-length": String(newBinary.length) } });
    },
  });

  assert.deepEqual(await readFile(current), oldBinary);
  assert.deepEqual(await readFile(staged.stagedPath), newBinary);
  assert.equal(staged.expectedSha256, expected);
  assert.equal(downloads.length, 2);
});

test("hash mismatch leaves the current binary unchanged and removes partial staging files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-updater-mismatch-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, executableName);
  const oldBinary = Buffer.from("known current executable");
  const expectedBinary = Buffer.from("expected release executable");
  const tamperedBinary = Buffer.from(expectedBinary);
  tamperedBinary[0] ^= 0xff;
  await writeFile(current, oldBinary);
  const update = await portableCheck(expectedBinary, metadataFetch(releaseMetadata(expectedBinary), []));
  const expected = sha256(expectedBinary);

  await assert.rejects(
    stagePortableUpdate({
      update,
      currentExecutable: current,
      randomBytesImpl: () => Buffer.from("8899aabbccddeeff", "hex"),
      fetchImpl: async (url) => String(url).endsWith("/SHA256SUMS.txt")
        ? responseAt(url, `${expected} *${executableName}\n`)
        : responseAt(url, tamperedBinary, { headers: { "content-length": String(tamperedBinary.length) } }),
    }),
    (error) => error?.code === "checksum-mismatch",
  );

  assert.deepEqual(await readFile(current), oldBinary);
  assert.deepEqual(await readdir(root), [executableName]);
});

test("cancellation and replacement-launch failure clean task-owned staged files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-updater-cleanup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, executableName);
  const oldBinary = Buffer.from("current executable");
  const newBinary = Buffer.from("next executable");
  await writeFile(current, oldBinary);
  const update = await portableCheck(newBinary, metadataFetch(releaseMetadata(newBinary), []));
  const expected = sha256(newBinary);
  const controller = new AbortController();

  await assert.rejects(
    stagePortableUpdate({
      update,
      currentExecutable: current,
      signal: controller.signal,
      randomBytesImpl: () => Buffer.from("1020304050607080", "hex"),
      fetchImpl: async (url) => {
        if (String(url).endsWith("/SHA256SUMS.txt")) return responseAt(url, `${expected} *${executableName}\n`);
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      },
    }),
    (error) => error?.name === "AbortError",
  );
  assert.deepEqual(await readdir(root), [executableName]);

  const stagedPath = path.join(root, ".mq-watcher.exe.update-1.2.0-test.staged");
  await writeFile(stagedPath, newBinary);
  const child = new EventEmitter();
  child.unref = () => undefined;
  const spawnImpl = () => {
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    return child;
  };
  await assert.rejects(
    launchPortableReplacement({
      stagedPath,
      currentExecutable: current,
      expectedSha256: expected,
      version: "1.2.0",
      platform: "win32",
      spawnImpl,
      scheduleExit: () => assert.fail("exit must not be scheduled after a launch failure"),
    }),
    /spawn failed/,
  );
  assert.deepEqual(await readFile(current), oldBinary);
  assert.deepEqual(await readdir(root), [executableName]);
});

test("pre-spawn staged checksum failure removes the staged file", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-updater-pre-spawn-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, executableName);
  const stagedPath = path.join(root, ".mq-watcher.exe.update-1.2.0-pre-spawn.staged");
  await writeFile(current, "current executable");
  await writeFile(stagedPath, "changed after verification");
  await assert.rejects(launchPortableReplacement({
    stagedPath,
    currentExecutable: current,
    expectedSha256: sha256(Buffer.from("original verified bytes")),
    version: "1.2.0",
    platform: "win32",
    spawnImpl: () => assert.fail("PowerShell must not start after a pre-spawn checksum failure"),
  }), (error) => error?.code === "checksum-mismatch");
  assert.deepEqual(await readdir(root), [executableName]);
});

test("generated replacement helper smoke-checks the new version and rolls back before restart", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-updater-helper-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, executableName);
  const stagedPath = path.join(root, ".mq-watcher.exe.update-1.2.0-test.staged");
  const oldBinary = Buffer.from("current executable");
  const newBinary = Buffer.from("verified replacement executable");
  await writeFile(current, oldBinary);
  await writeFile(stagedPath, newBinary);
  const expected = sha256(newBinary);
  const child = new EventEmitter();
  child.unref = () => undefined;
  let scheduled = false;
  const spawnImpl = () => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };

  await launchPortableReplacement({
    stagedPath,
    currentExecutable: current,
    expectedSha256: expected,
    version: "1.2.0",
    platform: "win32",
    spawnImpl,
    scheduleExit: () => { scheduled = true; },
  });

  const helperName = (await readdir(root)).find((name) => name.endsWith(".ps1"));
  assert.ok(helperName);
  const helper = await readFile(path.join(root, helperName), "utf8");
  assert.match(helper, /& \$target --version/);
  assert.match(helper, /\$reportedVersion\.Trim\(\) -ne \$expectedVersion/);
  assert.match(helper, /\[System\.IO\.File\]::Replace\(\$backup, \$target, \$failed, \$true\)/);
  assert.match(helper, /\$rolledBack -or \(-not \$replaced/);
  assert.match(helper, /Remove-Item -LiteralPath \$staged -Force/);
  assert.ok(helper.indexOf("try {") < helper.indexOf("Staged update checksum mismatch"));
  assert.ok(helper.indexOf("$reportedVersion") < helper.indexOf("Start-Process -FilePath $target"));
  assert.equal(scheduled, true);
  assert.deepEqual(await readFile(current), oldBinary);
});

test("real Windows helper replaces, version-checks, restarts, and cleans a command fixture", { skip: process.platform !== "win32" }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-updater-real-success-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, "mq-watcher.cmd");
  const stagedPath = path.join(root, ".mq-watcher.cmd.update-1.2.0-real.staged");
  const oldScript = commandFile("1.1.0", "old-restart.marker");
  const newScript = commandFile("1.2.0", "new-restart.marker");
  await writeFile(current, oldScript);
  await writeFile(stagedPath, newScript);
  const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true, stdio: "ignore" });
  let helper;
  let helperDone;
  try {
    const spawnImpl = (command, args) => {
      helper = spawn(command, args, { windowsHide: true, stdio: "ignore" });
      helperDone = new Promise((resolve) => helper.once("exit", resolve));
      return helper;
    };
    await launchPortableReplacement({
      stagedPath,
      currentExecutable: current,
      expectedSha256: sha256(Buffer.from(newScript)),
      version: "1.2.0",
      platform: "win32",
      processId: dummy.pid,
      spawnImpl,
      scheduleExit: () => undefined,
    });
    helper.ref();
    dummy.kill();
    await helperDone;
    await waitFor(async () => (await readdir(root)).includes("new-restart.marker"));
    assert.equal(helper.exitCode, 0);
    assert.equal(await readFile(current, "utf8"), newScript);
    assert.deepEqual((await readdir(root)).sort(), ["mq-watcher.cmd", "new-restart.marker"]);
  } finally {
    if (dummy.exitCode === null) dummy.kill();
    if (helper?.exitCode === null) helper.kill();
  }
});

test("real Windows helper rolls back a wrong version, restarts the old command, and cleans residue", { skip: process.platform !== "win32" }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-updater-real-rollback-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, "mq-watcher.cmd");
  const stagedPath = path.join(root, ".mq-watcher.cmd.update-1.2.0-real.staged");
  const oldScript = commandFile("1.1.0", "old-restart.marker");
  const wrongScript = commandFile("9.9.9", "wrong-restart.marker");
  await writeFile(current, oldScript);
  await writeFile(stagedPath, wrongScript);
  const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true, stdio: "ignore" });
  let helper;
  let helperDone;
  try {
    const spawnImpl = (command, args) => {
      helper = spawn(command, args, { windowsHide: true, stdio: "ignore" });
      helperDone = new Promise((resolve) => helper.once("exit", resolve));
      return helper;
    };
    await launchPortableReplacement({
      stagedPath,
      currentExecutable: current,
      expectedSha256: sha256(Buffer.from(wrongScript)),
      version: "1.2.0",
      platform: "win32",
      processId: dummy.pid,
      spawnImpl,
      scheduleExit: () => undefined,
    });
    helper.ref();
    dummy.kill();
    await helperDone;
    await waitFor(async () => (await readdir(root)).includes("old-restart.marker"));
    assert.equal(helper.exitCode, 1);
    assert.equal(await readFile(current, "utf8"), oldScript);
    assert.deepEqual((await readdir(root)).sort(), ["mq-watcher.cmd", "old-restart.marker"]);
  } finally {
    if (dummy.exitCode === null) dummy.kill();
    if (helper?.exitCode === null) helper.kill();
  }
});

test("real Windows helper rejects post-spawn tampering, restarts the unchanged target, and cleans residue", { skip: process.platform !== "win32" }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-updater-real-tamper-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, "mq-watcher.cmd");
  const stagedPath = path.join(root, ".mq-watcher.cmd.update-1.2.0-real.staged");
  const oldScript = commandFile("1.1.0", "old-restart.marker");
  const verifiedScript = commandFile("1.2.0", "new-restart.marker");
  await writeFile(current, oldScript);
  await writeFile(stagedPath, verifiedScript);
  const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true, stdio: "ignore" });
  let helper;
  let helperDone;
  try {
    const spawnImpl = (command, args) => {
      helper = spawn(command, args, { windowsHide: true, stdio: "ignore" });
      helperDone = new Promise((resolve) => helper.once("exit", resolve));
      return helper;
    };
    await launchPortableReplacement({
      stagedPath,
      currentExecutable: current,
      expectedSha256: sha256(Buffer.from(verifiedScript)),
      version: "1.2.0",
      platform: "win32",
      processId: dummy.pid,
      spawnImpl,
      scheduleExit: () => undefined,
    });
    helper.ref();
    await writeFile(stagedPath, "tampered after helper spawn");
    dummy.kill();
    await helperDone;
    await waitFor(async () => (await readdir(root)).includes("old-restart.marker"));
    assert.equal(helper.exitCode, 1);
    assert.equal(await readFile(current, "utf8"), oldScript);
    assert.deepEqual((await readdir(root)).sort(), ["mq-watcher.cmd", "old-restart.marker"]);
  } finally {
    if (dummy.exitCode === null) dummy.kill();
    if (helper?.exitCode === null) helper.kill();
  }
});
