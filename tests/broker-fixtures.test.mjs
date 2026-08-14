import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brokerVersions, containsWorkstationIdentifier, verifyBrokerFixture } from "../scripts/verify-broker-fixture.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const version of brokerVersions) {
  test(`broker-generated KahaDB fixture: ActiveMQ ${version}`, async () => {
    await verifyBrokerFixture(path.join(repositoryRoot, "fixtures", "broker", version), version);
  });
}

test("binary drive-like bytes are not treated as a workstation path without an identifying root", () => {
  assert.equal(containsWorkstationIdentifier(Buffer.from([0, 65, 58, 92, 1, 2, 3])), false);
  assert.equal(containsWorkstationIdentifier(Buffer.from("C:\\Temp\\broker\\db-1.log")), false);
  assert.equal(containsWorkstationIdentifier(Buffer.from("C:\\Users\\private-user\\store\\db-1.log")), true);
  assert.equal(containsWorkstationIdentifier(Buffer.from("D:/Users/private-user/store/db-1.log")), true);
  assert.equal(containsWorkstationIdentifier(Buffer.from("file:/C:/Users/private-user/store/db-1.log")), true);
  assert.equal(containsWorkstationIdentifier(Buffer.from("/home/runner/work/mq-watcher/db-1.log")), true);
  assert.equal(containsWorkstationIdentifier(Buffer.from("/home/private-user/store/db-1.log")), true);
  assert.equal(containsWorkstationIdentifier(Buffer.from("/Users/private-user/store/db-1.log")), true);
});
