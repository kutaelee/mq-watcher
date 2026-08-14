#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = path.join(packageRoot, "dist", "client");
const serverEntry = path.join(packageRoot, "dist", "server", "index.js");

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
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

async function packageVersion() {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  return metadata.version;
}

function parseArguments(argv) {
  const options = { port: process.env.PORT ? parsePort(process.env.PORT) : 0, help: false, version: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--version" || argument === "-v") options.version = true;
    else if (argument === "--port" || argument === "-p") options.port = parsePort(argv[++index]);
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function helpText() {
  return [
    "MQ Watcher",
    "Local read-only forensic explorer",
    "",
    "Usage: mq-watcher [options]",
    "",
    "Options:",
    "  -p, --port <port>  Loopback port (default: choose an available port)",
    "  -v, --version      Print the package version",
    "  -h, --help         Show this help",
  ].join("\n");
}

function safeClientPath(pathname) {
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

async function tryServeStatic(request, response, pathname) {
  const candidate = safeClientPath(pathname);
  if (!candidate || candidate === clientRoot) return false;
  let metadata;
  try {
    metadata = await stat(candidate);
  } catch {
    return false;
  }
  if (!metadata.isFile()) return false;
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
  if (headOnly || !webResponse.body) {
    response.end();
    return;
  }
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

export async function startServer({ port = 0, silent = false } = {}) {
  await stat(serverEntry).catch(() => {
    throw new Error("Built application not found. Run `npm run build` before starting MQ Watcher.");
  });
  process.env.MQ_WATCHER_DISTRIBUTION_MODE = "npm";
  process.env.MQ_WATCHER_VERSION = await packageVersion();
  delete process.env.MQ_WATCHER_EXECUTABLE_PATH;
  const moduleUrl = pathToFileURL(serverEntry);
  moduleUrl.searchParams.set("cli", `${process.pid}-${Date.now()}`);
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
      if (await tryServeStatic(request, response, url.pathname)) return;
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
      if (!silent) process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the listening address.");
  const url = `http://localhost:${address.port}`;
  if (!silent) process.stdout.write(`MQ Watcher\nLocal read-only forensic explorer\n\nListening on:\n${url}\n`);
  return { server, url, host: "127.0.0.1", port: address.port };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (options.version) {
    process.stdout.write(`${await packageVersion()}\n`);
    return;
  }
  const { server } = await startServer({ port: options.port });
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) main().catch((error) => {
  process.stderr.write(`MQ Watcher: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
