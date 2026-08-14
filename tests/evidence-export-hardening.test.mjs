import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAndClickDownload, ExportTaskLifecycle } from "../app/lib/export-task.mjs";
import { buildEvidenceBundle } from "../public/workbench-export.js";

function readStoredZip(bytes) {
  const files = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLength));
    files.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return files;
}

function fixture(records = []) {
  return {
    signature: "safe-signature",
    directoryName: "safe-store",
    storeKind: "AMQ Message Store",
    totals: { bytes: 1 },
    warnings: [],
    files: [{ path: "db-1.log", name: "db-1.log", kind: "journal", size: 1, modified: 0 }],
    destinations: [], subscriptions: [], messages: [], strings: [],
    structured: { records },
    correlation: { links: [], counts: {} },
  };
}

test("central export sanitizer removes independent free-text and UTF-8 hex canaries from every ZIP entry", async () => {
  const canaries = {
    raw: "RAW-ONLY-CANARY-93001",
    warning: "WARNING-ONLY-CANARY-93002",
    structuredWarning: "STRUCTURED-WARNING-ONLY-CANARY-93003",
    interpretation: "INTERPRETATION-ONLY-CANARY-93004",
    note: "NOTE-ONLY-CANARY-93005",
    label: "LABEL-ONLY-CANARY-93006",
    comparison: "COMPARISON-ONLY-CANARY-93007",
    directory: "DIRECTORY-ONLY-CANARY-93008",
    file: "FILE-ONLY-CANARY-93009.log",
  };
  const unicodeSecret = "민감정보-93010";
  const utf8Hex = [...new TextEncoder().encode(unicodeSecret)].map((byte) => byte.toString(16).padStart(2, "0"));
  const result = fixture([{ file: canaries.file, location: { dataFileId: 1, offset: 0 }, command: "Unknown", status: "Partial", confidence: "Observed", warning: canaries.structuredWarning }]);
  result.directoryName = canaries.directory;
  result.files = [{ path: canaries.file, name: canaries.file, kind: "journal", size: 1, modified: 0 }];
  result.warnings = [canaries.warning];
  result.strings = [{ id: "raw-safe", file: canaries.file, offset: 0, value: canaries.raw, confidence: "Observed" }];
  result.messages = [{ id: "message-safe", journal: canaries.file, destination: "SAFE.QUEUE", relatedId: "ID:SAFE:1", hex: utf8Hex.join(" "), strings: [] }];
  result.correlation.links = [{ id: "link-safe", evidenceRefs: [], interpretation: canaries.interpretation }];
  const foreignStoreName = "OTHER-STORE-NAME-CANARY-88421";
  const incidentCase = { id: "case-safe", title: "safe", hypothesis: "safe", notes: [{ id: "note-safe", text: canaries.note, createdAt: "x" }], pins: [{ id: "pin-safe", label: canaries.label, storeName: foreignStoreName }], createdAt: "x", updatedAt: "x" };
  const bundle = await buildEvidenceBundle({ result, incidentCase, comparison: [{ id: "comparison-safe", category: "message", key: canaries.comparison }], redaction: { identifiers: true, destinations: true, filePaths: true, notes: true }, generatedAt: "x" });
  const entries = readStoredZip(bundle.bytes);
  const allBytesText = new TextDecoder().decode(bundle.bytes);
  const allEntryText = [...entries.values()].map((value) => new TextDecoder().decode(value)).join("\n");
  for (const secret of [...Object.values(canaries), foreignStoreName, unicodeSecret, utf8Hex.join(" "), utf8Hex.join("")]) {
    assert.ok(!allEntryText.includes(secret), `entry leaked ${secret}`);
    assert.ok(!allBytesText.includes(secret), `ZIP bytes leaked ${secret}`);
  }
  assert.match(allEntryText, /REDACTED_HEX_PREVIEW/);
  const sums = new TextDecoder().decode(entries.get("SHA256SUMS.txt")).trim().split("\n");
  for (const line of sums) {
    const [expected, name] = line.split(/\s{2}/);
    assert.equal(createHash("sha256").update(entries.get(name)).digest("hex"), expected);
  }
  assert.equal(createHash("sha256").update(bundle.bytes).digest("hex"), bundle.sha256);
});

test("HTML report escapes dynamic values when redaction is disabled", async () => {
  const result = fixture();
  result.directoryName = '<script data-secret="x">alert(1)</script>';
  const bundle = await buildEvidenceBundle({ result, redaction: {}, generatedAt: "x" });
  const report = new TextDecoder().decode(readStoredZip(bundle.bytes).get("report.html"));
  assert.ok(!report.includes('<script data-secret="x">'));
  assert.match(report, /&lt;script data-secret=&quot;x&quot;&gt;/);
});

