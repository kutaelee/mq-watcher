import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeScanResult, scanPath } from "../scripts/fixture-lib.mjs";
import { scanDirectory } from "../public/store-scanner.worker.js";
import { parseKahaDbJournalFile } from "../public/kahadb-journal-parser.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "fixtures", "synthetic");
const expectedRoot = path.join(repositoryRoot, "fixtures", "expected");
const fixtureNames = [
  "simple-queue",
  "durable-topic",
  "transaction",
  "advisory",
  "corrupt",
  "truncated",
  "false-positive",
  "kahadb-framing",
];

class MemoryFile {
  constructor(name, value) {
    this.name = name;
    this.bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "ascii");
    this.size = this.bytes.length;
    this.lastModified = 0;
  }

  slice(start, end) {
    const value = this.bytes.subarray(start, end);
    return { async arrayBuffer() { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); } };
  }
}

for (const fixtureName of fixtureNames) {
  test(`golden fixture: ${fixtureName}`, async () => {
    const expected = JSON.parse(
      await readFile(path.join(expectedRoot, `${fixtureName}.json`), "utf8"),
    );
    const first = await scanPath(path.join(fixtureRoot, fixtureName));
    const second = await scanPath(path.join(fixtureRoot, fixtureName));

    assert.equal(first.sourceUnchanged, true, "scanner must not modify fixture files");
    assert.equal(first.hashBefore, first.hashAfter);
    assert.deepEqual(first.normalized, expected);
    assert.deepEqual(first.normalized, second.normalized, "repeated scans must be deterministic");
  });
}

test("known destination, consumer ID, and message ID remain detectable", async () => {
  const queue = await scanPath(path.join(fixtureRoot, "simple-queue"));
  const topic = await scanPath(path.join(fixtureRoot, "durable-topic"));
  const advisory = await scanPath(path.join(fixtureRoot, "advisory"));

  assert.ok(queue.result.destinations.some((item) => item.name === "ORDERS"));
  assert.ok(topic.result.subscriptions.some((item) => item.rawId === "ID:DURABLE.CLIENT:1700000000000:-1:5"));
  assert.ok(advisory.normalized.messageIds.includes("ID:MESSAGE:advisory:001"));
});

test("unknown and false-positive inputs remain unknown", async () => {
  for (const fixtureName of ["corrupt", "truncated", "false-positive"]) {
    const scan = await scanPath(path.join(fixtureRoot, fixtureName));
    assert.equal(scan.result.storeKind, "Unknown Store Layout");
    assert.equal(scan.result.destinations.length, 0);
    assert.equal(scan.result.messages.length, 0);
  }
});

test("scanner result collections remain bounded", async () => {
  const manyStrings = Array.from({ length: 6_050 }, (_, index) => `evidence-${index}`).join("\0");
  const manyMessages = Array.from({ length: 2_550 }, () => "ActiveMQ.Advisory.TempQueue").join("\0");
  const result = await scanDirectory({
    signature: "bounded",
    directoryName: "bounded",
    files: [
      { relativePath: "strings.bin", file: new MemoryFile("strings.bin", manyStrings) },
      { relativePath: "messages.bin", file: new MemoryFile("messages.bin", manyMessages) },
    ],
  });

  assert.equal(result.strings.length, 6_000);
  assert.equal(result.messages.length, 2_500);
  assert.deepEqual(result.truncated, { messages: true, strings: true });
  assert.deepEqual(normalizeScanResult(result).truncated, result.truncated);
});

test("structured parser decodes official KahaDB batch and command envelopes", async () => {
  const scan = await scanPath(path.join(fixtureRoot, "kahadb-framing"));
  assert.equal(scan.result.structured.status, "Parsed");
  assert.equal(scan.result.structured.journals[0].batches[0].checksum, "Valid");
  assert.deepEqual(
    scan.result.structured.records.map((record) => record.command),
    [
      "KAHA_ADD_MESSAGE_COMMAND",
      "KAHA_SUBSCRIPTION_COMMAND",
      "KAHA_COMMIT_COMMAND",
      "KAHA_REMOVE_MESSAGE_COMMAND",
      "KAHA_ADD_MESSAGE_COMMAND",
    ],
  );
  assert.deepEqual(scan.result.structured.records[0].destination, { type: "Queue", name: "ORDERS" });
  assert.equal(scan.result.structured.records[0].messageId, "ID:MESSAGE:1");
  assert.equal(scan.result.structured.records[0].transactionId, "local:ID:CLIENT:1:42");
  assert.equal(scan.result.structured.records[1].subscriptionKey, "client-a:prices");
});

test("correlation links queue messages, durable subscriptions, ACKs, transactions, and advisories to evidence", async () => {
  const scan = await scanPath(path.join(fixtureRoot, "kahadb-framing"));
  const links = scan.result.correlation.links;
  const queueMessage = links.find((link) => link.kind === "message" && link.primaryId === "ID:MESSAGE:1");
  assert.equal(queueMessage?.destination, "ORDERS");
  assert.equal(queueMessage?.ackStatus, "Observed");
  assert.ok(queueMessage?.evidenceRefs.some((ref) => ref.kind === "parsed-record"));

  const subscriptionLink = links.find((link) => link.kind === "subscription" && link.primaryId === "client-a:prices");
  assert.equal(subscriptionLink?.destination, "PRICES");
  assert.equal(subscriptionLink?.confidence, "Parsed");

  const transactionLink = links.find((link) => link.kind === "transaction" && link.primaryId === "local:ID:CLIENT:1:42");
  assert.match(transactionLink?.interpretation || "", /Commit command observed/);
  assert.ok((transactionLink?.evidenceRefs.length || 0) >= 2);

  const advisoryLink = links.find((link) => link.kind === "advisory" && link.primaryId === "ID:ADVISORY:1");
  assert.equal(advisoryLink?.destination, "ActiveMQ.Advisory.TempQueue");
  assert.equal(advisoryLink?.confidence, "Parsed");
});

test("missing ACK correlation states the evidence limit instead of asserting non-acknowledgement", async () => {
  const scan = await scanPath(path.join(fixtureRoot, "kahadb-framing"));
  const advisoryMessage = scan.result.correlation.links.find(
    (link) => link.kind === "message" && link.primaryId === "ID:ADVISORY:1",
  );
  assert.equal(advisoryMessage?.ackStatus, "Not observed");
  assert.match(advisoryMessage?.interpretation || "", /does not prove that the message was never acknowledged/i);
});

test("structured parser reports malformed and corrupt records without inventing values", async () => {
  const malformedHeader = Buffer.concat([
    Buffer.from([0, 0, 0, 28, 2]),
    Buffer.from("WRITE BATCH", "ascii"),
    Buffer.from([0, 0, 0, 8]),
    Buffer.alloc(8),
    Buffer.from([0, 0, 0, 50, 1, 1, 0, 0]),
  ]);
  const malformed = await parseKahaDbJournalFile(new MemoryFile("db-8.log", malformedHeader), "db-8.log");
  assert.equal(malformed.status, "Partial");
  assert.equal(malformed.records.length, 0);
  assert.match(malformed.warnings.join(" "), /Invalid record size/);

  const corrupt = Buffer.from(malformedHeader);
  corrupt.writeBigUInt64BE(123n, 20);
  const corruptResult = await parseKahaDbJournalFile(new MemoryFile("db-9.log", corrupt), "db-9.log");
  assert.equal(corruptResult.status, "Partial");
  assert.equal(corruptResult.batches[0].checksum, "Invalid");
});
