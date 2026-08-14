import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brokerVersions, verifyBrokerFixture } from "../scripts/verify-broker-fixture.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const version of brokerVersions) {
  test(`broker-generated KahaDB fixture: ActiveMQ ${version}`, async () => {
    await verifyBrokerFixture(path.join(repositoryRoot, "fixtures", "broker", version), version);
  });
}
