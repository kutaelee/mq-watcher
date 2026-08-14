import assert from "node:assert/strict";
import test from "node:test";
import { addCaseNote, addCasePin, buildEvidenceTimeline, buildInvestigativeLeads, buildJournalRetentionIndex, buildSnapshotDiff, buildStoreSignature, buildStoreSignatureInWorker, closeSession, createIncidentCase, findReusableSession, getSessionCapabilities, MAX_STORE_SESSIONS, resolveCasePin, restoreSessions, sessionId, SessionResourceLedger, SignatureReservationRegistry } from "../app/lib/workbench.mjs";
import { STORE_IDENTITY_CHUNK_BYTES } from "../public/store-identity.js";
import { applyDatabaseUpgrade, CACHE_SCHEMA_VERSION, enqueueScanCacheWrite, planDatabaseMigration } from "../app/lib/scan-cache-core.mjs";
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

test("store identity is content-derived, bounded, and not recomputed by ordinary session interactions", async () => {
  let sourceReads = 0;
  let largestRead = 0;
  const source = (text) => {
    const blob = new Blob([text]);
    return {
      size: blob.size,
      lastModified: 7,
      slice(start, end) {
        sourceReads += 1;
        largestRead = Math.max(largestRead, end - start);
        return blob.slice(start, end);
      },
    };
  };
  const aFiles = [{ relativePath: "db-1.log", file: source("AAAA") }, { relativePath: "lock", file: source("") }];
  const bFiles = [{ relativePath: "db-1.log", file: source("BBBB") }, { relativePath: "lock", file: source("") }];
  const first = await buildStoreSignature(aFiles, "4");
  const sameContentReordered = await buildStoreSignature([...aFiles].reverse(), "4");
  const sameMetadataDifferentBytes = await buildStoreSignature(bFiles, "4");
  assert.equal(first, sameContentReordered);
  assert.notEqual(first, sameMetadataDifferentBytes, "AAAA and BBBB must not share a cache/session identity");
  assert.match(first, /^4:content-sha256:[a-f0-9]{64}$/);
  assert.ok(sourceReads > 0, "initial identity calculation must read source content");
  assert.ok(largestRead <= STORE_IDENTITY_CHUNK_BYTES);

  const reservations = new SignatureReservationRegistry();
  const firstOpen = reservations.reserve(first);
  assert.equal(firstOpen.accepted, true);
  assert.equal(reservations.reserve(first).accepted, false, "a concurrent duplicate open must share one reservation");
  const differentContentOpen = reservations.reserve(sameMetadataDifferentBytes);
  assert.equal(differentContentOpen.accepted, true, "different source bytes must not collide with the active reservation");
  const cache = new Map();
  await enqueueScanCacheWrite(first, firstOpen.token, () => true, async () => cache.set(first, "AAAA"));
  await enqueueScanCacheWrite(sameMetadataDifferentBytes, differentContentOpen.token, () => true, async () => cache.set(sameMetadataDifferentBytes, "BBBB"));
  assert.deepEqual([...cache.values()].sort(), ["AAAA", "BBBB"], "same metadata with different content must keep separate cache entries");

  const readsAfterInitialIdentity = sourceReads;
  const session = { id: sessionId(first), signature: first };
  assert.equal(findReusableSession([session], first), session);
  closeSession([session], session.id, "missing");
  sessionId(first);
  assert.equal(sourceReads, readsAfterInitialIdentity, "ordinary tab interactions must reuse the stored signature");
});

test("store identity reads every source through bounded four MiB slices", async () => {
  const bytes = new Uint8Array(STORE_IDENTITY_CHUNK_BYTES + 17).fill(0x41);
  const changedTail = bytes.slice();
  changedTail[changedTail.length - 1] = 0x42;
  const makeFile = (content, reads) => {
    const blob = new Blob([content]);
    return { size: blob.size, slice(start, end) { reads.push(end - start); return blob.slice(start, end); } };
  };
  const firstReads = [];
  const secondReads = [];
  const first = await buildStoreSignature([{ relativePath: "db-1.log", file: makeFile(bytes, firstReads) }], "4");
  const differentLastByte = await buildStoreSignature([{ relativePath: "db-1.log", file: makeFile(changedTail, secondReads) }], "4");
  assert.notEqual(first, differentLastByte, "a difference after the first four MiB must change identity");
  assert.deepEqual(firstReads, [STORE_IDENTITY_CHUNK_BYTES, 17]);
  assert.deepEqual(secondReads, [STORE_IDENTITY_CHUNK_BYTES, 17]);
  assert.ok([...firstReads, ...secondReads].every((size) => size <= STORE_IDENTITY_CHUNK_BYTES));
});

