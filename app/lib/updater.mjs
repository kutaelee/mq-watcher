import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const RELEASE_API_URL = "https://api.github.com/repos/kutaelee/mq-watcher/releases/latest";
export const RELEASE_PAGE_PREFIX = "https://github.com/kutaelee/mq-watcher/releases/tag/";
const RELEASE_DOWNLOAD_PREFIX = ["kutaelee", "mq-watcher", "releases", "download"];
const CHECKSUM_ASSET_NAME = "SHA256SUMS.txt";
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const MAX_PORTABLE_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

export class UpdaterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UpdaterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new UpdaterError(code, message);
}

export function parseSemver(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(String(value).trim());
  if (!match) fail("invalid-version", `Invalid semantic version: ${value}`);
  const prerelease = match[4] ? match[4].split(".") : [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
      fail("invalid-version", `Invalid semantic version: ${value}`);
    }
  }
  return {
    raw: String(value).trim(),
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  };
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function assertOfficialReleasePage(value, tagName) {
  const url = new URL(value);
  const expected = `/kutaelee/mq-watcher/releases/tag/${encodeURIComponent(tagName)}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expected || url.search || url.hash) {
    fail("untrusted-release", "GitHub returned an unexpected release page URL.");
  }
  return url.href;
}

function assertOfficialAsset(asset, tagName) {
  if (!asset || typeof asset.name !== "string" || path.basename(asset.name) !== asset.name) {
    fail("invalid-asset", "GitHub returned an invalid release asset name.");
  }
  const url = new URL(asset.browser_download_url);
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const expected = [...RELEASE_DOWNLOAD_PREFIX, tagName, asset.name];
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash || parts.length !== expected.length || parts.some((part, index) => part !== expected[index])) {
    fail("untrusted-asset", `Refusing non-official release asset: ${asset.name}`);
  }
  const size = Number(asset.size);
  if (!Number.isSafeInteger(size) || size < 0) fail("invalid-asset", `Invalid release asset size: ${asset.name}`);
  const digest = asset.digest == null ? null : String(asset.digest).toLowerCase();
  if (digest !== null && !/^sha256:[a-f0-9]{64}$/.test(digest)) fail("invalid-asset", `Invalid release asset digest: ${asset.name}`);
  return { name: asset.name, url: url.href, size, digest: digest?.slice(7) ?? null };
}

function portableAssetNames(platform, arch) {
  if (platform === "win32" && arch === "x64") return ["mq-watcher.exe", "mq-watcher-windows-x64.exe"];
  if (platform === "linux" && arch === "x64") return ["mq-watcher", "mq-watcher-linux-x64"];
  return [];
}

function normalizeMode(mode) {
  return mode === "portable" || mode === "npm" ? mode : "source";
}

export function createInstallToken() {
  return randomBytes(32).toString("base64url");
}

export function authorizeInstallRequest(request, expectedToken) {
  const site = request.headers.get("sec-fetch-site");
  if (site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return false;
  } catch {
    return false;
  }
  const supplied = request.headers.get("x-mq-watcher-install-token") || "";
  const expectedBytes = Buffer.from(String(expectedToken));
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length > 0 && expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

async function fetchReleaseJson(fetchImpl, signal, currentVersion) {
  const response = await fetchImpl(RELEASE_API_URL, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `mq-watcher/${currentVersion}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
    signal,
  });
  if (!response.ok) fail("release-check-failed", `GitHub release check failed with HTTP ${response.status}.`);
  return response.json();
}

