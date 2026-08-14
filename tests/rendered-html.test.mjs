import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const serverUrl = new URL("../dist/server/index.js", import.meta.url);
  serverUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: handleRequest } = await import(serverUrl.href);

  return handleRequest(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
  );
}

test("server-renders the MQ Watcher read-only explorer", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>MQ Watcher<\/title>/i);
  assert.match(html, /저장소 증거 탐색기/);
  assert.match(html, /ActiveMQ 저장소의 증거를 한곳에서 탐색합니다/);
  assert.match(html, /분석 디렉터리 선택/);
  assert.match(html, /원본 보호 모드/);
  assert.match(html, /한국어/);
  assert.match(html, /English/);
  assert.doesNotMatch(html, /Investigation Guide|Class dictionary/);
});

test("ships the bounded worker scanner, localized UI, and sortable tables", async () => {
  const [worker, correlation, explorer, layout] = await Promise.all([
    readFile(new URL("../public/store-scanner.worker.js", import.meta.url), "utf8"),
    readFile(new URL("../public/evidence-correlation.js", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StoreExplorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(worker, /CHUNK_SIZE = 4 \* 1024 \* 1024/);
  assert.match(worker, /Unknown Store Layout/);
  assert.match(worker, /operationType/);
  assert.match(worker, /correlateEvidence/);
  assert.match(correlation, /does not prove that the message was never acknowledged/);
  assert.match(explorer, /showDirectoryPicker\(\{ mode: "read" \}\)/);
  assert.match(explorer, /FilePendingMessageCursor/);
  assert.match(explorer, /I18nProvider/);
  assert.match(explorer, /sort-button/);
  assert.match(explorer, /pageSize/);
  assert.match(explorer, /EvidenceView/);
  assert.match(explorer, /resolveEvidenceRef/);
  assert.match(explorer, /demo-result\.json/);
  assert.doesNotMatch(explorer, /InvestigationView|ClassesView|mobile-menu/);
  assert.match(layout, /<html lang="ko">/);
  await access(new URL("../public/store-scanner.worker.js", import.meta.url));
  await access(new URL("../public/demo-result.json", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("ships OSS safety guidance, broker fixture provenance, and portable release docs", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const koreanReadme = await readFile(new URL("../README.ko.md", import.meta.url), "utf8");
  const security = await readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
  const contributing = await readFile(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");
  const i18n = await readFile(new URL("../app/lib/i18n.tsx", import.meta.url), "utf8");
  const demo = JSON.parse(
    await readFile(new URL("../public/demo-result.json", import.meta.url), "utf8"),
  );

  assert.match(
    readme,
    /No broker startup\. No store recovery\. No writes\. No uploads\. Evidence first\./,
  );
  assert.match(readme, /5\.13\.5[\s\S]*5\.15\.16[\s\S]*5\.18\.7/);
  assert.match(readme, /Broker fixture verified/);
  assert.match(readme, /mq-watcher-windows-x64\.zip/);
  assert.match(readme, /\[한국어\]\(README\.ko\.md\)/);
  assert.match(koreanReadme, /\[English\]\(README\.md\)/);
  assert.match(koreanReadme, /브로커를 기동하지 않습니다/);
  assert.match(security, /IndexedDB/);
  assert.match(security, /no telemetry or external network listener/);
  assert.match(security, /does not download an update asset until the user selects the update action/);
  for (const localizedTitle of ["조사 케이스", "저널 보존 탐색", "증거 타임라인", "증거 번들 내보내기"]) {
    assert.match(i18n, new RegExp(`"view\\.[^"]+\\.title": "${localizedTitle}"`));
  }
  assert.match(contributing, /Read-only invariant/);
  assert.equal(demo.directoryName, "synthetic-kahadb-demo");
  assert.equal(demo.signature, "synthetic-demo-v1");
  assert.equal(demo.scannedAt, "2026-01-01T00:00:00.000Z");
  assert.ok(demo.files.every((file) => file.modified === 1767225600000));

  for (const locale of ["en", "ko"]) {
    for (const name of ["overview.png", "evidence-links.png", "evidence-detail.png"]) {
      await access(new URL(`../docs/screenshots/${locale}/${name}`, import.meta.url));
    }
  }
});