test("store identity has locale-independent canonical ordering for non-ASCII paths", async () => {
  const first = { relativePath: "저널/é.log", file: new Blob(["one"]) };
  const second = { relativePath: "저널/가.log", file: new Blob(["two"]) };
  const ordered = await buildStoreSignature([first, second], "4");
  const reversed = await buildStoreSignature([second, first], "4");
  assert.equal(ordered, reversed);
});

test("identity worker wrapper removes listeners, terminates on completion, and ignores stale callbacks", async () => {
  const fake = {
    onmessage: null,
    onerror: null,
    terminated: 0,
    sent: [],
    postMessage(message) { this.sent.push(message); },
    terminate() { this.terminated += 1; },
  };
  const promise = buildStoreSignatureInWorker([], "4", { createWorker: () => fake });
  const requestId = fake.sent[0].requestId;
  const callback = fake.onmessage;
  callback({ data: { type: "complete", requestId, signature: "4:content-sha256:ok" } });
  assert.equal(await promise, "4:content-sha256:ok");
  assert.equal(fake.terminated, 1);
  assert.equal(fake.onmessage, null);
  assert.equal(fake.onerror, null);
  callback({ data: { type: "complete", requestId, signature: "stale" } });
  assert.equal(fake.terminated, 1, "late callbacks must be inert after cleanup");
});

test("identity worker wrapper aborts and cleans the worker before stale completion", async () => {
  const controller = new AbortController();
  const fake = {
    onmessage: null,
    onerror: null,
    terminated: 0,
    sent: [],
    postMessage(message) { this.sent.push(message); },
    terminate() { this.terminated += 1; },
  };
  const promise = buildStoreSignatureInWorker([], "4", { signal: controller.signal, createWorker: () => fake });
  const staleCallback = fake.onmessage;
  controller.abort();
  await assert.rejects(promise, (error) => error?.name === "AbortError");
  assert.deepEqual(fake.sent.map((message) => message.type), ["identify", "cancel"]);
  assert.equal(fake.terminated, 1);
  assert.equal(fake.onmessage, null);
  staleCallback({ data: { type: "complete", requestId: fake.sent[0].requestId, signature: "stale" } });
  assert.equal(fake.terminated, 1);
});

test("identity worker wrapper cleans up when request cloning fails", async () => {
  const fake = {
    onmessage: null,
    onerror: null,
    terminated: 0,
    postMessage() { throw new DOMException("not cloneable", "DataCloneError"); },
    terminate() { this.terminated += 1; },
  };
  await assert.rejects(buildStoreSignatureInWorker([], "4", { createWorker: () => fake }), (error) => error?.name === "DataCloneError");
  assert.equal(fake.terminated, 1);
  assert.equal(fake.onmessage, null);
  assert.equal(fake.onerror, null);
});

test("signature reservation rejects duplicate-open races and stale generations", () => {
  const registry = new SignatureReservationRegistry();
  const first = registry.reserve("sig");
  const raced = registry.reserve("sig");
  assert.equal(first.accepted, true);
  assert.deepEqual(raced, { accepted: false, token: first.token });
  registry.release("sig", first.token);
  const reopened = registry.reserve("sig");
  assert.equal(reopened.accepted, true);
  assert.equal(registry.isCurrent("sig", first.token), false);
  assert.equal(registry.isCurrent("sig", reopened.token), true);
});

test("a closed scan generation cannot apply a delayed completion or cache write", async () => {
  const registry = new SignatureReservationRegistry();
  const first = registry.reserve("sig");
  let releaseBarrier;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  const effects = [];
  const delayed = (async () => { await barrier; if (registry.isCurrent("sig", first.token)) effects.push("state", "cache"); })();
  registry.release("sig", first.token);
  const reopened = registry.reserve("sig");
  releaseBarrier();
  await delayed;
  assert.deepEqual(effects, []);
  assert.equal(registry.isCurrent("sig", reopened.token), true);
});

