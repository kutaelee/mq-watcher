import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { digest, extractApplication, validateExtracted, validateManifest } = require("../portable/sea-entry.cjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packagedApplication(version, label) {
  const assets = new Map([
    ["dist/client/index.html", Buffer.from(`<title>${label}</title>\n`)],
    ["dist/server/index.js", Buffer.from(`export default ${JSON.stringify(label)};\n`)],
    ["package.json", Buffer.from(`${JSON.stringify({ type: "module", version })}\n`)],
  ]);
  const files = [...assets]
    .map(([filePath, bytes]) => ({ path: filePath, size: bytes.length, sha256: sha256(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = { schemaVersion: 1, version, files };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return {
    manifest,
    manifestBytes,
    manifestHash: sha256(manifestBytes),
    readAsset(key) {
      if (key === "app-manifest.json") return manifestBytes;
      const bytes = assets.get(key.replace(/^app\//, ""));
      if (!bytes) throw new Error(`Missing synthetic asset: ${key}`);
      return bytes;
    },
  };
}

async function withTemporaryCache(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mq-watcher-portable-cache-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function treeHash(root) {
  const hash = createHash("sha256");
  async function walk(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      hash.update(childRelative).update("\0");
      if (entry.isDirectory()) await walk(absolute, childRelative);
      else hash.update(await readFile(absolute));
    }
  }
  await walk(root, "");
  return hash.digest("hex");
}

test("portable manifest validation fails closed", () => {
  const valid = packagedApplication("0.3.0", "valid").manifest;
  assert.equal(validateManifest(valid), valid);
  assert.throws(() => validateManifest({ ...valid, schemaVersion: 2 }), /Unsupported/);
  assert.throws(() => validateManifest({ ...valid, version: "..\\escape" }), /Invalid packaged application version/);
  assert.throws(() => validateManifest({ ...valid, files: [...valid.files, valid.files[0]] }), /Duplicate/);
  assert.throws(() => validateManifest({ ...valid, files: [{ ...valid.files[0], path: "../escape.js" }] }), /Unsafe/);
  assert.throws(() => validateManifest({ ...valid, files: [{ ...valid.files[0], sha256: "0".repeat(63) }] }), /checksum/);
});

test("corrupt marker, corrupt asset, and unmanifested files self-heal", async () => withTemporaryCache(async (cacheRoot) => {
  const packaged = packagedApplication("0.3.0", "self-heal");
  const first = await extractApplication({ cacheRoot, readAsset: packaged.readAsset });
  assert.equal(await validateExtracted(first.root, packaged.manifest, packaged.manifestHash), true);

  const marker = path.join(first.root, ".manifest-sha256");
  await writeFile(marker, "mismatched-manifest\n");
  const markerRepair = await extractApplication({ cacheRoot, readAsset: packaged.readAsset });
  assert.equal(markerRepair.root, first.root);
  assert.equal((await readFile(marker, "utf8")).trim(), packaged.manifestHash);

  const packagedFile = path.join(first.root, "package.json");
  const expectedPackage = await readFile(packagedFile);
  await writeFile(packagedFile, "corrupt-version-and-content\n");
  await extractApplication({ cacheRoot, readAsset: packaged.readAsset });
  assert.deepEqual(await readFile(packagedFile), expectedPackage);

  const extra = path.join(first.root, "dist", "client", "unmanifested.html");
  await writeFile(extra, "not in manifest\n");
  assert.equal(await validateExtracted(first.root, packaged.manifest, packaged.manifestHash), false);
  await extractApplication({ cacheRoot, readAsset: packaged.readAsset });
  assert.equal(existsSync(extra), false);
  assert.equal(await validateExtracted(first.root, packaged.manifest, packaged.manifestHash), true);
}));

test("v0.2 to v0.3 upgrade and v0.3 to v0.2 downgrade preserve isolated caches", async () => withTemporaryCache(async (cacheRoot) => {
  const oldPackage = packagedApplication("0.2.0", "old-release");
  const newPackage = packagedApplication("0.3.0", "new-release");

  const oldFirst = await extractApplication({ cacheRoot, readAsset: oldPackage.readAsset });
  const oldBefore = await treeHash(oldFirst.root);
  const newFirst = await extractApplication({ cacheRoot, readAsset: newPackage.readAsset });
  const newBefore = await treeHash(newFirst.root);
  assert.notEqual(newFirst.root, oldFirst.root);
  assert.equal(await treeHash(oldFirst.root), oldBefore);

  const oldAgain = await extractApplication({ cacheRoot, readAsset: oldPackage.readAsset });
  assert.equal(oldAgain.root, oldFirst.root);
  assert.equal(await treeHash(oldAgain.root), oldBefore);
  assert.equal(await treeHash(newFirst.root), newBefore);

  const sameVersionNewManifest = packagedApplication("0.3.0", "rebuilt-release");
  const rebuilt = await extractApplication({ cacheRoot, readAsset: sameVersionNewManifest.readAsset });
  assert.notEqual(rebuilt.root, newFirst.root);
  assert.equal(await treeHash(newFirst.root), newBefore);
}));

test("concurrent cold extraction publishes one valid cache without residue", async () => withTemporaryCache(async (cacheRoot) => {
  const packaged = packagedApplication("0.3.0", "concurrent");
  const results = await Promise.all(Array.from({ length: 8 }, () => (
    extractApplication({ cacheRoot, readAsset: packaged.readAsset })
  )));
  assert.equal(new Set(results.map((result) => result.root)).size, 1);
  assert.equal(await validateExtracted(results[0].root, packaged.manifest, packaged.manifestHash), true);
  assert.deepEqual(await readdir(cacheRoot), [path.basename(results[0].root)]);
  assert.equal(digest(packaged.manifestBytes), packaged.manifestHash);
}));
