import assert from "node:assert/strict";
import test from "node:test";
import { addCaseNote, addCasePin, buildInvestigativeLeads, buildJournalRetentionIndex, buildSnapshotDiff, closeSession, createIncidentCase, findReusableSession, MAX_STORE_SESSIONS, restoreSessions, sessionId } from "../app/lib/workbench.mjs";

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