test("cache writes are serialized per signature and the newest generation wins", async () => {
  let currentGeneration = "old";
  let releaseOld;
  let markOldStarted;
  const oldBarrier = new Promise((resolve) => { releaseOld = resolve; });
  const oldStarted = new Promise((resolve) => { markOldStarted = resolve; });
  const persisted = [];
  const oldWrite = enqueueScanCacheWrite("sig", "old", (_signature, generation) => generation === currentGeneration, async () => {
    markOldStarted();
    await oldBarrier;
    persisted.push("old");
  });
  await oldStarted;
  currentGeneration = "new";
  const newWrite = enqueueScanCacheWrite("sig", "new", (_signature, generation) => generation === currentGeneration, async () => { persisted.push("new"); });
  releaseOld();
  assert.equal(await oldWrite, true);
  assert.equal(await newWrite, true);
  assert.deepEqual(persisted, ["old", "new"]);

  const staleWrite = await enqueueScanCacheWrite("sig", "stale", (_signature, generation) => generation === currentGeneration, async () => { persisted.push("stale"); });
  assert.equal(staleWrite, false);
  assert.deepEqual(persisted, ["old", "new"]);
});

test("IndexedDB v0.2 cache is invalidated for v0.3 while incident cases are preserved", () => {
  const names = new Set(["scan-results", "workbench-state", "incident-cases"]);
  const operations = [];
  const database = {
    objectStoreNames: { [Symbol.iterator]: () => names[Symbol.iterator]() },
    createObjectStore(name) { names.add(name); operations.push(`create:${name}`); return {}; },
  };
  const transaction = {
    objectStore(name) {
      return {
        clear() { operations.push(`clear:${name}`); },
        put(value) { operations.push(`put:${name}:${value.version}`); },
      };
    },
  };
  assert.deepEqual(planDatabaseMigration(1), {
    from: 1,
    to: CACHE_SCHEMA_VERSION,
    invalidateScanResults: true,
    invalidateWorkbenchState: true,
    preserveIncidentCases: true,
  });
  applyDatabaseUpgrade(database, transaction, 1);
  assert.deepEqual(operations, [
    "create:schema-meta",
    "clear:scan-results",
    "clear:workbench-state",
    `put:schema-meta:${CACHE_SCHEMA_VERSION}`,
  ]);
  assert.ok(!operations.includes("clear:incident-cases"));

  operations.length = 0;
  applyDatabaseUpgrade(database, transaction, CACHE_SCHEMA_VERSION);
  assert.deepEqual(operations, [`put:schema-meta:${CACHE_SCHEMA_VERSION}`], "reopening the current schema must be idempotent");
});

test("session resource cleanup releases every registered resource exactly once", () => {
  const calls = [];
  const worker = { onmessage: () => {}, onerror: () => {}, terminate: () => calls.push("worker") };
  const controller = { abort: () => calls.push("controller") };
  const ledger = new SessionResourceLedger();
  ledger.add("s", { kind: "worker", value: worker });
  ledger.add("s", { kind: "controller", value: controller });
  ledger.add("s", { kind: "listener", remove: () => calls.push("listener") });
  ledger.add("s", { kind: "timer", value: 1, clear: () => calls.push("timer") });
  ledger.add("s", { kind: "object-url", value: "blob:x", revoke: () => calls.push("url") });
  ledger.cleanup("s"); ledger.cleanup("s");
  assert.deepEqual(calls.sort(), ["controller", "listener", "timer", "url", "worker"]);
  assert.equal(worker.onmessage, null); assert.equal(worker.onerror, null); assert.equal(ledger.count("s"), 0);
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
  assert.ok(restored.every((session) => session.sourceAccess === "cached-only"));
});

