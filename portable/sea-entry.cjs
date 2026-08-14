"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Node SEA injected mains are CommonJS. */

const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createReadStream } = require("node:fs");
const { mkdir, readFile, rename, rm, stat, writeFile } = require("node:fs/promises");
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

function targetFor(root, relativePath) {
  const target = path.resolve(root, ...relativePath.split("/"));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe packaged path: ${relativePath}`);
  return target;
}

async function validateExtracted(root, manifest, manifestHash) {
  try {
    if ((await readFile(path.join(root, ".manifest-sha256"), "utf8")).trim() !== manifestHash) return false;
    for (const file of manifest.files) {
      if (digest(await readFile(targetFor(root, file.path))) !== file.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function extractApplication() {
  const manifestBytes = assetBuffer("app-manifest.json");
  const manifestHash = digest(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const root = path.join(cacheBase(), `${manifest.version}-${manifestHash.slice(0, 16)}`);
  if (await validateExtracted(root, manifest, manifestHash)) return { root, manifest };

  await mkdir(path.dirname(root), { recursive: true });
  const temporary = `${root}.${process.pid}.${Date.now()}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    for (const file of manifest.files) {
      const target = targetFor(temporary, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      const bytes = assetBuffer(`app/${file.path}`);
      if (digest(bytes) !== file.sha256) throw new Error(`Packaged asset checksum mismatch: ${file.path}`);
      await writeFile(target, bytes, { flag: "wx" });
    }
    await writeFile(path.join(temporary, ".manifest-sha256"), `${manifestHash}\n`, { flag: "wx" });
    if (await stat(root).then(() => true, () => false)) await rm(root, { recursive: true, force: true });
    await rename(temporary, root);
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

async function startServer(root, port) {
  const clientRoot = path.join(root, "dist", "client");
  const serverEntry = path.join(root, "dist", "server", "index.js");
  const moduleUrl = pathToFileURL(serverEntry);
  moduleUrl.searchParams.set("sea", `${process.pid}-${Date.now()}`);
  const { default: handleRequest } = await import(moduleUrl.href);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
        response.end("Method not allowed\n");
        return;
      }
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (await tryServeStatic(clientRoot, request, response, url.pathname)) return;
      const webRequest = new Request(`http://127.0.0.1${url.pathname}${url.search}`, {
        method: request.method,
        headers: requestHeaders(request),
      });
      await writeWebResponse(await handleRequest(webRequest), response, request.method === "HEAD");
    } catch (error) {
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

  const { server, url } = await startServer(root, options.port);
  process.stdout.write(`MQ Watcher\nLocal read-only ActiveMQ Classic store evidence explorer\n\nListening on:\n${url}\n`);
  if (options.open) openBrowser(url);
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error) => {
  process.stderr.write(`MQ Watcher: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
