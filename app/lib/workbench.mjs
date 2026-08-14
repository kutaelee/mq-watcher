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

export const MAX_TIMELINE_EVENTS = 10_000;

export function buildEvidenceTimeline(result, limit = MAX_TIMELINE_EVENTS) {
  const records = (result?.structured?.records ?? []).map((record, index) => ({
    id: `${record.location?.dataFileId ?? journalFileId(record.file) ?? -1}:${record.location?.offset ?? -1}:${index}`,
    file: record.file,
    dataFileId: record.location?.dataFileId ?? journalFileId(record.file),
    offset: record.location?.offset ?? null,
    command: record.command || "Unknown",
    category: record.subscriptionKey ? "subscription" : record.transactionId ? "transaction" : record.messageId ? "message" : "record",
    destination: record.destination?.name ?? "Unknown",
    primaryId: record.messageId ?? record.subscriptionKey ?? record.transactionId ?? "Unknown",
    status: record.status ?? "Unknown",
    confidence: record.confidence ?? "Unknown",
  })).sort((a, b) => (a.dataFileId ?? Number.MAX_SAFE_INTEGER) - (b.dataFileId ?? Number.MAX_SAFE_INTEGER)
    || (a.offset ?? Number.MAX_SAFE_INTEGER) - (b.offset ?? Number.MAX_SAFE_INTEGER)
    || a.command.localeCompare(b.command)
    || a.id.localeCompare(b.id));
  return { events: records.slice(0, Math.max(0, limit)), total: records.length, truncated: records.length > limit, ordering: "data-file-id-offset" };
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

export async function buildEvidenceBundle({ result, incidentCase = null, comparison = [], locale = "en", redaction = {}, generatedAt = new Date().toISOString() }) {
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
