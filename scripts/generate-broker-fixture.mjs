import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { get } from "node:https";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const producerSource = path.join(repositoryRoot, "scripts", "broker-fixtures", "BrokerFixtureProducer.java");

const releases = {
  "5.13.5": {
    java: 8,
    sha1: "fdb42863bc25fe3f2cf1c85d6deb4c599ef32520",
    sha256: "a7883010b8b0a27abe0275dd8701cbabb6ca532da2609e275f72ef241486284f",
  },
  "5.15.16": {
    java: 8,
    sha1: "dfc7fcf2848af37ffc2f0e4bb5273ea4724f1239",
    sha256: "211e6b65d0b4ee636e29bfaeff20f3e6e519afe59a3f85b845166c33ea09eeec",
  },
  "5.18.7": {
    java: 17,
    sha1: "c3511338ab71f95c476a5b9da52e5c83a6572873",
    sha256: "de4485b435c1ab316451a5b82f20d384cf74a1ff0e78448321da2649183c8774",
    dependencies: [
      {
        file: "log4j-api-2.24.1.jar",
        url: "https://repo.maven.apache.org/maven2/org/apache/logging/log4j/log4j-api/2.24.1/log4j-api-2.24.1.jar",
        sha1: "7ebeb12c20606373005af4232cd0ecca72613dda",
        sha256: "6e77bb229fc8dcaf09038beeb5e9030b22e9e01b51b458b0183ce669ebcc92ef",
      },
      {
        file: "log4j-core-2.24.1.jar",
        url: "https://repo.maven.apache.org/maven2/org/apache/logging/log4j/log4j-core/2.24.1/log4j-core-2.24.1.jar",
        sha1: "c85285146f28d8c8962384f786e2dff04172fb43",
        sha256: "00bcf388472ca80a687014181763b66d777177f22cbbf179fd60e1b1ac9bc9b0",
      },
    ],
  },
};

function parseArguments(argv) {
  const options = { version: "", output: "", javaHome: process.env.JAVA_HOME || "", cache: process.env.MQ_WATCHER_BROKER_CACHE || path.join(os.tmpdir(), "mq-watcher-broker-cache") };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--version") options.version = argv[++index] || "";
    else if (argument === "--output") options.output = argv[++index] || "";
    else if (argument === "--java-home") options.javaHome = argv[++index] || "";
    else if (argument === "--cache") options.cache = argv[++index] || "";
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!releases[options.version]) throw new Error(`Unsupported ActiveMQ version: ${options.version || "missing"}`);
  if (!options.output) throw new Error("--output is required");
  if (!options.javaHome) throw new Error("--java-home or JAVA_HOME is required");
  return options;
}

function artifactUrl(version) {
  return `https://repo.maven.apache.org/maven2/org/apache/activemq/activemq-all/${version}/activemq-all-${version}.jar`;
}

function executable(javaHome, name) {
  return path.join(javaHome, "bin", process.platform === "win32" ? `${name}.exe` : name);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status})\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  return result;
}

function download(url, target) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { "user-agent": "mq-watcher-fixture-generator" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url), target).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }
      const stream = createWriteStream(target, { flags: "wx" });
      response.pipe(stream);
      stream.on("finish", () => stream.close(resolve));
      stream.on("error", reject);
    });
    request.setTimeout(120_000, () => request.destroy(new Error(`Download timed out: ${url}`)));
    request.on("error", reject);
  });
}

async function digest(file, algorithm) {
  return createHash(algorithm).update(await readFile(file)).digest("hex");
}

async function ensureArtifact(version, cache) {
  const release = releases[version];
  const url = artifactUrl(version);
  await mkdir(cache, { recursive: true });
  const target = path.join(cache, `activemq-all-${version}.jar`);
  try {
    await access(target);
  } catch {
    const partial = `${target}.${process.pid}.part`;
    await download(url, partial);
    await rename(partial, target);
  }
  const [sha1, sha256] = await Promise.all([digest(target, "sha1"), digest(target, "sha256")]);
  if (sha1 !== release.sha1 || sha256 !== release.sha256) {
    throw new Error(`Artifact checksum mismatch for ActiveMQ ${version}`);
  }
  return { target, url, sha1, sha256 };
}

async function ensureDependency(specification, cache) {
  const target = path.join(cache, specification.file);
  try {
    await access(target);
  } catch {
    const partial = `${target}.${process.pid}.part`;
    await download(specification.url, partial);
    await rename(partial, target);
  }
  const [sha1, sha256] = await Promise.all([digest(target, "sha1"), digest(target, "sha256")]);
  if (sha1 !== specification.sha1 || sha256 !== specification.sha256) {
    throw new Error(`Artifact checksum mismatch for ${specification.file}`);
  }
  return { ...specification, target };
}

async function fileManifest(root) {
  const files = [];
  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) files.push({ path: relative, size: (await stat(absolute)).size, sha256: await digest(absolute, "sha256") });
    }
  }
  await walk(root, "");
  return files;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const output = path.resolve(options.output);
  await access(output).then(
    () => { throw new Error(`Output already exists: ${output}`); },
    () => undefined,
  );

  const artifact = await ensureArtifact(options.version, path.resolve(options.cache));
  const dependencies = await Promise.all(
    (releases[options.version].dependencies || []).map((dependency) => ensureDependency(dependency, path.resolve(options.cache))),
  );
  const java = executable(path.resolve(options.javaHome), "java");
  const javac = executable(path.resolve(options.javaHome), "javac");
  await Promise.all([access(java), access(javac)]);

  const temporary = await mkdtemp(path.join(os.tmpdir(), `mq-watcher-activemq-${options.version}-`));
  try {
    const classes = path.join(temporary, "classes");
    await mkdir(classes, { recursive: true });
    run(javac, ["-encoding", "UTF-8", "-cp", artifact.target, "-d", classes, producerSource]);
    await mkdir(output, { recursive: true });
    const runtimeClasspath = [classes, artifact.target, ...dependencies.map((dependency) => dependency.target)].join(path.delimiter);
    run(java, ["-cp", runtimeClasspath, "BrokerFixtureProducer", path.join(output, "kahadb")]);
    const runtime = run(java, ["-version"]);
    const manifest = {
      schemaVersion: 1,
      generatedBy: "BrokerFixtureProducer",
      activeMqVersion: options.version,
      requiredJavaMajor: releases[options.version].java,
      javaRuntime: (runtime.stderr || runtime.stdout).trim().split(/\r?\n/)[0],
      artifact: { url: artifact.url, sha1: artifact.sha1, sha256: artifact.sha256 },
      runtimeDependencies: dependencies.map(({ file, url, sha1, sha256 }) => ({ file, url, sha1, sha256 })),
      broker: { persistent: true, adapter: "KahaDB", connector: "tcp://127.0.0.1:0", journalMaxFileLength: 1048576, preallocationScope: "entire_journal" },
      scenarios: ["persistent queue message", "acknowledged queue message", "committed local transaction", "offline durable topic message"],
      files: await fileManifest(path.join(output, "kahadb")),
    };
    await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
