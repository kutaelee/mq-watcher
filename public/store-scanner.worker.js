/* Read-only binary scanner. It never receives writable handles. */
import { parseKahaDbJournalFile, summarizeStructuredJournals } from "./kahadb-journal-parser.js";
import { correlateEvidence } from "./evidence-correlation.js";
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_STRINGS = 6000;
const MAX_MESSAGES = 2500;
const MAX_STRING_LENGTH = 2048;
let cancelled = false;
const workerScope = typeof self !== "undefined" ? self : null;

if (workerScope) workerScope.onmessage = async (event) => {
  if (event.data?.type === "cancel") {
    cancelled = true;
    return;
  }
  if (event.data?.type !== "scan") return;

  cancelled = false;
  try {
    const result = await scanDirectory(event.data);
    if (cancelled) {
      workerScope.postMessage({ type: "cancelled" });
      return;
    }
    workerScope.postMessage({ type: "complete", result });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

function classifyFile(path) {
  const lower = path.toLowerCase();
  if (/\/(?:db-\d+\.log|data-\d+|data-control)$/.test(`/${lower}`)) return "journal";
  if (lower.includes("hash-index-") || lower.includes("container-roots")) return "index";
  if (lower.includes("/state/")) return "state";
  if (/tmpdb\.(?:data|redo)$/.test(lower) || lower.includes("queue-data")) return "data";
  return "other";
}

function detectStore(files) {
  const paths = files.map((entry) => entry.relativePath.toLowerCase());
  const hasTempDb = paths.some((path) => /(?:^|\/)tmpdb\.(?:data|redo)$/.test(path));
  const hasDbLog = paths.some((path) => /(?:^|\/)db-\d+\.log$/.test(path));
  if (hasTempDb && hasDbLog) {
    return {
      kind: "Temporary Message Store",
      description: "PList + Journal 구조가 파일명에서 확인되었습니다.",
    };
  }

  const hasJournal = paths.some((path) => /(?:^|\/)journal\/(?:data-\d+|data-control)$/.test(path));
  const hasKaha = paths.some((path) => path.includes("kr-store/data/"));
  if (hasJournal && hasKaha) {
    return {
      kind: "AMQ Message Store",
      description: "Persistent Journal + Kaha Reference Store 구조가 확인되었습니다.",
    };
  }

  return {
    kind: "Unknown Store Layout",
    description: "지원하는 Store 구조를 파일명만으로 확정할 수 없습니다.",
  };
}

function decodeHashName(value) {
  return value.replace(/#([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function destinationFromFile(path) {
  const name = path.split("/").pop() || path;
  const match = name.match(/^hash-index-queue-data_(.+)$/i);
  if (!match) return null;
  const raw = match[1];
  const decoded = decodeHashName(raw);
  const scheme = decoded.match(/^(queue|topic):\/\/(.+)$/i);
  return {
    type: scheme ? titleCase(scheme[1]) : "Unknown",
    name: scheme ? scheme[2] : decoded,
    decodedName: decoded,
    rawName: raw,
    source: path,
    confidence: scheme ? "Parsed" : "Pattern Match",
  };
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function makeHex(bytes, absoluteStart) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, Math.min(i + 16, bytes.length));
    const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(47, " ");
    const ascii = Array.from(row, (byte) =>
      byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".",
    ).join("");
    lines.push(`${(absoluteStart + i).toString(16).padStart(8, "0")}  ${hex}  ${ascii}`);
  }
  return lines.join("\n");
}

function parseConsumerId(raw) {
  const parts = raw.split(":");
  if (parts.length < 5) {
    return { connection: raw, session: "Unknown", consumer: "Unknown" };
  }
  return {
    connection: parts.slice(0, -3).join(":"),
    session: parts.at(-2) || "Unknown",
    consumer: parts.at(-1) || "Unknown",
  };
}

export async function scanDirectory({ signature, directoryName, files }, emit = (message) => workerScope?.postMessage(message)) {
  const store = detectStore(files);
  const totalBytes = files.reduce((sum, entry) => sum + entry.file.size, 0);
  let scannedBytes = 0;
  let advisoryRecords = 0;
  let stringsTruncated = false;
  let messagesTruncated = false;
  let lastProgressAt = 0;

  const scannedFiles = files.map((entry) => ({
    path: entry.relativePath,
    name: entry.file.name,
    size: entry.file.size,
    modified: entry.file.lastModified,
    kind: classifyFile(entry.relativePath),
    confidence: "Observed",
  }));

  const destinationMap = new Map();
  const subscriptionMap = new Map();
  const stringHits = [];
  const messages = [];
  const structuredJournals = [];

  for (const entry of files) {
    if (/(?:^|\/)db-\d+\.log$/i.test(entry.relativePath)) {
      structuredJournals.push(await parseKahaDbJournalFile(entry.file, entry.relativePath));
    }
  }

  for (const entry of files) {
    const parsed = destinationFromFile(entry.relativePath);
    if (parsed) addDestination(destinationMap, parsed);
  }

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    if (cancelled) break;
    const entry = files[fileIndex];
    const file = entry.file;
    let printable = "";
    let printableOffset = 0;
    let recentStrings = [];
    let recentDestination = "";
    let recentDestinationOffset = -Infinity;
    let recentTopicSubscriptionOffset = -Infinity;
    let pendingMessage = null;

    const processPrintable = (value, offset, chunkBytes, chunkStart) => {
      const normalized = value.slice(0, MAX_STRING_LENGTH);
      const hit = {
        id: `${entry.relativePath}:${offset}`,
        file: entry.relativePath,
        offset,
        value: normalized,
        confidence: "Observed",
      };
      if (stringHits.length < MAX_STRINGS) stringHits.push(hit);
      else stringsTruncated = true;

      recentStrings.push({ offset, value: normalized });
      recentStrings = recentStrings.filter((item) => offset - item.offset <= 8192).slice(-12);

      if (/TopicSubscription/i.test(normalized)) {
        recentTopicSubscriptionOffset = offset;
      }

      const destinations = new Set();
      for (const match of normalized.matchAll(/\b[A-Za-z][A-Za-z0-9_-]*MQ\.Advisory\.[A-Za-z0-9._-]+/g)) {
        destinations.add(match[0]);
      }
      for (const match of normalized.matchAll(/\b(?:queue|topic):\/\/[A-Za-z0-9._:/-]+/gi)) {
        destinations.add(match[0]);
      }
      for (const match of normalized.matchAll(/\b(?:ROUTE|RETURN|RECEIVE|ESB)\.[A-Z0-9._-]+\b/g)) {
        destinations.add(match[0]);
      }

      for (const detected of destinations) {
        const advisory = /\.Advisory\./.test(detected);
        let type = "Unknown";
        let name = detected;
        if (/^queue:\/\//i.test(detected)) {
          type = "Queue";
          name = detected.replace(/^queue:\/\//i, "");
        } else if (/^topic:\/\//i.test(detected) || advisory) {
          type = "Topic";
          name = detected.replace(/^topic:\/\//i, "");
        } else if (/^(ROUTE|RETURN|RECEIVE|ESB)\./.test(detected)) {
          type = "Queue";
        }
        addDestination(destinationMap, {
          type,
          name,
          decodedName: detected,
          rawName: detected,
          source: entry.relativePath,
          confidence: advisory ? "Observed" : "Pattern Match",
        });
        recentDestination = name;
        recentDestinationOffset = offset;

        if (advisory) {
          advisoryRecords += 1;
          if (messages.length < MAX_MESSAGES) {
            const local = Math.max(0, Math.min(chunkBytes.length - 1, offset - chunkStart));
            const previewStart = Math.max(0, local - 96);
            const previewEnd = Math.min(chunkBytes.length, local + 320);
            pendingMessage = {
              id: `${entry.relativePath}:${offset}:advisory`,
              journal: entry.relativePath,
              offset,
              destination: name,
              detectedType: "Unknown",
              relatedId: "Unknown",
              operation: "Unknown",
              confidence: "Observed",
              strings: recentStrings.slice(-8),
              hex: makeHex(
                chunkBytes.subarray(previewStart, previewEnd),
                chunkStart + previewStart,
              ),
            };
            messages.push(pendingMessage);
          } else {
            messagesTruncated = true;
          }
        }
      }

      const consumerMatches = normalized.match(/ID:[A-Za-z0-9_.-]+:\d+:-?\d+:\d+/g) || [];
      for (const rawId of consumerMatches) {
        const parsedId = parseConsumerId(rawId);
        const isTopic = offset - recentTopicSubscriptionOffset <= 8192;
        const existing = subscriptionMap.get(rawId);
        if (existing) {
          existing.occurrences += 1;
          if (isTopic) {
            existing.type = "TopicSubscription";
            existing.confidence = "Pattern Match";
          }
        } else {
          subscriptionMap.set(rawId, {
            id: rawId,
            rawId,
            type: isTopic ? "TopicSubscription" : "Subscription candidate",
            connection: parsedId.connection,
            session: parsedId.session,
            consumer: parsedId.consumer,
            relatedStore: entry.relativePath,
            relatedDestination:
              offset - recentDestinationOffset <= 8192 ? recentDestination : "Unknown",
            occurrences: 1,
            confidence: "Pattern Match",
          });
        }
      }

      const idMatches = normalized.match(/ID:[A-Za-z][A-Za-z0-9_.-]{3,}(?::[A-Za-z0-9_.-]+)+/g) || [];
      if (pendingMessage && offset - pendingMessage.offset <= 8192 && idMatches.length) {
        const related = idMatches.find((item) => !subscriptionMap.has(item)) || idMatches[0];
        pendingMessage.relatedId = related;
        pendingMessage.strings = recentStrings.slice(-10);
      }
      if (pendingMessage && offset - pendingMessage.offset <= 8192) {
        if (/DestinationInfo/.test(normalized)) pendingMessage.detectedType = "DestinationInfo";
        if (/operationType\s*[=:]\s*0\b/.test(normalized)) pendingMessage.operation = "CREATE";
        if (/operationType\s*[=:]\s*1\b/.test(normalized)) pendingMessage.operation = "DELETE";
        pendingMessage.strings = recentStrings.slice(-10);
      }
      if (pendingMessage && offset - pendingMessage.offset > 8192) pendingMessage = null;
    };

    for (let chunkStart = 0; chunkStart < file.size; chunkStart += CHUNK_SIZE) {
      if (cancelled) break;
      const chunkEnd = Math.min(file.size, chunkStart + CHUNK_SIZE);
      const chunkBytes = new Uint8Array(await file.slice(chunkStart, chunkEnd).arrayBuffer());

      for (let index = 0; index < chunkBytes.length; index += 1) {
        const byte = chunkBytes[index];
        const absoluteOffset = chunkStart + index;
        if (byte >= 32 && byte <= 126) {
          if (!printable) printableOffset = absoluteOffset;
          printable += String.fromCharCode(byte);
          if (printable.length >= MAX_STRING_LENGTH) {
            processPrintable(printable, printableOffset, chunkBytes, chunkStart);
            printable = "";
          }
        } else {
          if (printable.length >= 4) {
            processPrintable(printable, printableOffset, chunkBytes, chunkStart);
          }
          printable = "";
        }
      }

      const bytesRead = chunkEnd - chunkStart;
      scannedBytes += bytesRead;
      const now = Date.now();
      if (now - lastProgressAt >= 120 || scannedBytes === totalBytes) {
        emit({
          type: "progress",
          file: entry.relativePath,
          fileIndex: fileIndex + 1,
          fileCount: files.length,
          scannedBytes,
          totalBytes,
        });
        lastProgressAt = now;
      }
    }

    if (printable.length >= 4) {
      processPrintable(printable, printableOffset, new Uint8Array(), file.size);
    }
  }

  const structured = summarizeStructuredJournals(structuredJournals);
  const correlation = correlateEvidence({
    structured,
    messages,
    subscriptions: Array.from(subscriptionMap.values()),
    strings: stringHits,
  });
  const warnings = [];
  if (stringsTruncated) warnings.push(`문자열 목록은 ${MAX_STRINGS.toLocaleString()}건까지만 보관했습니다.`);
  if (messagesTruncated) warnings.push(`메시지 후보는 ${MAX_MESSAGES.toLocaleString()}건까지만 보관했습니다.`);
  if (store.kind === "Unknown Store Layout") {
    warnings.push("Store 유형을 확정하지 않았습니다. 파일 목록과 Raw 문자열을 직접 확인하세요.");
  }

  return {
    signature,
    directoryName,
    storeKind: store.kind,
    storeDescription: store.description,
    files: scannedFiles,
    destinations: Array.from(destinationMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    subscriptions: Array.from(subscriptionMap.values()).sort(
      (a, b) => b.occurrences - a.occurrences,
    ),
    messages,
    structured,
    correlation,
    strings: stringHits,
    totals: {
      bytes: totalBytes,
      journalFiles: scannedFiles.filter((file) => file.kind === "journal").length,
      advisoryRecords,
      scannedBytes,
    },
    warnings,
    truncated: { messages: messagesTruncated, strings: stringsTruncated },
    scannedAt: new Date().toISOString(),
  };
}

function addDestination(map, destination) {
  const key = `${destination.type}:${destination.name}`;
  const current = map.get(key);
  if (current) {
    current.occurrences += 1;
    return;
  }
  map.set(key, {
    id: key,
    ...destination,
    occurrences: 1,
  });
}
