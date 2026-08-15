export const MAX_STORE_SESSIONS = 6;

export { buildContentStoreSignature as buildStoreSignature } from "../../public/store-identity.js";

let identityRequestSequence = 0;

export function buildStoreSignatureInWorker(files, scannerVersion = "4", options = {}) {
  const signal = options.signal;
  const createWorker = options.createWorker ?? (() => new Worker("/store-identity.worker.js", { type: "module" }));
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException("Store identity calculation was cancelled.", "AbortError"));
  const worker = createWorker();
  const requestId = `identity-${++identityRequestSequence}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      try { worker.postMessage({ type: "cancel", requestId }); } catch { /* worker may already be gone */ }
      finish(() => reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Store identity calculation was cancelled.", "AbortError")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event) => {
      if (event.data?.requestId !== requestId || settled) return;
      if (event.data.type === "progress") {
        try { options.onProgress?.(event.data); } catch (error) { finish(() => reject(error)); }
      }
      else if (event.data.type === "complete") finish(() => resolve(event.data.signature));
      else if (event.data.type === "cancelled") finish(() => reject(new DOMException("Store identity calculation was cancelled.", "AbortError")));
      else if (event.data.type === "error") finish(() => reject(new Error(event.data.message)));
    };
    worker.onerror = (event) => finish(() => reject(new Error(event.message || "Store identity worker failed.")));
    try { worker.postMessage({ type: "identify", requestId, files, scannerVersion, reportProgress: Boolean(options.onProgress) }); }
    catch (error) { finish(() => reject(error)); }
  });
}

export class SignatureReservationRegistry {
  #entries = new Map();
  #next = 0;
  reserve(signature) {
    const current = this.#entries.get(signature);
    if (current) return { accepted: false, token: current };
    const token = `${signature}:${++this.#next}`;
    this.#entries.set(signature, token);
    return { accepted: true, token };
  }
  isCurrent(signature, token) { return this.#entries.get(signature) === token; }
  release(signature, token) { if (this.isCurrent(signature, token)) this.#entries.delete(signature); }
  get size() { return this.#entries.size; }
}

export class SessionResourceLedger {
  #entries = new Map();
  add(sessionId, resource) {
    if (!this.#entries.has(sessionId)) this.#entries.set(sessionId, []);
    this.#entries.get(sessionId).push(resource);
  }
  cleanup(sessionId) {
    const resources = this.#entries.get(sessionId) ?? [];
    this.#entries.delete(sessionId);
    for (const resource of resources.reverse()) {
      if (resource.kind === "worker") { resource.value.onmessage = null; resource.value.onerror = null; resource.value.terminate(); }
      else if (resource.kind === "controller") resource.value.abort();
      else if (resource.kind === "listener") resource.remove();
      else if (resource.kind === "timer") resource.clear(resource.value);
      else if (resource.kind === "object-url") resource.revoke(resource.value);
    }
  }
  cleanupAll() { for (const id of [...this.#entries.keys()]) this.cleanup(id); }
  count(sessionId) { return (this.#entries.get(sessionId) ?? []).length; }
}

export function sessionId(signature) {
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `store-${(hash >>> 0).toString(16)}`;
}

export function findReusableSession(sessions, signature) {
  return sessions.find((session) => session.signature === signature) ?? null;
}

export function closeSession(sessions, activeSessionId, closingId) {
  const index = sessions.findIndex((session) => session.id === closingId);
  if (index < 0) return { sessions, activeSessionId };
  const next = sessions.filter((session) => session.id !== closingId);
  if (activeSessionId !== closingId) return { sessions: next, activeSessionId };
  return {
    sessions: next,
    activeSessionId: next[Math.min(index, next.length - 1)]?.id ?? null,
  };
}

export function restoreSessions(state) {
  if (!state || !Array.isArray(state.sessions)) return [];
  return state.sessions.slice(0, MAX_STORE_SESSIONS).filter((session) =>
    session && typeof session.id === "string" && session.result && session.signature,
  ).map((session) => ({
    ...session,
    status: "ready",
    progress: null,
    error: "",
    restored: true,
    sourceAccess: "cached-only",
  }));
}

export function getSessionCapabilities(session) {
  const sourceGranted = session?.sourceAccess === "granted";
  return { cachedAnalysis: Boolean(session?.result), compare: Boolean(session?.result), incidentCase: Boolean(session?.result), exportDerivedEvidence: Boolean(session?.result), rescanSource: sourceGranted, verifySourceIntegrity: sourceGranted };
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

export const DIFF_IDENTITY_RULES = Object.freeze({
  destination: "destination-type-and-qualified-name",
  subscription: "subscription-key-or-raw-consumer-id",
  message: "message-id",
  transaction: "transaction-id",
});

export function collectSnapshotFacts(result) {
  const entities = new Map();
  const rawOccurrences = new Map();
  for (const item of result?.destinations ?? []) {
    const key = `destination\u0000${item.type}:${item.name}`;
    increment(entities, key, item.occurrences ?? 1); increment(rawOccurrences, "destination", item.occurrences ?? 1);
  }
  for (const item of result?.subscriptions ?? []) {
    const key = `subscription\u0000${item.rawId}`;
    increment(entities, key, item.occurrences ?? 1); increment(rawOccurrences, "subscription", item.occurrences ?? 1);
  }
  for (const record of result?.structured?.records ?? []) {
    const observations = [["message", record.messageId], ["subscription", record.subscriptionKey], ["transaction", record.transactionId]];
    for (const [category, semanticId] of observations) if (semanticId) { increment(entities, `${category}\u0000${semanticId}`); increment(rawOccurrences, category); }
  }
  const uniqueCounts = new Map();
  for (const compound of entities.keys()) increment(uniqueCounts, compound.split("\u0000")[0]);
  return { entities, rawOccurrences, uniqueCounts };
}

export function buildSnapshotDiff(left, right) {
  const a = collectSnapshotFacts(left);
  const b = collectSnapshotFacts(right);
  const keys = [...new Set([...a.entities.keys(), ...b.entities.keys()])].sort((x, y) => x.localeCompare(y));
  const entityRows = keys.flatMap((compound) => {
    const [category, key] = compound.split("\u0000");
    const leftObserved = a.entities.has(compound);
    const rightObserved = b.entities.has(compound);
    const leftValue = a.entities.get(compound) ?? null;
    const rightValue = b.entities.get(compound) ?? null;
    if (leftObserved && rightObserved && leftValue === rightValue) return [];
    return [{
      id: `${category}:${key}`,
      category,
      key,
      leftValue,
      rightValue,
      delta: typeof leftValue === "number" && typeof rightValue === "number" ? rightValue - leftValue : null,
      status: !leftObserved ? "not-observed-left" : !rightObserved ? "not-observed-right" : "changed",
      identityRule: DIFF_IDENTITY_RULES[category],
      metric: "semantic-entity-occurrences",
    }];
  });
  const summaryRows = [];
  for (const category of Object.keys(DIFF_IDENTITY_RULES)) {
    for (const [metric, leftMap, rightMap] of [["raw-occurrences", a.rawOccurrences, b.rawOccurrences], ["unique-entities", a.uniqueCounts, b.uniqueCounts]]) {
      const leftValue = leftMap.get(category) ?? 0; const rightValue = rightMap.get(category) ?? 0;
      if (leftValue !== rightValue) summaryRows.push({ id: `summary:${category}:${metric}`, category: "summary", key: `${category}:${metric}`, leftValue, rightValue, delta: rightValue - leftValue, status: "changed", identityRule: DIFF_IDENTITY_RULES[category], metric });
    }
  }
  return [...entityRows, ...summaryRows];
}

export const LEAD_THRESHOLDS = Object.freeze({ advisoryObservations: 10, unknownRecords: 5, journalConcentrationPercent: 60, journalConcentrationMinimum: 10 });

export function createIncidentCase(now = new Date().toISOString(), id = `case-${Date.now().toString(36)}`, storeSignature = "", storeName = "") {
  return { id, storeSignature, storeName, title: "", hypothesis: "", notes: [], pins: [], createdAt: now, updatedAt: now };
}

export function addCasePin(incident, pin, now = new Date().toISOString()) {
  if (incident.pins.some((item) => item.semanticKey === pin.semanticKey && item.storeSignature === pin.storeSignature && item.provenance?.file === pin.provenance?.file && item.provenance?.offset === pin.provenance?.offset)) return incident;
  return { ...incident, pins: [...incident.pins, { ...pin, pinnedAt: now }], updatedAt: now };
}

export function addCaseNote(incident, text, now = new Date().toISOString(), id = `note-${Date.now().toString(36)}`) {
  const trimmed = String(text).trim();
  if (!trimmed) return incident;
  return { ...incident, notes: [...incident.notes, { id, text: trimmed, createdAt: now }], updatedAt: now };
}

export function removeCasePin(incident, target, now = new Date().toISOString()) {
  const samePin = (pin) => typeof target === "string"
    ? pin.semanticKey === target
    : pin.storeSignature === target.storeSignature
      && pin.semanticKey === target.semanticKey
      && pin.provenance?.file === target.provenance?.file
      && pin.provenance?.offset === target.provenance?.offset;
  return { ...incident, pins: incident.pins.filter((pin) => !samePin(pin)), updatedAt: now };
}

export function removeCaseNote(incident, noteId, now = new Date().toISOString()) {
  return { ...incident, notes: incident.notes.filter((note) => note.id !== noteId), updatedAt: now };
}

export function scopeIncidentCases(cases, storeSignature) {
  return (cases ?? []).map((incident) => {
    const pins = (incident.pins ?? []).map((pin) => ({
      ...pin,
      semanticKey: pin.semanticKey ?? `legacy:${pin.id}`,
      provenance: pin.provenance ?? { file: pin.file ?? "", offset: pin.offset ?? null },
    }));
    const scopedSignature = incident.storeSignature ?? pins[0]?.storeSignature ?? "";
    return { ...incident, storeSignature: scopedSignature, storeName: incident.storeName ?? pins[0]?.storeName ?? "", pins: storeSignature ? pins.filter((pin) => pin.storeSignature === storeSignature) : pins };
  }).filter((incident) => !storeSignature || incident.storeSignature === storeSignature).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function normalizeMessageId(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length < 3 || trimmed.length > 512 || /[\s\p{Cc}]/u.test(trimmed)) return "";
  return trimmed;
}

function containsExactObservedId(value, messageId) {
  const isConservativeBoundary = (character) => !character || /[\s=,;()[\]{}"'<>]/u.test(character);
  let from = 0;
  while (from <= value.length) {
    const index = value.indexOf(messageId, from);
    if (index < 0) return false;
    const before = index > 0 ? value[index - 1] : "";
    const after = value[index + messageId.length] ?? "";
    if (isConservativeBoundary(before) && isConservativeBoundary(after)) return true;
    from = index + 1;
  }
  return false;
}

function traceEvidenceType(record) {
  if (/AddMessage|ADD_MESSAGE/i.test(record.command)) return "ADD";
  if (/RemoveMessage|REMOVE_MESSAGE|Ack/i.test(record.command)) return "ACK_REMOVE";
  if (/Transaction|Commit|Rollback|Prepare|COMMIT_COMMAND|ROLLBACK_COMMAND|PREPARE_COMMAND/i.test(record.command) || record.transactionId) return "TRANSACTION";
  if (/Subscription/i.test(record.command) || record.subscriptionKey) return "SUBSCRIPTION_RELATED";
  return "UNKNOWN";
}

export function traceMessageEvidence(results, requestedMessageId) {
  const messageId = normalizeMessageId(requestedMessageId);
  if (!messageId) return null;
  const storeRefs = [];
  for (const result of results ?? []) {
    if (!result?.signature) continue;
    const evidence = [];
    const seen = new Set();
    const transactions = new Set();
    const add = (item) => {
      if (seen.has(item.evidenceRef)) return;
      seen.add(item.evidenceRef);
      evidence.push(item);
    };
    for (const record of result.structured?.records ?? []) {
      if (record.messageId !== messageId) continue;
      if (record.transactionId) transactions.add(record.transactionId);
      add({
        evidenceType: traceEvidenceType(record), messageId,
        destination: record.destination?.name, transactionId: record.transactionId,
        sourceFile: record.file, offset: record.location?.offset, recordId: `parsed:${record.file}:${record.location?.offset ?? -1}`,
        confidence: record.confidence ?? "Unknown", snapshotLabel: result.directoryName,
        evidenceRef: `parsed:${record.file}:${record.location?.offset ?? -1}`,
      });
    }
    for (const record of result.structured?.records ?? []) {
      if (!record.transactionId || !transactions.has(record.transactionId) || record.messageId === messageId) continue;
      add({
        evidenceType: "TRANSACTION", messageId, destination: record.destination?.name, transactionId: record.transactionId,
        sourceFile: record.file, offset: record.location?.offset, recordId: `parsed:${record.file}:${record.location?.offset ?? -1}`,
        confidence: record.confidence ?? "Unknown", snapshotLabel: result.directoryName,
        evidenceRef: `transaction:${record.file}:${record.location?.offset ?? -1}`,
      });
    }
    for (const candidate of result.messages ?? []) {
      if (candidate.relatedId !== messageId) continue;
      add({ evidenceType: "RAW_OBSERVATION", messageId, destination: candidate.destination, sourceFile: candidate.journal, offset: candidate.offset, confidence: candidate.confidence ?? "Observed", snapshotLabel: result.directoryName, evidenceRef: `candidate:${candidate.id}` });
    }
    for (const raw of result.strings ?? []) {
      if (!containsExactObservedId(raw.value, messageId)) continue;
      add({ evidenceType: "RAW_OBSERVATION", messageId, sourceFile: raw.file, offset: raw.offset, confidence: raw.confidence ?? "Observed", snapshotLabel: result.directoryName, evidenceRef: `raw:${raw.id}` });
    }
    evidence.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || (a.offset ?? Number.MAX_SAFE_INTEGER) - (b.offset ?? Number.MAX_SAFE_INTEGER) || a.evidenceRef.localeCompare(b.evidenceRef));
    storeRefs.push({ storeSignature: result.signature, storeName: result.directoryName, evidence });
  }
  const all = storeRefs.flatMap((store) => store.evidence);
  return {
    messageId,
    storeRefs,
    summary: {
      totalEvidence: all.length,
      addRecords: all.filter((item) => item.evidenceType === "ADD").length,
      ackRemoveRecords: all.filter((item) => item.evidenceType === "ACK_REMOVE").length,
      transactionRecords: all.filter((item) => item.evidenceType === "TRANSACTION").length,
      destinationCount: new Set(all.map((item) => item.destination).filter(Boolean)).size,
      journalCount: new Set(storeRefs.flatMap((store) => store.evidence.map((item) => `${store.storeSignature}:${item.sourceFile}`))).size,
      snapshotCount: storeRefs.filter((store) => store.evidence.length).length,
    },
    interpretationLimits: ["no-duplicate-delivery-proof", "no-application-processing-proof", "no-current-broker-state", "no-redelivery-cause", "no-root-cause"],
  };
}

export function buildInvestigativeLeads(result, thresholds = LEAD_THRESHOLDS) {
  const leads = [];
  const advisory = Number(result?.totals?.advisoryRecords) || 0;
  if (advisory >= thresholds.advisoryObservations) leads.push({ code: "advisory-volume", whyCode: "advisory-volume", notProveCode: "advisory-volume", observed: advisory, threshold: thresholds.advisoryObservations });
  const unknown = (result?.structured?.records ?? []).filter((record) => record.status === "Unknown" || record.status === "Partial" || record.status === "Unsupported").length;
  if (unknown >= thresholds.unknownRecords) leads.push({ code: "unresolved-records", whyCode: "unresolved-records", notProveCode: "unresolved-records", observed: unknown, threshold: thresholds.unknownRecords });
  const journalCounts = new Map();
  for (const record of result?.structured?.records ?? []) increment(journalCounts, record.file);
  const total = [...journalCounts.values()].reduce((sum, count) => sum + count, 0);
  const top = [...journalCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const percent = top && total ? Math.round((top[1] / total) * 100) : 0;
  if (top && total >= thresholds.journalConcentrationMinimum && percent >= thresholds.journalConcentrationPercent) {
    leads.push({ code: "journal-concentration", whyCode: "journal-concentration", notProveCode: "journal-concentration", observed: percent, threshold: thresholds.journalConcentrationPercent, detail: top[0] });
  }
  return leads;
}

function journalFileId(path) {
  const match = /(?:^|\/)db-(\d+)\.log$/i.exec(path);
  return match ? Number(match[1]) : null;
}

export function buildJournalRetentionIndex(result) {
  const recordsByFile = new Map();
  for (const record of result?.structured?.records ?? []) {
    if (!recordsByFile.has(record.file)) recordsByFile.set(record.file, []);
    recordsByFile.get(record.file).push(record);
  }
  const refsByFile = new Map();
  for (const link of result?.correlation?.links ?? []) {
    for (const ref of link.evidenceRefs ?? []) {
      if (!ref.file) continue;
      if (!refsByFile.has(ref.file)) refsByFile.set(ref.file, new Map());
      refsByFile.get(ref.file).set(ref.id, ref);
    }
  }
  const journals = (result?.files ?? []).filter((file) => file.kind === "journal" || /db-\d+\.log$/i.test(file.path));
  return journals.map((file) => {
    const records = [...(recordsByFile.get(file.path) ?? recordsByFile.get(file.name) ?? [])].sort((a, b) => a.location.offset - b.location.offset);
    const refs = [...(refsByFile.get(file.path)?.values() ?? refsByFile.get(file.name)?.values() ?? [])].sort((a, b) => (a.offset ?? -1) - (b.offset ?? -1) || a.id.localeCompare(b.id));
    const destinations = [...new Set(records.map((record) => record.destination?.name).filter(Boolean))].sort();
    const commands = [...new Set(records.map((record) => record.command).filter(Boolean))].sort();
    const fileId = journalFileId(file.path);
    return {
      id: file.path,
      path: file.path,
      fileId,
      size: file.size,
      modified: file.modified,
      recordCount: records.length,
      referenceCount: refs.length,
      firstOffset: records[0]?.location.offset ?? null,
      lastOffset: records.at(-1)?.location.offset ?? null,
      destinations,
      commands,
      references: refs,
      sequence: fileId === null ? "unknown-order" : "filename-derived-id",
      observation: refs.length ? "references-observed" : records.length ? "records-observed" : "no-structured-observation",
    };
  }).sort((a, b) => (a.fileId ?? Number.MAX_SAFE_INTEGER) - (b.fileId ?? Number.MAX_SAFE_INTEGER) || a.path.localeCompare(b.path));
}

export const MAX_TIMELINE_EVENTS = 10_000;

export function buildEvidenceTimeline(result, limit = MAX_TIMELINE_EVENTS) {
  const records = (result?.structured?.records ?? []).map((record, index) => ({
    id: `${record.file}:${record.location?.offset ?? -1}:${index}`,
    file: record.file,
    dataFileId: record.location?.dataFileId ?? journalFileId(record.file),
    offset: record.location?.offset ?? null,
    command: record.command || "Unknown",
    category: record.subscriptionKey ? "subscription" : record.transactionId ? "transaction" : record.messageId ? "message" : "record",
    destination: record.destination?.name ?? "Unknown",
    primaryId: record.messageId ?? record.subscriptionKey ?? record.transactionId ?? "Unknown",
    status: record.status ?? "Unknown",
    confidence: record.confidence ?? "Unknown",
  }));
  const groups = new Map();
  for (const record of records) { if (!groups.has(record.file)) groups.set(record.file, []); groups.get(record.file).push(record); }
  const events = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, items]) => items.sort((a, b) => (a.offset ?? Number.MAX_SAFE_INTEGER) - (b.offset ?? Number.MAX_SAFE_INTEGER) || a.command.localeCompare(b.command) || a.id.localeCompare(b.id)));
  return { events: events.slice(0, Math.max(0, limit)), total: events.length, truncated: events.length > limit, ordering: "per-journal-offset" };
}

export function semanticEvidenceKeys(result) {
  const keys = new Set();
  for (const item of result?.destinations ?? []) keys.add(`destination:${item.type}:${item.name}`);
  for (const item of result?.subscriptions ?? []) keys.add(`subscription:${item.rawId}`);
  for (const item of result?.messages ?? []) keys.add(`message:${item.relatedId !== "Unknown" ? item.relatedId : `${item.destination}:${item.detectedType}:${item.operation}`}`);
  for (const item of result?.correlation?.links ?? []) keys.add(`correlation:${item.kind}:${item.primaryId}`);
  for (const item of result?.structured?.records ?? []) keys.add(item.messageId ? `message:${item.messageId}` : item.subscriptionKey ? `subscription:${item.subscriptionKey}` : item.transactionId ? `transaction:${item.transactionId}` : `record:${item.command}:${item.destination?.name ?? "Unknown"}`);
  for (const item of result?.strings ?? []) keys.add(`raw-string:${item.value}`);
  for (const item of result?.files ?? []) keys.add(`source-file:${item.path}`);
  return keys;
}

export function resolveCasePin(pin, results) {
  const store = results.find((result) => result.signature === pin.storeSignature);
  if (!store) return { status: "unresolved", reason: "store-not-open" };
  return semanticEvidenceKeys(store).has(pin.semanticKey) ? { status: "resolved", reason: "semantic-key-observed" } : { status: "unresolved", reason: "semantic-key-not-observed" };
}

const encoder = new TextEncoder();

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value), null, 2);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks) {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function zipHeader(size, signature) {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, signature, true);
  return { bytes, view: new DataView(bytes.buffer) };
}

export function buildStoredZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const checksum = crc32(data);
    const localHeader = zipHeader(30, 0x04034b50);
    localHeader.view.setUint16(4, 20, true); localHeader.view.setUint16(6, 0x0800, true); localHeader.view.setUint16(8, 0, true);
    localHeader.view.setUint16(10, 0, true); localHeader.view.setUint16(12, 33, true); localHeader.view.setUint32(14, checksum, true);
    localHeader.view.setUint32(18, data.length, true); localHeader.view.setUint32(22, data.length, true); localHeader.view.setUint16(26, name.length, true);
    const localPart = concatBytes([localHeader.bytes, name, data]);
    local.push(localPart);
    const centralHeader = zipHeader(46, 0x02014b50);
    centralHeader.view.setUint16(4, 20, true); centralHeader.view.setUint16(6, 20, true); centralHeader.view.setUint16(8, 0x0800, true); centralHeader.view.setUint16(10, 0, true);
    centralHeader.view.setUint16(12, 0, true); centralHeader.view.setUint16(14, 33, true); centralHeader.view.setUint32(16, checksum, true);
    centralHeader.view.setUint32(20, data.length, true); centralHeader.view.setUint32(24, data.length, true); centralHeader.view.setUint16(28, name.length, true); centralHeader.view.setUint32(42, offset, true);
    central.push(concatBytes([centralHeader.bytes, name]));
    offset += localPart.length;
  }
  const centralBytes = concatBytes(central);
  const end = zipHeader(22, 0x06054b50);
  end.view.setUint16(8, sorted.length, true); end.view.setUint16(10, sorted.length, true); end.view.setUint32(12, centralBytes.length, true); end.view.setUint32(16, offset, true);
  return concatBytes([...local, centralBytes, end.bytes]);
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeRedactor(options) {
  const maps = { identifier: new Map(), destination: new Map(), file: new Map() };
  const alias = (type, value) => {
    if (typeof value !== "string" || !value) return value;
    const map = maps[type];
    if (!map.has(value)) map.set(value, `${type.toUpperCase()}-${String(map.size + 1).padStart(3, "0")}`);
    return map.get(value);
  };
  const visit = (value, key = "") => {
    if (Array.isArray(value)) return value.map((item) => visit(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((child) => [child, visit(value[child], child)]));
    if (options.filePaths && /file|path|journal|source|relatedStore/i.test(key)) return alias("file", value);
    if (options.identifiers && /(^id$|Id$|signature|primaryId|rawId|connection|consumer|transaction|subscriptionKey|messageId)/i.test(key)) return alias("identifier", value);
    if (options.destinations && /destination|decodedName|rawName/i.test(key)) return alias("destination", value);
    return value;
  };
  return { visit, maps };
}

function htmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function bundleReport(payload, locale) {
  const ko = locale === "ko";
  const rows = payload.timeline.events.slice(0, 500).map((event) => `<tr><td>${htmlEscape(event.file)}</td><td>${event.offset ?? "—"}</td><td>${htmlEscape(event.command)}</td><td>${htmlEscape(event.destination)}</td><td>${htmlEscape(event.status)}</td></tr>`).join("");
  return `<!doctype html><html lang="${ko ? "ko" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MQ Watcher Evidence Bundle</title><style>body{font:14px system-ui;margin:32px;color:#172033}h1{font-size:24px}p{color:#526079;line-height:1.6}.card{border:1px solid #dfe5ef;border-radius:10px;padding:16px;margin:14px 0}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:8px;border-bottom:1px solid #e5e9f0;text-align:left}code{font-family:Consolas,monospace}</style><h1>MQ Watcher Evidence Bundle</h1><p>${ko ? "이 보고서는 읽기 전용 분석에서 파생된 메타데이터입니다. 현재 브로커 상태나 자동 원인 판정을 나타내지 않습니다." : "This report contains metadata derived by read-only analysis. It does not assert current broker state or an automated root cause."}</p><div class="card"><strong>${ko ? "저장소" : "Store"}</strong><p>${htmlEscape(payload.store.directoryName)} · ${htmlEscape(payload.store.storeKind)}</p><code>${htmlEscape(payload.store.signature)}</code></div><h2>${ko ? "증거 순서" : "Evidence order"}</h2><p>${ko ? "파일 ID와 오프셋 순서이며 기록 시각이 아닙니다." : "Ordered by file ID and offset; this is not event time."}</p><table><thead><tr><th>File</th><th>Offset</th><th>Command</th><th>Destination</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></html>`;
}

export async function buildEvidenceBundle({ result, incidentCase = null, comparison = [], messageTrace = null, locale = "en", redaction = {}, generatedAt = new Date().toISOString() }) {
  const redactor = makeRedactor({ identifiers: Boolean(redaction.identifiers), destinations: Boolean(redaction.destinations), filePaths: Boolean(redaction.filePaths) });
  const caseValue = incidentCase ? { ...incidentCase, notes: redaction.notes ? [] : incidentCase.notes } : null;
  const rawPayload = {
    format: "mq-watcher-evidence-bundle-v1",
    generatedAt,
    limitations: ["derived-metadata-only", "no-current-broker-state-assertion", "no-automatic-root-cause"],
    store: { signature: result.signature, directoryName: result.directoryName, storeKind: result.storeKind, totals: result.totals, warnings: result.warnings },
    destinations: result.destinations,
    subscriptions: result.subscriptions,
    structuredRecords: result.structured.records,
    evidenceLinks: result.correlation.links,
    journals: buildJournalRetentionIndex(result),
    timeline: buildEvidenceTimeline(result),
    comparison,
    incidentCase: caseValue,
    messageTrace,
  };
  const payload = redactor.visit(rawPayload);
  const evidence = stableStringify(payload);
  const report = bundleReport(payload, locale);
  const readme = locale === "ko" ? "원본 Store 파일은 포함되지 않습니다. evidence.json과 report.html은 읽기 전용 분석에서 파생된 메타데이터입니다.\n" : "Original Store files are not included. evidence.json and report.html contain metadata derived by read-only analysis.\n";
  const files = [{ name: "evidence.json", data: evidence }, { name: "report.html", data: report }, { name: "README.txt", data: readme }];
  const sums = [];
  for (const file of files) sums.push(`${await sha256Hex(file.data)}  ${file.name}`);
  const manifest = stableStringify({ format: payload.format, generatedAt, entries: [...files.map((file) => file.name), "SHA256SUMS.txt"], redaction: { identifiers: Boolean(redaction.identifiers), destinations: Boolean(redaction.destinations), filePaths: Boolean(redaction.filePaths), notes: Boolean(redaction.notes) }, sourceFilesIncluded: false });
  files.push({ name: "manifest.json", data: manifest });
  sums.push(`${await sha256Hex(manifest)}  manifest.json`);
  files.push({ name: "SHA256SUMS.txt", data: `${sums.join("\n")}\n` });
  const bytes = buildStoredZip(files);
  return { bytes, sha256: await sha256Hex(bytes), manifest: JSON.parse(manifest), entryNames: files.map((file) => file.name).sort() };
}
