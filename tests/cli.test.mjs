import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../bin/mq-watcher.mjs";

test("CLI server binds to loopback and serves the application and worker modules", async (context) => {
  const running = await startServer({ port: 0, silent: true });
  context.after(() => new Promise((resolve, reject) => running.server.close((error) => error ? reject(error) : resolve())));

  assert.equal(running.host, "127.0.0.1");
  assert.ok(running.port > 0);
  const page = await fetch(`${running.url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>MQ Watcher<\/title>/i);

  const worker = await fetch(`${running.url}/store-scanner.worker.js`);
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get("content-type") || "", /javascript/);
  assert.match(await worker.text(), /correlateEvidence/);

  const rejected = await fetch(`${running.url}/`, { method: "POST" });
  assert.equal(rejected.status, 405);

  const manualUpdate = await fetch(`${running.url}/api/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "install" }),
  });
  assert.equal(manualUpdate.status, 409);
  assert.equal((await manualUpdate.json()).status, "manual");

  const privateDataRejected = await fetch(`${running.url}/api/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "install", storePath: "C:\\private-store", analysis: "private" }),
  });
  assert.equal(privateDataRejected.status, 400);
});
