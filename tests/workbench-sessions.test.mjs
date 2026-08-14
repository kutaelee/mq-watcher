import assert from "node:assert/strict";
import test from "node:test";
import { addCaseNote, addCasePin, buildEvidenceTimeline, buildInvestigativeLeads, buildJournalRetentionIndex, buildSnapshotDiff, closeSession, createIncidentCase, findReusableSession, MAX_STORE_SESSIONS, restoreSessions, sessionId } from "../app/lib/workbench.mjs";
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

test("session IDs and duplicate lookup are deterministic", () => {
  assert.equal(sessionId("3:store:1:abc"), sessionId("3:store:1:abc"));
  assert.notEqual(sessionId("3:store:1:abc"), sessionId("3:store:1:def"));
  const existing = { id: "a", signature: "same" };
  assert.equal(findReusableSession([existing], "same"), existing);
});

test("closing the active tab selects the nearest remaining tab", () => {
  const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(closeSession(sessions, "b", "b"), {
    sessions: [{ id: "a" }, { id: "c" }],
    activeSessionId: "c",
  });
});

test("restoration is bounded and marks cached sessions", () => {
  const sessions = Array.from({ length: MAX_STORE_SESSIONS + 2 }, (_, index) => ({
    id: `s${index}`,
    signature: `sig${index}`,
    result: { signature: `sig${index}` },
  }));
  const restored = restoreSessions({ sessions });
  assert.equal(restored.length, MAX_STORE_SESSIONS);
  assert.ok(restored.every((session) => session.restored && session.status === "ready"));
});

test("snapshot diff is deterministic and reports observations without runtime-state claims", () => {
  const base = {
    destinations: [{ type: "Queue", name: "ORDERS", occurrences: 2 }],
    subscriptions: [],
    files: [{ path: "db-1.log", size: 100 }],
    structured: { records: [{ command: "KahaAddMessageCommand", destination: { name: "ORDERS" } }] },
    correlation: { counts: { messages: 1 } },
  };
  const later = structuredClone(base);
  later.destinations[0].occurrences = 3;
  later.destinations.push({ type: "Topic", name: "PRICES", occurrences: 1 });
  later.files[0].size = 140;
  const first = buildSnapshotDiff(base, later);
  assert.deepEqual(first, buildSnapshotDiff(base, later));
  assert.ok(first.some((row) => row.status === "not-observed-left" && row.key.includes("PRICES")));
  assert.ok(first.some((row) => row.status === "changed" && row.delta === 40));
  assert.ok(first.every((row) => !row.status.includes("removed")));
});

test("incident cases keep explicit user notes and de-duplicate pinned evidence", () => {
  const created = createIncidentCase("2026-01-01T00:00:00.000Z", "case-1");
  const noted = addCaseNote(created, "Check the reconnect sequence", "2026-01-01T00:01:00.000Z", "note-1");
  const pin = { id: "evidence-1", storeSignature: "sig", storeName: "store-a", kind: "message", label: "ORDERS", file: "db-1.log", offset: 12, confidence: "Parsed" };
  const pinned = addCasePin(noted, pin, "2026-01-01T00:02:00.000Z");
  assert.equal(pinned.notes[0].text, "Check the reconnect sequence");
  assert.equal(addCasePin(pinned, pin).pins.length, 1);
});

test("investigative leads expose their thresholds without declaring a root cause", () => {
  const result = {
    totals: { advisoryRecords: 12 },
    structured: { records: Array.from({ length: 10 }, (_, index) => ({ file: index < 7 ? "db-1.log" : "db-2.log", status: index < 5 ? "Partial" : "Parsed" })) },
  };
  const leads = buildInvestigativeLeads(result);
  assert.deepEqual(leads.map((item) => item.code), ["advisory-volume", "unresolved-records", "journal-concentration"]);
  assert.ok(leads.every((item) => Number.isFinite(item.threshold)));
});

test("journal reverse index preserves file order and observed references", () => {
  const result = {
    files: [{ path: "db-1.log", name: "db-1.log", kind: "journal", size: 100, modified: 1 }, { path: "db-2.log", name: "db-2.log", kind: "journal", size: 200, modified: 2 }],
    structured: { records: [{ file: "db-1.log", command: "KahaAddMessageCommand", location: { offset: 24 }, destination: { name: "ORDERS" } }] },
    correlation: { links: [{ evidenceRefs: [{ id: "ref-1", file: "db-1.log", offset: 24, label: "ID:1", confidence: "Parsed" }] }] },
  };
  const rows = buildJournalRetentionIndex(result);
  assert.deepEqual(rows.map((row) => row.fileId), [1, 2]);
  assert.equal(rows[0].referenceCount, 1);
  assert.equal(rows[0].sequence, "older-file-id");
  assert.equal(rows[1].observation, "no-structured-observation");
});

