const encoder = new TextEncoder();

function cancelled(options) {
  if (options?.isCancelled?.()) throw new DOMException("Export cancelled", "AbortError");
}

async function yieldTask(options, progress, stage) {
  cancelled(options);
  options?.onProgress?.({ progress, stage });
  await new Promise((resolve) => setTimeout(resolve, 0));
  cancelled(options);
}

function journalId(path) {
  const match = /(?:^|\/)db-(\d+)\.log$/i.exec(path || "");
  return match ? Number(match[1]) : null;
}

function perJournalTimeline(result) {
  const groups = new Map();
  for (const [index, record] of (result?.structured?.records ?? []).entries()) {
    const file = record.file || "Unknown";
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push({
      id: `${file}:${record.location?.offset ?? -1}:${index}`,
      file,
      journalId: record.location?.dataFileId ?? journalId(file),
      offset: record.location?.offset ?? null,
      command: record.command || "Unknown",
      destination: record.destination?.name ?? "Unknown",
      primaryId: record.messageId ?? record.subscriptionKey ?? record.transactionId ?? "Unknown",
      status: record.status ?? "Unknown",
      confidence: record.confidence ?? "Unknown",
    });
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, events]) => events.sort((a, b) => (a.offset ?? Number.MAX_SAFE_INTEGER) - (b.offset ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)));
}

function journalIndex(result) {
  const counts = new Map();
  for (const record of result?.structured?.records ?? []) counts.set(record.file, (counts.get(record.file) ?? 0) + 1);
  return (result?.files ?? []).filter((file) => file.kind === "journal" || /db-\d+\.log$/i.test(file.path)).map((file) => ({ path: file.path, fileId: journalId(file.path), size: file.size, recordCount: counts.get(file.path) ?? counts.get(file.name) ?? 0 }));
}

function collectSecrets(value, redaction) {
  const groups = { IDENTIFIER: new Set(), DESTINATION: new Set(), FILE: new Set(), NOTE: new Set() };
  const add = (group, item) => {
    group.add(item);
    for (const token of item.match(/[\p{L}\p{N}][\p{L}\p{N}_.:@-]{5,}/gu) ?? []) group.add(token);
  };
  const visit = (item, path = "") => {
    if (Array.isArray(item)) { for (const child of item) visit(child, path); return; }
    if (item && typeof item === "object") { for (const child of Object.keys(item)) visit(item[child], path ? `${path}.${child}` : child); return; }
    if (typeof item !== "string" || item.length < 2) return;
    if (redaction.identifiers && /(^|\.)(id|.*Id|signature|primaryId|rawId|connection|consumer|transactionId|subscriptionKey|messageId|relatedId)$/i.test(path)) add(groups.IDENTIFIER, item);
    if (redaction.destinations && /(destination|destinations)(\.|$)|decodedName|rawName/i.test(path)) add(groups.DESTINATION, item);
    if (redaction.filePaths && /file|path|journal|source|relatedStore|directoryName/i.test(path)) {
      add(groups.FILE, item);
      const name = item.split(/[\\/]/).at(-1);
      if (name?.length > 1) groups.FILE.add(name);
    }
    if (redaction.notes && /text|hypothesis|title/i.test(path)) add(groups.NOTE, item);
  };
  visit(value);
  const rules = [];
  for (const [type, values] of Object.entries(groups)) {
    [...values].sort((a, b) => b.length - a.length || a.localeCompare(b)).forEach((secret, index) => rules.push({ secret, alias: `${type}-${String(index + 1).padStart(3, "0")}` }));
  }
  return rules.sort((a, b) => b.secret.length - a.secret.length || a.secret.localeCompare(b.secret));
}

function sanitizeString(value, rules) {
  let sanitized = value;
  for (const rule of rules) sanitized = sanitized.split(rule.secret).join(rule.alias);
  return sanitized;
}

async function sanitizeTree(value, rules, options) {
  let visited = 0;
  const visit = async (item, key = "") => {
    visited += 1;
    if (visited % 500 === 0) await yieldTask(options, Math.min(34, 10 + Math.floor(visited / 500)), "sanitize");
    if (Array.isArray(item)) {
      const output = [];
      for (const child of item) output.push(await visit(child, key));
      return output;
    }
    if (item && typeof item === "object") {
      const output = {};
      for (const child of Object.keys(item).sort()) output[child] = await visit(item[child], child);
      return output;
    }
    if (typeof item === "string") {
      if (/hex/i.test(key) && rules.length) return "[REDACTED_HEX_PREVIEW]";
      return sanitizeString(item, rules);
    }
    return item;
  };
  return visit(value);
}

