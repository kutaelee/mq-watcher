import assert from "node:assert/strict";
import test from "node:test";
import { addCasePin, createIncidentCase, normalizeMessageId, removeCasePin, scopeIncidentCases, traceMessageEvidence } from "../app/lib/workbench.mjs";
import { scanDirectory } from "../public/store-scanner.worker.js";

function store(signature, records = [], strings = [], messages = []) {
  return {
    signature, directoryName: signature, structured: { records }, strings, messages,
    destinations: [], subscriptions: [], files: [], correlation: { links: [] },
  };
}

function record(command, messageId, offset, extra = {}) {
  return { file: "db-1.log", location: { dataFileId: 1, offset, size: 8 }, command, messageId, status: "Parsed", confidence: "Parsed", destination: { type: "Queue", name: "ORDERS" }, ...extra };
}

test("message trace models normal ADD and ACK/remove lifecycle without overclaiming", () => {
  const traced = traceMessageEvidence([store("normal", [record("KahaAddMessageCommand", "ID:CLIENT:1", 10), record("KahaRemoveMessageCommand", "ID:CLIENT:1", 30)])], "  ID:CLIENT:1  ");
  assert.equal(traced.messageId, "ID:CLIENT:1");
  assert.equal(traced.summary.addRecords, 1);
  assert.equal(traced.summary.ackRemoveRecords, 1);
  assert.ok(traced.interpretationLimits.includes("no-duplicate-delivery-proof"));
});

test("repeated ADD remains observations rather than duplicate-delivery detection", () => {
  const traced = traceMessageEvidence([store("repeated", [record("KahaAddMessageCommand", "ID:CLIENT:2", 10), record("KahaAddMessageCommand", "ID:CLIENT:2", 20)])], "ID:CLIENT:2");
  assert.equal(traced.summary.addRecords, 2);
  assert.ok(!JSON.stringify(traced).includes("duplicate delivery detected"));
});

test("transaction association follows exact Message ID transaction membership", () => {
  const traced = traceMessageEvidence([store("tx", [record("KahaAddMessageCommand", "ID:CLIENT:3", 10, { transactionId: "TX:3" }), record("KahaCommitCommand", undefined, 20, { transactionId: "TX:3" })])], "ID:CLIENT:3");
  assert.equal(traced.summary.transactionRecords, 1);
  assert.ok(traced.storeRefs[0].evidence.every((item) => item.transactionId === "TX:3"));
});

test("incident cases and pins are scoped to one Store signature", () => {
  const cases = [
    { id: "a", storeSignature: "store-a", storeName: "A", updatedAt: "2026-01-02", pins: [{ id: "a1", storeSignature: "store-a", semanticKey: "message:ID:A", storeName: "A" }, { id: "foreign", storeSignature: "store-b", semanticKey: "message:ID:B", storeName: "B" }] },
    { id: "b", storeSignature: "store-b", storeName: "B", updatedAt: "2026-01-01", pins: [] },
  ];
  const scoped = scopeIncidentCases(cases, "store-a");
  assert.deepEqual(scoped.map((item) => item.id), ["a"]);
  assert.deepEqual(scoped[0].pins.map((pin) => pin.id), ["a1"]);
});

test("removing one pinned occurrence preserves the same semantic key at another provenance", () => {
  const base = createIncidentCase("2026-01-01", "case", "store-a", "A");
  const common = { id: "pin", storeSignature: "store-a", storeName: "A", semanticKey: "message:ID:SAME", kind: "message", label: "same", confidence: "Observed" };
  const first = { ...common, provenance: { file: "db-1.log", offset: 10 } };
  const second = { ...common, provenance: { file: "db-2.log", offset: 20 } };
  const withPins = addCasePin(addCasePin(base, first, "2026-01-02"), second, "2026-01-03");
  const remaining = removeCasePin(withPins, first, "2026-01-04");
  assert.equal(remaining.pins.length, 1);
  assert.deepEqual(remaining.pins[0].provenance, second.provenance);
});

