import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanPath } from "./fixture-lib.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "fixtures", "synthetic");
const expectedRoot = path.join(repositoryRoot, "fixtures", "expected");

function bytes(...parts) {
  const output = [];
  for (const part of parts) {
    if (typeof part === "string") output.push(Buffer.from(part, "ascii"));
    else output.push(Buffer.from(part));
  }
  return Buffer.concat(output);
}

function int32(value) {
  const output = Buffer.alloc(4);
  output.writeInt32BE(value);
  return output;
}

function uint64(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

function varint(value) {
  let remaining = BigInt(value);
  const output = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    output.push(byte);
  } while (remaining !== 0n);
  return Buffer.from(output);
}

function protoBytes(field, value) {
  const payload = Buffer.from(value);
  return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
}

function protoVarint(field, value) {
  return Buffer.concat([varint(field << 3), varint(value)]);
}

function destination(type, name) {
  return Buffer.concat([protoVarint(1, type), protoBytes(2, Buffer.from(name, "utf8"))]);
}

function localTransaction(connectionId, transactionId) {
  const local = Buffer.concat([
    protoBytes(1, Buffer.from(connectionId, "utf8")),
    protoVarint(2, transactionId),
  ]);
  return protoBytes(1, local);
}

function command(type, payload) {
  const data = Buffer.concat([Buffer.from([type]), varint(payload.length), payload]);
  return Buffer.concat([int32(data.length + 5), Buffer.from([1]), data]);
}

function adler32(payload) {
  let a = 1;
  let b = 0;
  for (const byte of payload) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function journalBatch(records) {
  const payload = Buffer.concat(records);
  const header = Buffer.concat([
    int32(28),
    Buffer.from([2]),
    Buffer.from("WRITE BATCH", "ascii"),
    int32(payload.length),
    uint64(adler32(payload)),
  ]);
  return Buffer.concat([header, payload, Buffer.from([0x2d, 0x71, 0x4d, 0x61, 0x34])]);
}

async function put(fixture, relativePath, content) {
  const target = path.join(fixtureRoot, fixture, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

await put(
  "simple-queue",
  "kr-store/data/hash-index-queue-data_queue#3a#2f#2fORDERS",
  bytes("synthetic index placeholder\n"),
);
await put(
  "simple-queue",
  "journal/data-1",
  bytes("SYNTHETIC_FIXTURE", [0], "queue://ORDERS", [0], "ID:MESSAGE:queue:001", [0]),
);

await put(
  "durable-topic",
  "kr-store/data/hash-index-queue-data_topic#3a#2f#2fPRICES",
  bytes("synthetic index placeholder\n"),
);
await put(
  "durable-topic",
  "journal/data-1",
  bytes(
    "SYNTHETIC_FIXTURE",
    [0],
    "topic://PRICES",
    [0],
    "TopicSubscription",
    [0],
    "ID:DURABLE.CLIENT:1700000000000:-1:5",
    [0],
  ),
);

await put(
  "transaction",
  "kr-store/data/hash-index-queue-data_queue#3a#2f#2fPAYMENTS",
  bytes("synthetic index placeholder\n"),
);
await put(
  "transaction",
  "journal/data-1",
  bytes("SYNTHETIC_FIXTURE", [0], "LocalTransactionId", [0], "TX:synthetic:1", [0], "COMMIT", [0]),
);

await put("advisory", "tmpdb.data", bytes([0x01, 0x02, 0x03, 0x04]));
await put("advisory", "tmpdb.redo", bytes([0x05, 0x06, 0x07, 0x08]));
await put(
  "advisory",
  "db-1.log",
  bytes(
    "ActiveMQ.Advisory.TempQueue",
    [0],
    "DestinationInfo",
    [0],
    "operationType=0",
    [0],
    "ID:MESSAGE:advisory:001",
    [0],
  ),
);

await put(
  "corrupt",
  "broken.bin",
  bytes([0xff, 0xfe, 0x00, 0x7f, 0x01], "queu://BROKEN", [0], [0xde, 0xad, 0xbe, 0xef]),
);
await put(
  "truncated",
  "db-1.log",
  bytes([0x11, 0x22, 0x33], "ActiveMQ.Advisory.Temp", [0x00, 0xff]),
);
await put(
  "false-positive",
  "notes.bin",
  bytes(
    "ActiveMZ.Advisory.TempQueue",
    [0],
    "queue-not://FAKE",
    [0],
    "ID:too:short",
    [0],
  ),
);

const transactionInfo = localTransaction("ID:CLIENT:1", 42);
const addMessage = Buffer.concat([
  protoBytes(1, transactionInfo),
  protoBytes(2, destination(0, "ORDERS")),
  protoBytes(3, Buffer.from("ID:MESSAGE:1", "utf8")),
  protoBytes(4, Buffer.from([0x01, 0x02])),
]);
const subscription = Buffer.concat([
  protoBytes(1, destination(1, "PRICES")),
  protoBytes(2, Buffer.from("client-a:prices", "utf8")),
]);
const commit = protoBytes(1, transactionInfo);
const removeMessage = Buffer.concat([
  protoBytes(2, destination(0, "ORDERS")),
  protoBytes(3, Buffer.from("ID:MESSAGE:1", "utf8")),
]);
const advisoryMessage = Buffer.concat([
  protoBytes(2, destination(1, "ActiveMQ.Advisory.TempQueue")),
  protoBytes(3, Buffer.from("ID:ADVISORY:1", "utf8")),
  protoBytes(4, Buffer.from([0x03, 0x04])),
]);
await put(
  "kahadb-framing",
  "db-1.log",
  journalBatch([
    command(1, addMessage),
    command(7, subscription),
    command(4, commit),
    command(2, removeMessage),
    command(1, advisoryMessage),
  ]),
);

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
await mkdir(expectedRoot, { recursive: true });
for (const fixtureName of fixtureNames) {
  const scan = await scanPath(path.join(fixtureRoot, fixtureName));
  await writeFile(
    path.join(expectedRoot, `${fixtureName}.json`),
    `${JSON.stringify(scan.normalized, null, 2)}\n`,
  );
}

const demoScan = await scanPath(path.join(fixtureRoot, "kahadb-framing"));
await writeFile(
  path.join(repositoryRoot, "public", "demo-result.json"),
  `${JSON.stringify({
    ...demoScan.result,
    signature: "synthetic-demo-v1",
    directoryName: "synthetic-kahadb-demo",
    scannedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`,
);

process.stdout.write(`Generated synthetic fixtures and golden results in ${fixtureRoot}\n`);