export async function chunkedStableStringify(value, options = {}) {
  const chunks = [];
  let processed = 0;
  const write = async (item) => {
    processed += 1;
    if (processed % 500 === 0) await yieldTask(options, Math.min(70, 36 + Math.floor(processed / 500)), "serialize");
    if (Array.isArray(item)) {
      chunks.push("[");
      for (let index = 0; index < item.length; index += 1) { if (index) chunks.push(","); await write(item[index]); }
      chunks.push("]");
    } else if (item && typeof item === "object") {
      chunks.push("{");
      const keys = Object.keys(item).sort();
      for (let index = 0; index < keys.length; index += 1) { if (index) chunks.push(","); chunks.push(JSON.stringify(keys[index]), ":"); await write(item[keys[index]]); }
      chunks.push("}");
    } else chunks.push(JSON.stringify(item));
  };
  await write(value);
  return chunks.join("");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks) {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function header(size, signature) {
  const bytes = new Uint8Array(size); const view = new DataView(bytes.buffer); view.setUint32(0, signature, true); return { bytes, view };
}

export function buildStoredZip(entries) {
  const local = []; const central = []; let offset = 0;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = encoder.encode(entry.name); const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data; const checksum = crc32(data);
    const lh = header(30, 0x04034b50); lh.view.setUint16(4, 20, true); lh.view.setUint16(6, 0x0800, true); lh.view.setUint16(12, 33, true); lh.view.setUint32(14, checksum, true); lh.view.setUint32(18, data.length, true); lh.view.setUint32(22, data.length, true); lh.view.setUint16(26, name.length, true);
    const part = concatBytes([lh.bytes, name, data]); local.push(part);
    const ch = header(46, 0x02014b50); ch.view.setUint16(4, 20, true); ch.view.setUint16(6, 20, true); ch.view.setUint16(8, 0x0800, true); ch.view.setUint16(14, 33, true); ch.view.setUint32(16, checksum, true); ch.view.setUint32(20, data.length, true); ch.view.setUint32(24, data.length, true); ch.view.setUint16(28, name.length, true); ch.view.setUint32(42, offset, true); central.push(concatBytes([ch.bytes, name])); offset += part.length;
  }
  const directory = concatBytes(central); const end = header(22, 0x06054b50); end.view.setUint16(8, entries.length, true); end.view.setUint16(10, entries.length, true); end.view.setUint32(12, directory.length, true); end.view.setUint32(16, offset, true);
  return concatBytes([...local, directory, end.bytes]);
}

async function sha256(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }

function reportHtml(payload, locale) {
  const ko = locale === "ko";
  const rows = payload.timeline.events.slice(0, 500).map((event) => `<tr><td>${escapeHtml(event.file)}</td><td>${event.offset ?? "—"}</td><td>${escapeHtml(event.command)}</td><td>${escapeHtml(event.destination)}</td><td>${escapeHtml(event.status)}</td></tr>`).join("");
  return `<!doctype html><html lang="${ko ? "ko" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MQ Watcher Evidence Bundle</title><style>body{font:14px system-ui;margin:32px;color:#172033}p{color:#526079;line-height:1.6}.card{border:1px solid #dfe5ef;border-radius:10px;padding:16px;margin:14px 0}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:8px;border-bottom:1px solid #e5e9f0;text-align:left}code{font-family:Consolas,monospace}</style><h1>MQ Watcher Evidence Bundle</h1><p>${ko ? "읽기 전용 분석에서 파생된 메타데이터이며 현재 브로커 상태나 자동 원인 판정이 아닙니다." : "Metadata derived by read-only analysis; this is not current broker state or an automated root-cause finding."}</p><div class="card"><strong>Store</strong><p>${escapeHtml(payload.store.directoryName)} · ${escapeHtml(payload.store.storeKind)}</p><code>${escapeHtml(payload.store.signature)}</code></div><h2>${ko ? "저널 내부 증거 순서" : "Per-journal evidence order"}</h2><p>${ko ? "각 저널 내부 offset 순서이며 서로 다른 저널 사이의 전역 시간 순서가 아닙니다." : "Offset order within each journal; no global time order is asserted across journals."}</p><table><thead><tr><th>File</th><th>Offset</th><th>Command</th><th>Destination</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></html>`;
}

export async function buildEvidenceBundle({ result, incidentCase = null, comparison = [], locale = "en", redaction = {}, generatedAt = new Date().toISOString() }, options = {}) {
  await yieldTask(options, 4, "prepare");
  const raw = { format: "mq-watcher-evidence-bundle-v1", generatedAt, limitations: ["derived-metadata-only", "per-journal-offset-order-only", "no-current-broker-state-assertion", "no-automatic-root-cause"], store: { signature: result.signature, directoryName: result.directoryName, storeKind: result.storeKind, totals: result.totals, warnings: result.warnings }, destinations: result.destinations, subscriptions: result.subscriptions, messages: result.messages, strings: result.strings, structuredRecords: result.structured.records, evidenceLinks: result.correlation.links, journals: journalIndex(result), timeline: { ordering: "per-journal-offset", events: perJournalTimeline(result) }, comparison, incidentCase };
  const rules = collectSecrets(raw, redaction);
  const payload = await sanitizeTree(raw, rules, options);
  await yieldTask(options, 35, "serialize");
  const evidence = await chunkedStableStringify(payload, options);
  const report = reportHtml(payload, locale);
  const readme = locale === "ko" ? "원본 Store 파일과 원본 바이트는 포함되지 않습니다.\n" : "Original Store files and source bytes are not included.\n";
  const files = [{ name: "evidence.json", data: evidence }, { name: "report.html", data: report }, { name: "README.txt", data: readme }];
  await yieldTask(options, 76, "checksum");
  const sums = [];
  for (const file of files) { cancelled(options); sums.push(`${await sha256(file.data)}  ${file.name}`); }
  const manifest = await chunkedStableStringify({ format: payload.format, generatedAt, entries: [...files.map((file) => file.name), "SHA256SUMS.txt"], redaction: { identifiers: Boolean(redaction.identifiers), destinations: Boolean(redaction.destinations), filePaths: Boolean(redaction.filePaths), notes: Boolean(redaction.notes) }, sourceFilesIncluded: false }, options);
  files.push({ name: "manifest.json", data: manifest }); sums.push(`${await sha256(manifest)}  manifest.json`); files.push({ name: "SHA256SUMS.txt", data: `${sums.join("\n")}\n` });
  await yieldTask(options, 92, "archive");
  const bytes = buildStoredZip(files);
  const bundleHash = await sha256(bytes);
  options?.onProgress?.({ progress: 100, stage: "complete" });
  return { bytes, sha256: bundleHash, manifest: JSON.parse(manifest), entryNames: files.map((file) => file.name).sort() };
}
