"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Node SEA injected mains are CommonJS. */

const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createReadStream } = require("node:fs");
const { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const os = require("node:os");
const path = require("node:path");
const sea = require("node:sea");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { pathToFileURL } = require("node:url");

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);
const MANIFEST_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CACHE_LOCK_TIMEOUT_MS = 30_000;
const CACHE_LOCK_STALE_MS = 10 * 60_000;

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${value}`);
  return port;
}

function parseArguments(argv) {
  const options = { port: 0, open: true, help: false, version: false, cacheInfo: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--version" || argument === "-v") options.version = true;
    else if (argument === "--port" || argument === "-p") options.port = parsePort(argv[++index]);
    else if (argument === "--no-open") options.open = false;
    else if (argument === "--cache-info") options.cacheInfo = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function helpText() {
  return [
    "MQ Watcher",
    "Local read-only ActiveMQ Classic store evidence explorer",
    "",
    "Usage: mq-watcher.exe [options]",
    "",
    "Options:",
    "  -p, --port <port>  Loopback port (default: choose an available port)",
    "      --no-open       Do not open the browser automatically",
    "      --cache-info    Print the packaged application cache location",
    "  -v, --version      Print the application version",
    "  -h, --help         Show this help",
  ].join("\n");
}

function cacheBase() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "MQ Watcher", "Cache");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "mq-watcher");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assetBuffer(key) {
  return Buffer.from(sea.getRawAsset(key));
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid packaged application manifest");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported packaged application manifest schema: ${manifest.schemaVersion}`);
  }
  if (typeof manifest.version !== "string" || !SEMVER_PATTERN.test(manifest.version)) {
    throw new Error(`Invalid packaged application version: ${manifest.version}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Packaged application manifest has no files");

  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Invalid packaged file entry");
    if (typeof file.path !== "string" || file.path.length === 0) throw new Error("Packaged file path is missing");
    const hasControlCharacter = [...file.path].some((character) => character.charCodeAt(0) < 32);
    if (file.path === ".manifest-sha256" || file.path.includes("\\") || /[:*?"<>|]/.test(file.path) || hasControlCharacter) {
      throw new Error(`Unsafe packaged path: ${file.path}`);
    }
    const segments = file.path.split("/");
    if (path.posix.isAbsolute(file.path) || path.posix.normalize(file.path) !== file.path || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`Unsafe packaged path: ${file.path}`);
    }
    if (paths.has(file.path)) throw new Error(`Duplicate packaged path: ${file.path}`);
    paths.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error(`Invalid packaged file size: ${file.path}`);
    if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`Invalid packaged file checksum: ${file.path}`);
    }
  }
  return manifest;
}

function targetFor(root, relativePath) {
  const target = path.resolve(root, ...relativePath.split("/"));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe packaged path: ${relativePath}`);
  return target;
}