test("cached analysis remains usable when source permission is unavailable", () => {
  const capabilities = getSessionCapabilities({ result: { signature: "sig" }, sourceAccess: "cached-only" });
  assert.equal(capabilities.cachedAnalysis, true);
  assert.equal(capabilities.compare, true);
  assert.equal(capabilities.incidentCase, true);
  assert.equal(capabilities.exportDerivedEvidence, true);
  assert.equal(capabilities.rescanSource, false);
  assert.equal(capabilities.verifySourceIntegrity, false);
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
  later.structured.records.push({ command: "KahaAddMessageCommand", destination: { name: "ORDERS" }, messageId: "ID:2" });
  const first = buildSnapshotDiff(base, later);
  assert.deepEqual(first, buildSnapshotDiff(base, later));
  assert.ok(first.some((row) => row.status === "not-observed-left" && row.key.includes("PRICES")));
  assert.ok(first.some((row) => row.category === "summary" && row.key === "destination:raw-occurrences" && row.delta === 2));
  assert.ok(first.every((row) => !row.status.includes("removed")));
});

test("snapshot identity ignores provenance and separates raw from unique semantic counts", () => {
  const left = { destinations: [], subscriptions: [], structured: { records: [{ file: "db-1.log", location: { offset: 1 }, messageId: "ID:1" }, { file: "db-2.log", location: { offset: 999 }, messageId: "ID:1" }] } };
  const right = { destinations: [], subscriptions: [], structured: { records: [{ file: "other.log", location: { offset: 44 }, messageId: "ID:1" }] } };
  const rows = buildSnapshotDiff(left, right);
  assert.ok(rows.some((row) => row.category === "message" && row.key === "ID:1" && row.leftValue === 2 && row.rightValue === 1));
  assert.ok(rows.some((row) => row.key === "message:raw-occurrences" && row.leftValue === 2 && row.rightValue === 1));
  assert.ok(!rows.some((row) => row.key === "message:unique-entities"));
  assert.ok(rows.every((row) => !row.id.includes("db-") && !row.id.includes("offset")));
});

test("incident cases keep explicit user notes and de-duplicate pinned evidence", () => {
  const created = createIncidentCase("2026-01-01T00:00:00.000Z", "case-1");
  const noted = addCaseNote(created, "Check the reconnect sequence", "2026-01-01T00:01:00.000Z", "note-1");
  const pin = { id: "evidence-1", semanticKey: "message:ID:1", storeSignature: "sig", storeName: "store-a", kind: "message", label: "ORDERS", provenance: { file: "db-1.log", offset: 12 }, confidence: "Parsed" };
  const pinned = addCasePin(noted, pin, "2026-01-01T00:02:00.000Z");
  assert.equal(pinned.notes[0].text, "Check the reconnect sequence");
  assert.equal(addCasePin(pinned, pin).pins.length, 1);
});

test("case references resolve by store signature and semantic key, not session ID", () => {
  const pin = { storeSignature: "sig", semanticKey: "message:ID:1" };
  const result = { signature: "sig", structured: { records: [{ messageId: "ID:1" }] }, destinations: [], subscriptions: [], messages: [], correlation: { links: [] }, strings: [], files: [] };
  assert.deepEqual(resolveCasePin(pin, [result]), { status: "resolved", reason: "semantic-key-observed" });
  assert.deepEqual(resolveCasePin(pin, []), { status: "unresolved", reason: "store-not-open" });
  assert.deepEqual(resolveCasePin({ ...pin, semanticKey: "message:ID:missing" }, [result]), { status: "unresolved", reason: "semantic-key-not-observed" });
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
  assert.equal(rows[0].sequence, "filename-derived-id");
  assert.equal(rows[1].observation, "no-structured-observation");
});

test("evidence timeline uses deterministic file and offset order without timestamps", () => {
  const result = { structured: { records: [
    { file: "db-2.log", location: { dataFileId: 2, offset: 4 }, command: "Second", status: "Parsed", confidence: "Parsed" },
    { file: "db-1.log", location: { dataFileId: 1, offset: 40 }, command: "Later", status: "Parsed", confidence: "Parsed" },
    { file: "db-1.log", location: { dataFileId: 1, offset: 8 }, command: "First", status: "Partial", confidence: "Parsed" },
  ] } };
  const timeline = buildEvidenceTimeline(result, 10);
  assert.deepEqual(timeline.events.filter((event) => event.file === "db-1.log").map((event) => event.command), ["First", "Later"]);
  assert.deepEqual(timeline.events.filter((event) => event.file === "db-2.log").map((event) => event.command), ["Second"]);
  assert.equal(timeline.truncated, false);
  assert.equal(timeline.ordering, "per-journal-offset");
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