test("missing ACK is represented as absent scanned evidence, not never acknowledged", () => {
  const traced = traceMessageEvidence([store("no-ack", [record("KahaAddMessageCommand", "ID:CLIENT:4", 10)])], "ID:CLIENT:4");
  assert.equal(traced.summary.ackRemoveRecords, 0);
  assert.ok(traced.interpretationLimits.includes("no-current-broker-state"));
  assert.ok(!JSON.stringify(traced).includes("never acknowledged"));
});

test("multi-Store trace stays separated and does not fabricate one lifecycle", () => {
  const traced = traceMessageEvidence([store("before", [record("KahaAddMessageCommand", "ID:CLIENT:5", 10)]), store("after", [record("KahaAddMessageCommand", "ID:CLIENT:5", 10), record("KahaRemoveMessageCommand", "ID:CLIENT:5", 40)])], "ID:CLIENT:5");
  assert.equal(traced.storeRefs.length, 2);
  assert.deepEqual(traced.storeRefs.map((item) => item.evidence.filter((evidence) => evidence.evidenceType === "ACK_REMOVE").length), [0, 1]);
});

test("journal summary uses Store identity even when display names and file paths match", () => {
  const first = store("store-a", [record("KahaAddMessageCommand", "ID:SAME:1", 10)]);
  const second = store("store-b", [record("KahaAddMessageCommand", "ID:SAME:1", 20)]);
  first.directoryName = "same-name";
  second.directoryName = "same-name";
  const traced = traceMessageEvidence([first, second], "ID:SAME:1");
  assert.equal(traced.summary.journalCount, 2);
});

test("Message ID identity is exact and case-sensitive", () => {
  const traced = traceMessageEvidence([store("ids", [record("KahaAddMessageCommand", "ID:ABC:1", 10), record("KahaAddMessageCommand", "ID:ABC:10", 20), record("KahaAddMessageCommand", "id:ABC:1", 30)])], "ID:ABC:1");
  assert.equal(traced.summary.addRecords, 1);
  assert.equal(normalizeMessageId("prefix ID:ABC:1"), "");
  assert.equal(normalizeMessageId("ID:ABC:1"), "ID:ABC:1");
});

test("raw observations do not accept provider-ID continuations as exact matches", () => {
  const strings = [
    { id: "slash", file: "db-1.log", offset: 1, value: "prefix ID:ABC:1/child suffix", confidence: "Observed" },
    { id: "at", file: "db-1.log", offset: 2, value: "prefix ID:ABC:1@child suffix", confidence: "Observed" },
    { id: "delimited", file: "db-1.log", offset: 3, value: "messageId=ID:ABC:1;", confidence: "Observed" },
  ];
  const traced = traceMessageEvidence([store("raw", [], strings)], "ID:ABC:1");
  assert.deepEqual(traced.storeRefs[0].evidence.map((item) => item.evidenceRef), ["raw:delimited"]);
});

test("scanner can explicitly extend the initial 2,500-message batch to the end", async () => {
  const bytes = new TextEncoder().encode(Array.from({ length: 2601 }, (_, index) => `ActiveMQ.Advisory.TempQueue.${index}\0`).join(""));
  const file = { size: bytes.length, lastModified: 0, slice(start = 0, end = bytes.length) { const view = bytes.slice(start, end); return { arrayBuffer: async () => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) }; } };
  const input = { signature: "batch", directoryName: "batch", files: [{ relativePath: "events.bin", file }] };
  const initial = await scanDirectory(input, () => undefined);
  const extended = await scanDirectory({ ...input, messageLimit: 5000 }, () => undefined);
  assert.equal(initial.messages.length, 2500);
  assert.equal(initial.truncated.messages, true);
  assert.equal(extended.messages.length, 2601);
  assert.equal(extended.truncated.messages, false);
});

test("exact trace remains bounded across 10,000 structured records", () => {
  const records = Array.from({ length: 10_000 }, (_, index) =>
    record("KahaAddMessageCommand", index === 9_999 ? "ID:TARGET:10000" : `ID:NOISE:${index}`, index * 16),
  );
  const startedAt = performance.now();
  const traced = traceMessageEvidence([store("large", records)], "ID:TARGET:10000");
  const elapsedMs = performance.now() - startedAt;
  assert.equal(traced.summary.addRecords, 1);
  assert.ok(elapsedMs < 5_000, `10,000-record trace took ${elapsedMs.toFixed(1)} ms`);
});
