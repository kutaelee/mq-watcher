export const MAX_STORE_SESSIONS = 6;

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
  }));
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

export function collectSnapshotFacts(result) {
  const facts = new Map();
  for (const item of result?.destinations ?? []) {
    facts.set(`destination\u0000${item.type}:${item.name}`, item.occurrences ?? 1);
  }
  for (const item of result?.subscriptions ?? []) {
    facts.set(`subscription\u0000${item.rawId}`, item.occurrences ?? 1);
  }
  for (const record of result?.structured?.records ?? []) {
    const destination = record.destination?.name ?? "Unknown";
    increment(facts, `command\u0000${record.command}:${destination}`);
  }
  for (const item of result?.files ?? []) {
    facts.set(`journal-bytes\u0000${item.path}`, item.size ?? 0);
  }
  for (const [kind, value] of Object.entries(result?.correlation?.counts ?? {})) {
    facts.set(`correlation\u0000${kind}`, Number(value) || 0);
  }
  return facts;
}

export function buildSnapshotDiff(left, right) {
  const a = collectSnapshotFacts(left);
  const b = collectSnapshotFacts(right);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x.localeCompare(y));
  return keys.flatMap((compound) => {
    const [category, key] = compound.split("\u0000");
    const leftObserved = a.has(compound);
    const rightObserved = b.has(compound);
    const leftValue = a.get(compound) ?? null;
    const rightValue = b.get(compound) ?? null;
    if (leftObserved && rightObserved && leftValue === rightValue) return [];
    return [{
      id: `${category}:${key}`,
      category,
      key,
      leftValue,
      rightValue,
      delta: typeof leftValue === "number" && typeof rightValue === "number" ? rightValue - leftValue : null,
      status: !leftObserved ? "not-observed-left" : !rightObserved ? "not-observed-right" : "changed",
    }];
  });
}

export const LEAD_THRESHOLDS = Object.freeze({ advisoryObservations: 10, unknownRecords: 5, journalConcentrationPercent: 60, journalConcentrationMinimum: 10 });

export function createIncidentCase(now = new Date().toISOString(), id = `case-${Date.now().toString(36)}`) {
  return { id, title: "", hypothesis: "", notes: [], pins: [], createdAt: now, updatedAt: now };
}

export function addCasePin(incident, pin, now = new Date().toISOString()) {
  if (incident.pins.some((item) => item.id === pin.id && item.storeSignature === pin.storeSignature)) return incident;
  return { ...incident, pins: [...incident.pins, { ...pin, pinnedAt: now }], updatedAt: now };
}

export function addCaseNote(incident, text, now = new Date().toISOString(), id = `note-${Date.now().toString(36)}`) {
  const trimmed = String(text).trim();
  if (!trimmed) return incident;
  return { ...incident, notes: [...incident.notes, { id, text: trimmed, createdAt: now }], updatedAt: now };
}

export function buildInvestigativeLeads(result, thresholds = LEAD_THRESHOLDS) {
  const leads = [];
  const advisory = Number(result?.totals?.advisoryRecords) || 0;
  if (advisory >= thresholds.advisoryObservations) leads.push({ code: "advisory-volume", observed: advisory, threshold: thresholds.advisoryObservations });
  const unknown = (result?.structured?.records ?? []).filter((record) => record.status === "Unknown" || record.status === "Partial" || record.status === "Unsupported").length;
  if (unknown >= thresholds.unknownRecords) leads.push({ code: "unresolved-records", observed: unknown, threshold: thresholds.unknownRecords });
  const journalCounts = new Map();
  for (const record of result?.structured?.records ?? []) increment(journalCounts, record.file);
  const total = [...journalCounts.values()].reduce((sum, count) => sum + count, 0);
  const top = [...journalCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const percent = top && total ? Math.round((top[1] / total) * 100) : 0;
  if (top && total >= thresholds.journalConcentrationMinimum && percent >= thresholds.journalConcentrationPercent) {
    leads.push({ code: "journal-concentration", observed: percent, threshold: thresholds.journalConcentrationPercent, detail: top[0] });
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
  const maxId = Math.max(-1, ...journals.map((file) => journalFileId(file.path) ?? -1));
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
      sequence: fileId !== null && fileId < maxId ? "older-file-id" : fileId === maxId ? "highest-file-id" : "unknown-order",
      observation: refs.length ? "references-observed" : records.length ? "records-observed" : "no-structured-observation",
    };
  }).sort((a, b) => (a.fileId ?? Number.MAX_SAFE_INTEGER) - (b.fileId ?? Number.MAX_SAFE_INTEGER) || a.path.localeCompare(b.path));
}
