import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../bin/mq-watcher.mjs";
import { RELEASE_API_URL } from "../app/lib/updater.mjs";

test("CLI server binds to loopback and serves the application and worker modules", async (context) => {
  const realFetch = globalThis.fetch;
  const releaseCalls = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === RELEASE_API_URL) {
      releaseCalls.push({ url: String(input), init });
      return Response.json({
        tag_name: "v99.0.0",
        html_url: "https://github.com/kutaelee/mq-watcher/releases/tag/v99.0.0",
        draft: false,
        prerelease: false,
        published_at: "2026-08-14T00:00:00Z",
        assets: [],
      });
    }
    return realFetch(input, init);
  };
  context.after(() => { globalThis.fetch = realFetch; });
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

  const identityWorker = await fetch(`${running.url}/store-identity.worker.js`);
  assert.equal(identityWorker.status, 200);
  assert.match(identityWorker.headers.get("content-type") || "", /javascript/);
  assert.match(await identityWorker.text(), /buildContentStoreSignature/);

  const identityModule = await fetch(`${running.url}/store-identity.js`);
  assert.equal(identityModule.status, 200);
  assert.match(identityModule.headers.get("content-type") || "", /javascript/);
  assert.match(await identityModule.text(), /content-sha256/);

  const rejected = await fetch(`${running.url}/`, { method: "POST" });
  assert.equal(rejected.status, 405);

  const manualUpdate = await fetch(`${running.url}/api/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "install" }),
  });
  assert.equal(manualUpdate.status, 403);
  assert.equal((await manualUpdate.json()).error.code, "forbidden");

  const updateCheck = await realFetch(`${running.url}/api/update`);
  assert.equal(updateCheck.status, 200);
  const updateState = await updateCheck.json();
  assert.equal(typeof updateState.installToken, "string");
  assert.ok(updateState.installToken.length >= 32);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].init.body, undefined);

  const authorizedManual = await realFetch(`${running.url}/api/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: running.url,
      "Sec-Fetch-Site": "same-origin",
      "X-MQ-Watcher-Install-Token": updateState.installToken,
    },
    body: JSON.stringify({ action: "install" }),
  });
  assert.equal(authorizedManual.status, 409);
  assert.equal((await authorizedManual.json()).status, "manual");

  const privateDataRejected = await realFetch(`${running.url}/api/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: running.url,
      "Sec-Fetch-Site": "same-origin",
      "X-MQ-Watcher-Install-Token": updateState.installToken,
    },
    body: JSON.stringify({ action: "install", storePath: "C:\\private-store", analysis: "private" }),
  });
  assert.equal(privateDataRejected.status, 400);
});
