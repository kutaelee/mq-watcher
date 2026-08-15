import assert from "node:assert/strict";
import test from "node:test";
import { waitForUpdatedServer } from "../app/lib/update-reconnect.mjs";

test("waitForUpdatedServer tolerates the restart gap and returns the target version", async () => {
  const replies = [new Error("connection refused"), { currentVersion: "0.4.0" }, { currentVersion: "0.4.1", status: "up-to-date" }];
  const result = await waitForUpdatedServer({
    targetVersion: "0.4.1",
    attempts: 3,
    intervalMs: 0,
    delay: async () => undefined,
    fetchStatus: async () => {
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  assert.equal(result?.currentVersion, "0.4.1");
});

test("waitForUpdatedServer returns null when the replacement does not reconnect", async () => {
  const result = await waitForUpdatedServer({
    targetVersion: "0.4.1",
    attempts: 2,
    intervalMs: 0,
    delay: async () => undefined,
    fetchStatus: async () => { throw new Error("offline"); },
  });
  assert.equal(result, null);
});

test("waitForUpdatedServer stops immediately when its lifecycle is aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForUpdatedServer({ targetVersion: "0.4.1", signal: controller.signal, fetchStatus: async () => ({ currentVersion: "0.4.0", status: "up-to-date" }) }),
    { name: "AbortError" },
  );
});
