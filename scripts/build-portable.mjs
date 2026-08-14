import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.join(repositoryRoot, "work", "sea");
const outputRoot = path.join(repositoryRoot, "outputs");
const executableName = process.platform === "win32" ? "mq-watcher.exe" : "mq-watcher";
const runtimePackages = ["react", "react-dom", "scheduler"];

function run(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})\n${result.stdout || ""}\n${result.stderr || ""}`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertNoPrivateBuildPaths(bytes) {
  const binaryText = bytes.toString("latin1").toLowerCase();
  const privateRoots = new Set([repositoryRoot, homedir()]);
  for (const privateRoot of privateRoots) {
    for (const candidate of [privateRoot, privateRoot.replaceAll("\\", "/")]) {
      if (candidate && binaryText.includes(candidate.toLowerCase())) {
        throw new Error(`Portable executable contains a private build path: ${candidate}`);
      }
    }
  }
}

async function collectFiles(root, prefix) {
  const files = [];
  async function walk(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, childRelative);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        files.push({ path: `${prefix}/${childRelative}`, source: absolute, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await walk(root, "");
  return files;
}

async function main() {
  if (process.platform !== "win32" && process.platform !== "linux") {
    throw new Error(`Portable build is supported on Windows and Linux, not ${process.platform}`);
  }
  const packageMetadata = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });

  const files = await collectFiles(path.join(repositoryRoot, "dist"), "dist");
  for (const packageName of runtimePackages) {
    files.push(...await collectFiles(path.join(repositoryRoot, "node_modules", packageName), `node_modules/${packageName}`));
  }
  const packageFile = path.join(workRoot, "package.json");
  const packageBytes = Buffer.from(`${JSON.stringify({ type: "module", version: packageMetadata.version }, null, 2)}\n`);
  await writeFile(packageFile, packageBytes);
  files.push({ path: "package.json", source: packageFile, size: packageBytes.length, sha256: sha256(packageBytes) });
  files.sort((left, right) => left.path.localeCompare(right.path));

  const manifest = { schemaVersion: 1, version: packageMetadata.version, files: files.map(({ path: filePath, size, sha256: hash }) => ({ path: filePath, size, sha256: hash })) };
  const manifestFile = path.join(workRoot, "app-manifest.json");
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const seaEntryFile = path.join(workRoot, "sea-entry.cjs");
  await copyFile(path.join(repositoryRoot, "portable", "sea-entry.cjs"), seaEntryFile);
  const blob = path.join(workRoot, "mq-watcher.blob");
  const config = {
    main: "sea-entry.cjs",
    output: "mq-watcher.blob",
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: Object.fromEntries([
      ["app-manifest.json", manifestFile],
      ...files.map((file) => [`app/${file.path}`, file.source]),
    ]),
  };
  const configFile = path.join(workRoot, "sea-config.json");
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
  run(process.execPath, ["--experimental-sea-config", configFile], workRoot);

  const executable = path.join(outputRoot, executableName);
  await copyFile(process.execPath, executable);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  run(process.execPath, [
    path.join(repositoryRoot, "node_modules", "postject", "dist", "cli.js"),
    executable,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ]);
  const executableBytes = await readFile(executable);
  assertNoPrivateBuildPaths(executableBytes);
  process.stdout.write(`${JSON.stringify({ executable, version: packageMetadata.version, size: executableBytes.length, sha256: sha256(executableBytes), assets: files.length }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
