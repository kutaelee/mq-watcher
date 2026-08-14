import path from "node:path";
import { scanPath } from "./fixture-lib.mjs";

const target = path.resolve(process.argv[2] || ".");
const started = performance.now();
let lastReported = -1;
const scan = await scanPath(
  target,
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
const { result } = scan;

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
  hashBefore: scan.hashBefore,
  hashAfter: scan.hashAfter,
  sourceUnchanged: scan.sourceUnchanged,
  warnings: result.warnings,
};

console.log(JSON.stringify(report, null, 2));
