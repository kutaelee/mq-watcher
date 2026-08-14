import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "fixtures", "synthetic");

function bytes(...parts) {
  const output = [];
  for (const part of parts) {
    if (typeof part === "string") output.push(Buffer.from(part, "ascii"));
    else output.push(Buffer.from(part));
  }
  return Buffer.concat(output);
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

process.stdout.write(`Generated synthetic fixtures in ${fixtureRoot}\n`);
