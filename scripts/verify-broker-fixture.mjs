import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanPath } from "./fixture-lib.mjs";

export const brokerVersions = ["5.13.5", "5.15.16", "5.18.7"];

export function containsWorkstationIdentifier(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  return /DESKTOP-|(?:file:\/+)?[A-Z]:[\\/]Users[\\/][^\\/\p{Cc}]{1,128}[\\/]|\/(?:home|Users)\/[^/\p{Cc}]{1,128}\//iu.test(text);
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function verifyBrokerFixture(fixtureRoot, expectedVersion) {
  const manifestPath = path.join(fixtureRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.activeMqVersion, expectedVersion);
  assert.equal(manifest.generatedBy, "BrokerFixtureProducer");
  assert.equal(manifest.broker.connector, "tcp://127.0.0.1:0");

  for (const entry of manifest.files) {
    assert.equal(await sha256(path.join(fixtureRoot, "kahadb", ...entry.path.split("/"))), entry.sha256);
  }

  const first = await scanPath(path.join(fixtureRoot, "kahadb"));
  const second = await scanPath(path.join(fixtureRoot, "kahadb"));
  assert.equal(first.sourceUnchanged, true, "scanner must not modify broker-generated fixtures");
  assert.equal(first.hashBefore, first.hashAfter);
  assert.deepEqual(first.normalized, second.normalized, "repeated broker fixture scans must be deterministic");
  assert.equal(first.result.storeKind, "KahaDB Message Store");
  assert.equal(first.result.structured.journals.length, 1);
  assert.equal(first.result.structured.warnings.length, 0);
  assert.ok(first.result.structured.journals[0].batches.length >= 8);
  assert.ok(first.result.structured.journals[0].batches.every((batch) => batch.checksum === "Valid"));

  const records = first.result.structured.records;
  const add = (destination) => records.find(
    (record) => record.command === "KAHA_ADD_MESSAGE_COMMAND" && record.destination?.name === destination,
  );
  const remove = (destination) => records.find(
    (record) => record.command === "KAHA_REMOVE_MESSAGE_COMMAND" && record.destination?.name === destination,
  );

  assert.match(add("ORDERS")?.messageId || "", /^fixture-/);
  const ackAdd = add("ACK.TEST");
  const ackRemove = remove("ACK.TEST");
  assert.ok(ackAdd?.messageId);
  assert.equal(ackRemove?.messageId, ackAdd.messageId, "ACK must remove the exact generated message");

  const transactionAdd = add("PAYMENTS");
  const transactionCommit = records.find((record) => record.command === "KAHA_COMMIT_COMMAND");
  assert.match(transactionAdd?.transactionId || "", /^local:fixture-/);
  assert.equal(transactionCommit?.transactionId, transactionAdd.transactionId);

  const subscription = records.find((record) => record.command === "KAHA_SUBSCRIPTION_COMMAND");
  assert.deepEqual(subscription?.destination, { type: "Topic", name: "PRICES" });
  assert.equal(subscription?.subscriptionKey, "fixture-durable-client:prices-sub");
  assert.equal(add("PRICES")?.destination?.type, "Topic");

  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(fixtureRoot, "kahadb", ...entry.path.split("/")));
    assert.equal(containsWorkstationIdentifier(bytes), false, "fixture must not expose workstation identifiers");
  }

  return {
    version: expectedVersion,
    journalSha256: manifest.files.find((entry) => entry.path === "db-1.log")?.sha256,
    batches: first.result.structured.journals[0].batches.length,
    records: records.length,
    transactionId: transactionAdd.transactionId,
    sourceUnchanged: first.sourceUnchanged,
  };
}

async function main() {
  const [fixtureRoot, expectedVersion] = process.argv.slice(2);
  if (!fixtureRoot || !expectedVersion) {
    throw new Error("Usage: node scripts/verify-broker-fixture.mjs <fixture-root> <ActiveMQ-version>");
  }
  const result = await verifyBrokerFixture(path.resolve(fixtureRoot), expectedVersion);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
