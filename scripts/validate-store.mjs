import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { scanDirectory } from "../public/store-scanner.worker.js";

const target = path.resolve(process.argv[2] || ".");
const targetStat = await stat(target);
if (!targetStat.isDirectory()) throw new Error(`Not a directory: ${target}`);

class ReadOnlyPathFile {
  constructor(absolutePath, metadata) {
    this.absolutePath = absolutePath;
    this.name = path.basename(absolutePath);
    this.size = metadata.size;
    this.lastModified = metadata.mtimeMs;
  }

  slice(start, end) {
    const source = this.absolutePath;
    const length = Math.max(0, end - start);
    return {
      async arrayBuffer() {
        const handle = await open(source, "r");
        try {
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, start);
          const exact = buffer.subarray(0, bytesRead);
          return exact.buffer.slice(exact.byteOffset, exact.byteOffset + exact.byteLength);
        } finally {
          await handle.close();
        }
      },
    };
  }
}

async function inventory(root) {
  const output = [];
  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, relativePath);
      if (entry.isFile()) {
        const metadata = await stat(absolute);
        output.push({
          absolute,
          relativePath,
          file: new ReadOnlyPathFile(absolute, metadata),
        });
      }
    }
  }
  await walk(root, "");
  return output;
}

async function hashManifest(entries) {
  const aggregate = createHash("sha256");
  for (const entry of entries) {
    aggregate.update(entry.relativePath, "utf8");
    await new Promise((resolve, reject) => {
      const stream = createReadStream(entry.absolute);
      stream.on("data", (chunk) => aggregate.update(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  }
  return aggregate.digest("hex");
}

const files = await inventory(target);
const signatureSeed = files.map((entry) => `${entry.relativePath}:${entry.file.size}:${entry.file.lastModified}`).join("|");
const signature = createHash("sha256").update(signatureSeed).digest("hex").slice(0, 16);
const before = await hashManifest(files);
const started = performance.now();
let lastReported = -1;
const result = await scanDirectory(
  {
    signature,
    directoryName: path.basename(target),
    files: files.map(({ relativePath, file }) => ({ relativePath, file })),
  },
  (message) => {
    if (message.type !== "progress" || !message.totalBytes) return;
    const percent = Math.floor((message.scannedBytes / message.totalBytes) * 100);
    if (percent >= lastReported + 10) {
      process.stderr.write(`scan ${percent}% (${message.file})\n`);
      lastReported = percent;
    }
  },
);
const elapsedMs = performance.now() - started;
const after = await hashManifest(files);

const report = {
  target,
  storeKind: result.storeKind,
  files: result.files.length,
  bytes: result.totals.bytes,
  scanSeconds: Number((elapsedMs / 1000).toFixed(2)),
  destinations: result.destinations.slice(0, 30).map((item) => ({
    type: item.type,
    name: item.name,
    occurrences: item.occurrences,
    confidence: item.confidence,
  })),
  subscriptions: result.subscriptions.slice(0, 20).map((item) => ({
    id: item.rawId,
    session: item.session,
    consumer: item.consumer,
    occurrences: item.occurrences,
    confidence: item.confidence,
  })),
  advisoryStrings: result.totals.advisoryRecords,
  messageCandidates: result.messages.length,
  printableStringsStored: result.strings.length,
  truncated: result.truncated,
  hashBefore: before,
  hashAfter: after,
  sourceUnchanged: before === after,
  warnings: result.warnings,
};

console.log(JSON.stringify(report, null, 2));
