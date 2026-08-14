import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { scanDirectory } from "../public/store-scanner.worker.js";

export class ReadOnlyPathFile {
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

export async function inventory(root) {
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

export async function hashManifest(entries) {
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

export function normalizeScanResult(result) {
  return {
    storeType: result.storeKind,
    files: result.files.map(({ path: filePath, size, kind, confidence }) => ({
      path: filePath,
      size,
      kind,
      confidence,
    })),
    destinations: result.destinations.map(
      ({ type, name, source, occurrences, confidence }) => ({
        type,
        name,
        source,
        occurrences,
        confidence,
      }),
    ),
    subscriptions: result.subscriptions.map(
      ({ rawId, type, connection, session, consumer, relatedStore, relatedDestination, occurrences, confidence }) => ({
        rawId,
        type,
        connection,
        session,
        consumer,
        relatedStore,
        relatedDestination,
        occurrences,
        confidence,
      }),
    ),
    messageCandidates: result.messages.map(
      ({ id, journal, offset, destination, detectedType, relatedId, operation, confidence }) => ({
        id,
        journal,
        offset,
        destination,
        detectedType,
        relatedId,
        operation,
        confidence,
      }),
    ),
    messageIds: Array.from(
      new Set(result.messages.map((message) => message.relatedId).filter((id) => id !== "Unknown")),
    ).sort(),
    offsets: result.messages.map((message) => ({ id: message.id, offset: message.offset })),
    totals: result.totals,
    warnings: result.warnings,
    truncated: result.truncated,
  };
}

export async function scanPath(target, emit = () => undefined) {
  const absoluteTarget = path.resolve(target);
  const targetStat = await stat(absoluteTarget);
  if (!targetStat.isDirectory()) throw new Error(`Not a directory: ${absoluteTarget}`);

  const files = await inventory(absoluteTarget);
  const signatureSeed = files
    .map((entry) => `${entry.relativePath}:${entry.file.size}:${entry.file.lastModified}`)
    .join("|");
  const signature = createHash("sha256").update(signatureSeed).digest("hex").slice(0, 16);
  const hashBefore = await hashManifest(files);
  const result = await scanDirectory(
    {
      signature,
      directoryName: path.basename(absoluteTarget),
      files: files.map(({ relativePath, file }) => ({ relativePath, file })),
    },
    emit,
  );
  const hashAfter = await hashManifest(files);

  return {
    target: absoluteTarget,
    result,
    normalized: normalizeScanResult(result),
    hashBefore,
    hashAfter,
    sourceUnchanged: hashBefore === hashAfter,
  };
}
