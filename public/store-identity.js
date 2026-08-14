export const STORE_IDENTITY_CHUNK_BYTES = 4 * 1024 * 1024;

const encoder = new TextEncoder();

function abortError() {
  return new DOMException("Store identity calculation was cancelled.", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function normalizeRelativePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

function compareCanonicalPath(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uint64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function uint32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function sha256(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds a content-derived Store identity with bounded source reads.
 *
 * Each source file is read in fixed-size slices. A SHA-256 chain combines the
 * chunk digests, normalized relative path, exact size, and canonical file order,
 * so neither the selected directory name nor mutable timestamps define identity.
 */
export async function buildContentStoreSignature(files, scannerVersion = "4", options = {}) {
  const signal = options.signal;
  const chunkBytes = options.chunkBytes ?? STORE_IDENTITY_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > STORE_IDENTITY_CHUNK_BYTES) {
    throw new RangeError(`chunkBytes must be between 1 and ${STORE_IDENTITY_CHUNK_BYTES}`);
  }

  const canonical = [...files].map(({ relativePath, file }) => ({
    relativePath: normalizeRelativePath(relativePath),
    file,
  })).sort((left, right) => compareCanonicalPath(left.relativePath, right.relativePath));
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index - 1].relativePath === canonical[index].relativePath) {
      throw new Error(`Duplicate Store path: ${canonical[index].relativePath}`);
    }
  }

  const totalBytes = canonical.reduce((sum, item) => sum + item.file.size, 0);
  let readBytes = 0;
  let storeChain = await sha256(encoder.encode(`mq-watcher-store-content-v1\0${scannerVersion}`));

  for (let fileIndex = 0; fileIndex < canonical.length; fileIndex += 1) {
    throwIfAborted(signal);
    const { relativePath, file } = canonical[fileIndex];
    let fileChain = await sha256(concat(
      encoder.encode("mq-watcher-file-content-v1\0"),
      uint32(encoder.encode(relativePath).byteLength),
      encoder.encode(relativePath),
      uint64(file.size),
    ));
    let chunkIndex = 0;
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      throwIfAborted(signal);
      const end = Math.min(file.size, offset + chunkBytes);
      const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      throwIfAborted(signal);
      if (chunk.byteLength !== end - offset) throw new Error(`Short read while identifying ${relativePath}`);
      const chunkDigest = await sha256(chunk);
      fileChain = await sha256(concat(
        encoder.encode("mq-watcher-chunk-chain-v1\0"),
        fileChain,
        uint64(chunkIndex),
        uint32(chunk.byteLength),
        chunkDigest,
      ));
      chunkIndex += 1;
      readBytes += chunk.byteLength;
      options.onProgress?.({ relativePath, fileIndex: fileIndex + 1, fileCount: canonical.length, readBytes, totalBytes });
    }
    storeChain = await sha256(concat(
      encoder.encode("mq-watcher-store-chain-v1\0"),
      storeChain,
      uint32(encoder.encode(relativePath).byteLength),
      encoder.encode(relativePath),
      fileChain,
    ));
  }

  throwIfAborted(signal);
  return `${scannerVersion}:content-sha256:${toHex(storeChain)}`;
}