test("export lifecycle invalidates stale operations and releases worker, timer, listener, and object URL resources", () => {
  const calls = [];
  const timers = new Map();
  let nextTimer = 1;
  const lifecycle = new ExportTaskLifecycle({
    clearTimer: (value) => { calls.push(`clear:${value}`); timers.delete(value); },
    setTimer: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
    revokeUrl: (value) => calls.push(`revoke:${value}`),
  });
  const workerA = { onmessage: () => {}, onerror: () => {}, postMessage: (value) => calls.push(`post-a:${value.operationId}`), terminate: () => calls.push("terminate-a") };
  const operationA = lifecycle.begin();
  assert.equal(lifecycle.attachWorker(operationA, workerA), true);
  const workerB = { onmessage: () => {}, onerror: () => {}, postMessage: (value) => calls.push(`post-b:${value.operationId}`), terminate: () => calls.push("terminate-b") };
  const operationB = lifecycle.begin();
  assert.equal(workerA.onmessage, null);
  assert.equal(workerA.onerror, null);
  assert.equal(lifecycle.isCurrent(operationA), false);
  assert.equal(lifecycle.attachWorker(operationB, workerB), true);
  lifecycle.trackObjectUrl(operationB, "blob:b");
  lifecycle.cancel();
  assert.equal(lifecycle.isCurrent(operationB), false);
  assert.equal(workerB.onmessage, null);
  assert.equal(workerB.onerror, null);
  assert.ok(calls.includes(`post-b:${operationB}`));
  assert.ok(calls.includes("terminate-a") && calls.includes("terminate-b"));
  assert.ok(calls.includes("revoke:blob:b"));
  assert.ok(calls.some((value) => value.startsWith("clear:")));
  lifecycle.dispose();
});

test("download click failure revokes the newly created object URL", () => {
  const calls = [];
  assert.throws(() => createAndClickDownload({
    blob: new Blob(["x"]),
    filename: "mq-watcher-evidence-bundle.zip",
    createObjectUrl: () => "blob:failed",
    revokeObjectUrl: (value) => calls.push(value),
    click: () => { throw new Error("blocked"); },
  }), /blocked/);
  assert.deepEqual(calls, ["blob:failed"]);
});

test("production export uses a neutral download filename", async () => {
  const source = await readFile(new URL("../app/components/export/EvidenceExport.tsx", import.meta.url), "utf8");
  assert.match(source, /filename:\s*"mq-watcher-evidence-bundle\.zip"/);
  assert.doesNotMatch(source, /filename:\s*result\.directoryName|download\s*=.*directoryName/);
});

test("five thousand uniquely redacted records complete within the regression budget", async () => {
  const count = 5_000;
  const records = Array.from({ length: count }, (_, index) => ({ file: "db-1.log", location: { dataFileId: 1, offset: index }, command: "KahaAddMessageCommand", status: "Parsed", confidence: "Parsed", messageId: `ID:UNIQUE:${index}` }));
  const started = performance.now();
  const bundle = await buildEvidenceBundle({ result: fixture(records), redaction: { identifiers: true, destinations: true, filePaths: true, notes: true }, generatedAt: "x" });
  assert.ok(bundle.bytes.length > 0);
  assert.ok(performance.now() - started < 10_000, "5k export exceeded 10 seconds");
});

test("fifty thousand records honor cancellation at the first progress boundary", async () => {
  const records = Array.from({ length: 50_000 }, (_, index) => ({ file: "db-1.log", location: { dataFileId: 1, offset: index }, command: "KahaAddMessageCommand", status: "Parsed", confidence: "Parsed", messageId: `ID:${index}` }));
  let shouldCancel = false;
  const started = performance.now();
  await assert.rejects(() => buildEvidenceBundle({ result: fixture(records) }, { onProgress: () => { shouldCancel = true; }, isCancelled: () => shouldCancel }), { name: "AbortError" });
  assert.ok(performance.now() - started < 1_000, "50k cancellation was not immediate");
});

test("actual export worker protocol reports progress and cancellation", async () => {
  const originalSelf = globalThis.self;
  const messages = [];
  globalThis.self = { postMessage: (value) => messages.push(value) };
  try {
    await import(`../public/evidence-export.worker.js?test=${Date.now()}`);
    const operationId = 77;
    const running = globalThis.self.onmessage({ data: { type: "build", operationId, payload: { result: fixture(), redaction: { identifiers: true } } } });
    await globalThis.self.onmessage({ data: { type: "cancel", operationId } });
    await running;
    assert.ok(messages.some((message) => message.type === "progress" && message.operationId === operationId));
    assert.ok(messages.some((message) => message.type === "cancelled" && message.operationId === operationId));
    assert.ok(!messages.some((message) => message.type === "complete" && message.operationId === operationId));
  } finally {
    globalThis.self = originalSelf;
  }
});
