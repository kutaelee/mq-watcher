import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repositoryRoot, "public", "demo-result.json");
const outputPath = path.join(repositoryRoot, "public", "demo-scenario.json");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const clone = (value) => structuredClone(value);

const baseline = clone(source);
baseline.signature = "synthetic-advisory-baseline-v1";
baseline.directoryName = "synthetic-advisory-baseline";
baseline.storeKind = "AMQ Message Store";
baseline.scannedAt = "2026-08-14T09:00:00.000Z";

const investigation = clone(baseline);
investigation.signature = "synthetic-advisory-investigation-v1";
investigation.directoryName = "synthetic-advisory-investigation";
investigation.scannedAt = "2026-08-14T10:30:00.000Z";
investigation.files.push({ path: "db-2.log", name: "db-2.log", size: 1_835_008, modified: 1770003000000, kind: "journal", confidence: "Observed" });
investigation.subscriptions = [{
  id: "ID:SYNTHETIC:ADVISORY:-1:1",
  rawId: "ID:SYNTHETIC:ADVISORY:-1:1",
  connection: "ID:SYNTHETIC:ADVISORY",
  session: "-1",
  consumer: "1",
  type: "TopicSubscription",
  relatedDestination: "ActiveMQ.Advisory.TempQueue",
  relatedStore: "tmp_storage",
  confidence: "Pattern Match",
}];

const records = Array.from({ length: 160 }, (_, index) => ({
  file: "db-2.log",
  location: { dataFileId: 2, offset: 4096 + index * 96, size: 96 },
  recordType: 1,
  confidence: "Parsed",
  commandType: 1,
  command: "KAHA_ADD_MESSAGE_COMMAND",
  status: "Parsed",
  destination: { type: "Topic", name: "ActiveMQ.Advisory.TempQueue" },
  messageId: `ID:SYNTHETIC:ADVISORY:${String(index + 1).padStart(4, "0")}`,
}));
const links = records.map((record, index) => ({
  id: `synthetic-advisory-link-${index + 1}`,
  kind: "advisory",
  primaryId: record.messageId,
  destination: record.destination.name,
  destinationType: "Topic",
  journal: record.file,
  offset: record.location.offset,
  ackStatus: "Not observed in scanned evidence",
  interpretation: "Synthetic Advisory add-message observation. It does not prove a backlog or its cause.",
  interpretationCode: "advisory.parsed",
  transactionId: "Unknown",
  confidence: "Parsed",
  evidenceRefs: [{ id: `synthetic-advisory-ref-${index + 1}`, kind: "parsed-record", file: record.file, offset: record.location.offset, recordId: `parsed:${record.file}:${record.location.offset}`, label: record.messageId, confidence: "Parsed" }],
}));
const advisoryStrings = records.map((record) => ({
  id: `db-2.log:${record.location.offset + 48}`,
  file: "db-2.log",
  offset: record.location.offset + 48,
  value: "ActiveMQ.Advisory.TempQueue",
  confidence: "Observed",
}));
investigation.structured.journals.push({
  file: "db-2.log",
  fileId: 2,
  format: "Apache ActiveMQ Classic KahaDB journal framing",
  status: "Parsed",
  confidence: "Parsed",
  batches: [],
  records,
  warnings: [],
  truncated: false,
});
investigation.structured.records.push(...records);
investigation.correlation.links.push(...links);
investigation.correlation.counts.advisories += links.length;
investigation.strings.push(...advisoryStrings);
investigation.messages.push(...records.slice(0, 40).map((record) => ({
  id: `${record.file}:${record.location.offset}:advisory`,
  journal: record.file,
  offset: record.location.offset,
  destination: record.destination.name,
  detectedType: "Topic",
  relatedId: record.messageId,
  operation: "Unknown",
  confidence: "Parsed",
  strings: [],
  hex: "41 63 74 69 76 65 4d 51 2e 41 64 76 69 73 6f 72 79",
})));
const advisoryObservations = investigation.strings.filter((item) => item.value.includes(".Advisory.")).length;
investigation.destinations = investigation.destinations.map((destination) => destination.name === "ActiveMQ.Advisory.TempQueue" ? { ...destination, occurrences: advisoryObservations } : destination);
investigation.totals = { bytes: baseline.totals.bytes + 1_835_008, journalFiles: 2, advisoryRecords: advisoryObservations, scannedBytes: baseline.totals.scannedBytes + 1_835_008 };

const scenario = {
  format: "mq-watcher-synthetic-investigation-v1",
  title: "Synthetic Advisory retention investigation",
  limitation: "Public synthetic data for product guidance. It does not represent a production incident or prove a root cause.",
  snapshots: [baseline, investigation],
};

await writeFile(outputPath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8");
process.stdout.write(`${outputPath}\n`);