async function validateExtracted(root, manifest, manifestHash) {
  try {
    validateManifest(manifest);
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return false;
    if ((await readFile(path.join(root, ".manifest-sha256"), "utf8")).trim() !== manifestHash) return false;

    const expectedFiles = new Set([".manifest-sha256", ...manifest.files.map((file) => file.path)]);
    const expectedDirectories = new Set();
    for (const file of manifest.files) {
      let parent = path.posix.dirname(file.path);
      while (parent !== ".") {
        expectedDirectories.add(parent);
        parent = path.posix.dirname(parent);
      }
    }
    const observedFiles = new Set();
    const observedDirectories = new Set();
    async function walk(current, relative) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error(`Symbolic link in application cache: ${entry.name}`);
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          observedDirectories.add(childRelative);
          await walk(absolute, childRelative);
        } else if (entry.isFile()) observedFiles.add(childRelative);
        else throw new Error(`Unsupported entry in application cache: ${childRelative}`);
      }
    }
    await walk(root, "");
    if (observedFiles.size !== expectedFiles.size || observedDirectories.size !== expectedDirectories.size) return false;
    for (const filePath of observedFiles) if (!expectedFiles.has(filePath)) return false;
    for (const directoryPath of observedDirectories) if (!expectedDirectories.has(directoryPath)) return false;

    for (const file of manifest.files) {
      const target = targetFor(root, file.path);
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.size) return false;
      if (digest(await readFile(target)) !== file.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireCacheLock(lockPath) {
  const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      return async () => {
        try {
          await handle.close();
        } finally {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
      if (!error || error.code !== "EEXIST") throw error;
      const metadata = await stat(lockPath).catch(() => null);
      if (metadata && Date.now() - metadata.mtimeMs > CACHE_LOCK_STALE_MS) {
        const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
        try {
          await rename(lockPath, stalePath);
          await rm(stalePath, { force: true });
          continue;
        } catch {
          // Another process may have recovered or released the lock first.
        }
      }
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for application cache lock: ${lockPath}`);
}

function isPublishCollision(error) {
  return Boolean(error && ["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code));
}

async function publishExtracted(temporary, root, manifest, manifestHash) {
  try {
    await rename(temporary, root);
    return;
  } catch (error) {
    if (!isPublishCollision(error)) throw error;
    if (await validateExtracted(root, manifest, manifestHash)) return;
  }

  const lockPath = `${root}.lock`;
  const releaseLock = await acquireCacheLock(lockPath);
  let quarantine;
  try {
    if (await validateExtracted(root, manifest, manifestHash)) return;
    if (await stat(root).then(() => true, () => false)) {
      quarantine = `${root}.${process.pid}.${randomUUID()}.invalid`;
      await rename(root, quarantine);
    }
    try {
      await rename(temporary, root);
    } catch (error) {
      if (quarantine && !await stat(root).then(() => true, () => false)) await rename(quarantine, root).catch(() => undefined);
      throw error;
    }
    if (quarantine) await rm(quarantine, { recursive: true, force: true });
  } finally {
    await releaseLock();
  }
}

async function extractApplication({ cacheRoot = cacheBase(), readAsset = assetBuffer } = {}) {
  const manifestBytes = Buffer.from(readAsset("app-manifest.json"));
  const manifestHash = digest(manifestBytes);
  const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")));
  const resolvedCacheRoot = path.resolve(cacheRoot);
  const root = targetFor(resolvedCacheRoot, `${manifest.version}-${manifestHash.slice(0, 16)}`);
  if (await validateExtracted(root, manifest, manifestHash)) return { root, manifest };

  await mkdir(resolvedCacheRoot, { recursive: true });
  const temporary = `${root}.${process.pid}.${randomUUID()}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    for (const file of manifest.files) {
      const target = targetFor(temporary, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      const bytes = Buffer.from(readAsset(`app/${file.path}`));
      if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error(`Packaged asset checksum mismatch: ${file.path}`);
      await writeFile(target, bytes, { flag: "wx" });
    }
    await writeFile(path.join(temporary, ".manifest-sha256"), `${manifestHash}\n`, { flag: "wx" });
    if (!await validateExtracted(temporary, manifest, manifestHash)) throw new Error("Extracted application cache failed validation");
    await publishExtracted(temporary, root, manifest, manifestHash);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { root, manifest };
}

function safeClientPath(clientRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const candidate = path.resolve(clientRoot, `.${decoded}`);
  return candidate === clientRoot || candidate.startsWith(`${clientRoot}${path.sep}`) ? candidate : null;
}

async function tryServeStatic(clientRoot, request, response, pathname) {
  const candidate = safeClientPath(clientRoot, pathname);
  if (!candidate || candidate === clientRoot) return false;
  const metadata = await stat(candidate).catch(() => null);
  if (!metadata?.isFile()) return false;
  response.statusCode = 200;
  response.setHeader("Content-Type", CONTENT_TYPES.get(path.extname(candidate).toLowerCase()) || "application/octet-stream");
  response.setHeader("Content-Length", metadata.size);
  response.setHeader("Cache-Control", pathname.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache");
  if (request.method === "HEAD") response.end();
  else await pipeline(createReadStream(candidate), response);
  return true;
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

async function writeWebResponse(webResponse, response, headOnly) {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  if (headOnly || !webResponse.body) return response.end();
  await pipeline(Readable.fromWeb(webResponse.body), response);
}

async function readRequestBody(request, maxBytes = 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = process.env.ComSpec || "cmd.exe";
    args = ["/d", "/s", "/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}

async function startServer(root, port, version) {
  const clientRoot = path.join(root, "dist", "client");
  const serverEntry = path.join(root, "dist", "server", "index.js");
  process.env.MQ_WATCHER_DISTRIBUTION_MODE = "portable";
  process.env.MQ_WATCHER_VERSION = version;
  process.env.MQ_WATCHER_EXECUTABLE_PATH = process.execPath;
  const moduleUrl = pathToFileURL(serverEntry);
  moduleUrl.searchParams.set("sea", `${process.pid}-${Date.now()}`);
  const { default: handleRequest } = await import(moduleUrl.href);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const isUpdateInstall = request.method === "POST" && url.pathname === "/api/update";
      if (request.method !== "GET" && request.method !== "HEAD" && !isUpdateInstall) {
        response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
        response.end("Method not allowed\n");
        return;
      }
      if (await tryServeStatic(clientRoot, request, response, url.pathname)) return;
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      response.once("close", () => { if (!response.writableEnded) controller.abort(); });
      const init = {
        method: request.method,
        headers: requestHeaders(request),
        signal: controller.signal,
      };
      if (isUpdateInstall) {
        init.body = await readRequestBody(request);
        init.duplex = "half";
      }
      const webRequest = new Request(`http://127.0.0.1${url.pathname}${url.search}`, init);
      await writeWebResponse(await handleRequest(webRequest), response, request.method === "HEAD");
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      response.statusCode = 500;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("MQ Watcher could not render this request.\n");
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the listening address.");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { root, manifest } = await extractApplication();
  if (options.help) return process.stdout.write(`${helpText()}\n`);
  if (options.version) return process.stdout.write(`${manifest.version}\n`);
  if (options.cacheInfo) return process.stdout.write(`${root}\n`);

  const { server, url } = await startServer(root, options.port, manifest.version);
  process.stdout.write(`MQ Watcher\nLocal read-only ActiveMQ Classic store evidence explorer\n\nListening on:\n${url}\n`);
  if (options.open) openBrowser(url);
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (sea.isSea() || require.main === module) {
  main().catch((error) => {
    process.stderr.write(`MQ Watcher: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { digest, extractApplication, validateExtracted, validateManifest };