export async function checkForUpdate({
  currentVersion,
  mode = "source",
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  parseSemver(currentVersion);
  const metadata = await fetchReleaseJson(fetchImpl, signal, currentVersion);
  if (!metadata || typeof metadata !== "object" || typeof metadata.tag_name !== "string" || !Array.isArray(metadata.assets)) {
    fail("invalid-release", "GitHub returned invalid release metadata.");
  }
  const latest = parseSemver(metadata.tag_name);
  const releaseUrl = assertOfficialReleasePage(metadata.html_url, metadata.tag_name);
  const normalizedMode = normalizeMode(mode);
  const comparison = compareSemver(latest.raw, currentVersion);
  const base = {
    currentVersion,
    latestVersion: latest.raw.replace(/^v/, ""),
    tagName: metadata.tag_name,
    releaseUrl,
    mode: normalizedMode,
    publishedAt: typeof metadata.published_at === "string" ? metadata.published_at : null,
  };
  if (metadata.draft) return { ...base, status: "blocked-draft", canInstall: false, release: null };
  if (metadata.prerelease || latest.prerelease.length) return { ...base, status: "blocked-prerelease", canInstall: false, release: null };
  if (comparison < 0) return { ...base, status: "blocked-downgrade", canInstall: false, release: null };
  if (comparison === 0) return { ...base, status: "up-to-date", canInstall: false, release: null };

  let portableAsset = null;
  let checksumAsset = null;
  for (const rawAsset of metadata.assets) {
    if (rawAsset?.name === CHECKSUM_ASSET_NAME) checksumAsset = assertOfficialAsset(rawAsset, metadata.tag_name);
    if (portableAssetNames(platform, arch).includes(rawAsset?.name)) portableAsset = assertOfficialAsset(rawAsset, metadata.tag_name);
  }
  const runtimeSupportsInstall = normalizedMode === "portable" && platform === "win32" && arch === "x64";
  const canInstall = runtimeSupportsInstall && Boolean(portableAsset && checksumAsset);
  return {
    ...base,
    status: "update-available",
    canInstall,
    reason: normalizedMode !== "portable"
      ? "manual-distribution"
      : runtimeSupportsInstall
        ? (canInstall ? null : "missing-direct-portable-assets")
        : "unsupported-portable-platform",
    release: canInstall ? { portableAsset, checksumAsset } : null,
  };
}

function assertOfficialDownloadResponse(response, asset) {
  if (!response.url) fail("untrusted-redirect", `${asset.name} download did not report its final URL.`);
  const url = new URL(response.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    fail("untrusted-redirect", `Refusing an untrusted final download URL for ${asset.name}.`);
  }
  if (url.hostname === "github.com") {
    if (url.href !== asset.url) fail("untrusted-redirect", `Refusing an unexpected GitHub download URL for ${asset.name}.`);
    return;
  }
  if (!DOWNLOAD_HOSTS.has(url.hostname) || url.pathname === "/") {
    fail("untrusted-redirect", `Refusing an untrusted final download host for ${asset.name}.`);
  }
}

function declaredLength(response, label) {
  const header = response.headers.get("content-length");
  if (header === null) return null;
  const value = Number(header);
  if (!Number.isSafeInteger(value) || value < 0) fail("download-size-mismatch", `${label} returned an invalid Content-Length.`);
  return value;
}

async function responseBytes(response, maxBytes, expectedBytes, label) {
  if (!response.ok) fail("download-failed", `${label} download failed with HTTP ${response.status}.`);
  const declared = declaredLength(response, label);
  if (Number.isFinite(declared) && declared > maxBytes) fail("download-too-large", `${label} is larger than allowed.`);
  if (declared !== null && declared !== expectedBytes) fail("download-size-mismatch", `${label} size did not match release metadata.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) fail("download-too-large", `${label} is larger than allowed.`);
  if (bytes.byteLength !== expectedBytes) fail("download-size-mismatch", `${label} size did not match release metadata.`);
  return bytes;
}

function checksumFor(checksumText, assetName) {
  for (const line of checksumText.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+[* ]?(.+?)\s*$/.exec(line);
    if (match && match[2] === assetName) return match[1].toLowerCase();
  }
  fail("checksum-missing", `SHA256SUMS.txt does not contain ${assetName}.`);
}

async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function assertStagingTarget(currentExecutable, candidate) {
  const executable = path.resolve(currentExecutable);
  const target = path.resolve(candidate);
  if (path.dirname(executable) !== path.dirname(target) || target === executable) {
    fail("unsafe-stage-path", "The staged update must remain beside the current executable.");
  }
  return { executable, target };
}

export async function stagePortableUpdate({
  update,
  currentExecutable,
  fetchImpl = globalThis.fetch,
  signal,
  randomBytesImpl = randomBytes,
} = {}) {
  if (!update?.canInstall || !update.release?.portableAsset || !update.release?.checksumAsset) {
    fail("install-unsupported", "This release cannot be installed automatically.");
  }
  const executable = path.resolve(currentExecutable);
  await stat(executable).then((value) => {
    if (!value.isFile()) fail("invalid-executable", "The current executable is not a file.");
  });
  const { portableAsset, checksumAsset } = update.release;
  if (portableAsset.size > MAX_PORTABLE_BYTES) fail("download-too-large", "The portable executable is larger than allowed.");
  const nonce = randomBytesImpl(8).toString("hex");
  const temporary = path.join(path.dirname(executable), `.${path.basename(executable)}.download-${process.pid}-${nonce}.tmp`);
  const staged = path.join(path.dirname(executable), `.${path.basename(executable)}.update-${update.latestVersion}-${nonce}.staged`);
  assertStagingTarget(executable, temporary);
  assertStagingTarget(executable, staged);
  let temporaryHandle;
  try {
    signal?.throwIfAborted();
    const checksumResponse = await fetchImpl(checksumAsset.url, { method: "GET", redirect: "follow", signal });
    assertOfficialDownloadResponse(checksumResponse, checksumAsset);
    const checksumBytes = await responseBytes(checksumResponse, MAX_CHECKSUM_BYTES, checksumAsset.size, CHECKSUM_ASSET_NAME);
    const expectedSha256 = checksumFor(new TextDecoder().decode(checksumBytes), portableAsset.name);
    if (portableAsset.digest && portableAsset.digest !== expectedSha256) {
      fail("checksum-conflict", "GitHub asset digest and SHA256SUMS.txt disagree.");
    }

    const binaryResponse = await fetchImpl(portableAsset.url, { method: "GET", redirect: "follow", signal });
    assertOfficialDownloadResponse(binaryResponse, portableAsset);
    if (!binaryResponse.ok || !binaryResponse.body) fail("download-failed", `Portable download failed with HTTP ${binaryResponse.status}.`);
    const declared = declaredLength(binaryResponse, portableAsset.name);
    if (Number.isFinite(declared) && declared > MAX_PORTABLE_BYTES) fail("download-too-large", "The portable executable is larger than allowed.");
    if (declared !== null && declared !== portableAsset.size) fail("download-size-mismatch", "The portable executable size did not match release metadata.");
    temporaryHandle = await open(temporary, "wx", 0o700);
    const hash = createHash("sha256");
    let received = 0;
    for await (const rawChunk of binaryResponse.body) {
      signal?.throwIfAborted();
      const chunk = Buffer.from(rawChunk);
      received += chunk.length;
      if (received > MAX_PORTABLE_BYTES || received > portableAsset.size) {
        fail("download-too-large", "The portable executable exceeded its declared size.");
      }
      hash.update(chunk);
      await temporaryHandle.write(chunk);
    }
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    if (received !== portableAsset.size) fail("download-size-mismatch", "The portable executable size did not match release metadata.");
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== expectedSha256) fail("checksum-mismatch", "The portable executable failed SHA-256 verification.");
    if (portableAsset.digest && actualSha256 !== portableAsset.digest) fail("checksum-mismatch", "The portable executable failed the GitHub asset digest check.");
    await chmod(temporary, 0o700);
    await rename(temporary, staged);
    return { stagedPath: staged, currentExecutable: executable, expectedSha256, version: update.latestVersion };
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await Promise.all([rm(temporary, { force: true }), rm(staged, { force: true })]);
    throw error;
  }
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function replacementScript({ stagedPath, currentExecutable, expectedSha256, expectedVersion, backupPath, failedPath, processId }) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${powershellLiteral(currentExecutable)}`,
    `$staged = ${powershellLiteral(stagedPath)}`,
    `$backup = ${powershellLiteral(backupPath)}`,
    `$failed = ${powershellLiteral(failedPath)}`,
    `$expected = ${powershellLiteral(expectedSha256)}`,
    `$expectedVersion = ${powershellLiteral(expectedVersion)}`,
    "$replaced = $false",
    "$rolledBack = $false",
    `while (Get-Process -Id ${processId} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }`,
    "try {",
    "  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $staged).Hash.ToLowerInvariant()",
    "  if ($actual -ne $expected) { throw 'Staged update checksum mismatch.' }",
    "  [System.IO.File]::Replace($staged, $target, $backup, $true)",
    "  $replaced = $true",
    "  $reportedVersion = (& $target --version 2>$null | Select-Object -First 1)",
    "  if ($LASTEXITCODE -ne 0 -or $reportedVersion.Trim() -ne $expectedVersion) { throw 'Replacement executable version smoke check failed.' }",
    "  Start-Process -FilePath $target",
    "  Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue",
    "} catch {",
    "  if ($replaced -and (Test-Path -LiteralPath $backup) -and (Test-Path -LiteralPath $target)) {",
    "    [System.IO.File]::Replace($backup, $target, $failed, $true)",
    "    Remove-Item -LiteralPath $failed -Force -ErrorAction SilentlyContinue",
    "    $rolledBack = $true",
    "  } elseif ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $target)) {",
    "    Move-Item -LiteralPath $backup -Destination $target",
    "    $rolledBack = $true",
    "  }",
    "  if ($rolledBack -or (-not $replaced -and (Test-Path -LiteralPath $target))) { Start-Process -FilePath $target }",
    "  throw",
    "} finally {",
    "  Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue",
    "  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue",
    "}",
    "",
  ].join("\r\n");
}

export async function launchPortableReplacement({
  stagedPath,
  currentExecutable,
  expectedSha256,
  version,
  platform = process.platform,
  processId = process.pid,
  spawnImpl = spawn,
  scheduleExit = () => {
    const timer = setTimeout(() => process.exit(0), 500);
    timer.unref();
  },
} = {}) {
  const { executable, target: staged } = assertStagingTarget(currentExecutable, stagedPath);
  let helper;
  try {
    if (platform !== "win32") fail("install-unsupported", "Automatic portable replacement is only supported on Windows.");
    if (await sha256File(staged) !== expectedSha256) fail("checksum-mismatch", "The staged executable changed after verification.");
    const nonce = randomBytes(8).toString("hex");
    helper = path.join(path.dirname(executable), `.${path.basename(executable)}.update-${version}-${nonce}.ps1`);
    const backup = path.join(path.dirname(executable), `.${path.basename(executable)}.rollback-${version}-${nonce}`);
    const failed = path.join(path.dirname(executable), `.${path.basename(executable)}.failed-${version}-${nonce}`);
    assertStagingTarget(executable, helper);
    assertStagingTarget(executable, backup);
    assertStagingTarget(executable, failed);
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await writeFile(helper, replacementScript({ stagedPath: staged, currentExecutable: executable, expectedSha256, expectedVersion: version, backupPath: backup, failedPath: failed, processId }), { flag: "wx", encoding: "utf8" });
    const child = spawnImpl(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
    scheduleExit();
    return { status: "restarting", version };
  } catch (error) {
    await Promise.all([helper ? rm(helper, { force: true }) : Promise.resolve(), rm(staged, { force: true })]);
    throw error;
  }
}

export async function installPortableUpdate(options) {
  const staged = await stagePortableUpdate(options);
  try {
    return await launchPortableReplacement({ ...staged, ...(options?.replacement || {}) });
  } catch (error) {
    await rm(staged.stagedPath, { force: true });
    throw error;
  }
}