test("evidence timeline uses deterministic file and offset order without timestamps", () => {
  const result = { structured: { records: [
    { file: "db-2.log", location: { dataFileId: 2, offset: 4 }, command: "Second", status: "Parsed", confidence: "Parsed" },
    { file: "db-1.log", location: { dataFileId: 1, offset: 40 }, command: "Later", status: "Parsed", confidence: "Parsed" },
    { file: "db-1.log", location: { dataFileId: 1, offset: 8 }, command: "First", status: "Partial", confidence: "Parsed" },
  ] } };
  const timeline = buildEvidenceTimeline(result, 2);
  assert.deepEqual(timeline.events.map((event) => event.command), ["First", "Later"]);
  assert.equal(timeline.truncated, true);
  assert.ok(timeline.events.every((event) => !("timestamp" in event) && !("time" in event)));
});

test("evidence bundle is deterministic, checksummed, redacted, and excludes source bytes", async () => {
  const secret = "TENANT-X-SECRET";
  const result = {
    signature: `signature-${secret}`, directoryName: `store-${secret}`, storeKind: "AMQ Message Store", totals: { bytes: 10 }, warnings: [`warning ${secret} SECRET.ORDERS ID:SECRET:1 private/db-1.log`],
    files: [{ path: "private/db-1.log", name: "db-1.log", kind: "journal", size: 10, modified: 0 }],
    destinations: [{ id: "dest-1", name: "SECRET.ORDERS", decodedName: "SECRET.ORDERS", rawName: "SECRET.ORDERS", source: "private/db-1.log" }], subscriptions: [], messages: [{ id: "message-1", journal: "private/db-1.log", destination: "SECRET.ORDERS", relatedId: "ID:SECRET:1", hex: `54 45 4e 41 4e 54 ${secret}`, strings: [] }], strings: [{ id: "raw-1", file: "private/db-1.log", offset: 0, value: `${secret} SECRET.ORDERS ID:SECRET:1`, confidence: "Pattern Match" }],
    structured: { records: [{ file: "private/db-1.log", location: { dataFileId: 1, offset: 2 }, command: "KahaAddMessageCommand", status: "Parsed", confidence: "Parsed", destination: { name: "SECRET.ORDERS" }, messageId: "ID:SECRET:1", warning: `${secret} private/db-1.log` }] },
    correlation: { links: [{ id: "link-1", evidenceRefs: [], interpretation: `${secret} SECRET.ORDERS ID:SECRET:1 private/db-1.log` }], counts: {} },
  };
  const incidentCase = { id: "case-1", title: `title ${secret}`, hypothesis: `hypothesis ${secret}`, notes: [{ id: "note-1", text: `note ${secret}`, createdAt: "2026-01-01T00:00:00.000Z" }], pins: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const options = { result, incidentCase, locale: "en", redaction: { identifiers: true, destinations: true, filePaths: true, notes: true }, generatedAt: "2026-01-01T00:00:00.000Z" };
  const first = await buildEvidenceBundle(options);
  const second = await buildEvidenceBundle(options);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.manifest.sourceFilesIncluded, false);
  const entries = readStoredZip(first.bytes);
  assert.deepEqual([...entries.keys()].sort(), ["README.txt", "SHA256SUMS.txt", "evidence.json", "manifest.json", "report.html"]);
  const allText = [...entries.values()].map((bytes) => new TextDecoder().decode(bytes)).join("\n");
  for (const canary of [secret, "SECRET.ORDERS", "ID:SECRET:1", "private/db-1.log", "db-1.log"]) assert.ok(!allText.includes(canary), `leaked ${canary}`);
  assert.match(new TextDecoder().decode(entries.get("evidence.json")), /REDACTED_HEX_PREVIEW/);
  const sums = new TextDecoder().decode(entries.get("SHA256SUMS.txt")).trim().split("\n");
  const crypto = await import("node:crypto");
  for (const line of sums) {
    const [expected, name] = line.split(/\s{2}/);
    assert.equal(crypto.createHash("sha256").update(entries.get(name)).digest("hex"), expected);
  }
});

test("chunked export reports monotonic progress and honors cancellation", async () => {
  const records = Array.from({ length: 2200 }, (_, index) => ({ file: "db-1.log", location: { dataFileId: 1, offset: index }, command: "KahaAddMessageCommand", status: "Parsed", confidence: "Parsed", messageId: `ID:${index}` }));
  const result = { signature: "sig", directoryName: "store", storeKind: "AMQ Message Store", totals: {}, warnings: [], files: [], destinations: [], subscriptions: [], messages: [], strings: [], structured: { records }, correlation: { links: [], counts: {} } };
  const progress = [];
  let shouldCancel = false;
  await assert.rejects(() => buildEvidenceBundle({ result }, { onProgress: (event) => { progress.push(event.progress); if (event.progress >= 36) shouldCancel = true; }, isCancelled: () => shouldCancel }), { name: "AbortError" });
  assert.ok(progress.length > 2);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
});
