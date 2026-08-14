import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeScanResult, scanPath } from "../scripts/fixture-lib.mjs";
import { scanDirectory } from "../public/store-scanner.worker.js";

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
];

class MemoryFile {
  constructor(name, value) {
    this.name = name;
    this.bytes = Buffer.from(value, "ascii");
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
