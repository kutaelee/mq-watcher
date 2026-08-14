import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultExecutable = path.join(repositoryRoot, "outputs", process.platform === "win32" ? "mq-watcher.exe" : "mq-watcher");
const executable = path.resolve(process.argv[2] || defaultExecutable);

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

const child = spawn(executable, ["--no-open", "--port", "0"], {
  cwd: repositoryRoot,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  const deadline = Date.now() + 30_000;
  let url;
  while (Date.now() < deadline) {
    const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      url = match[0];
      break;
    }
    if (child.exitCode !== null) throw new Error(`Portable executable exited early (${child.exitCode})\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!url) throw new Error(`Portable executable did not report a loopback URL\nstdout: ${stdout}\nstderr: ${stderr}`);

  const response = await fetch(url);
  const html = await response.text();
  if (response.status !== 200) {
    throw new Error(`Portable HTTP smoke failed (${response.status})\nresponse: ${html}\nstderr: ${stderr}`);
  }
  assert.match(html, /<title>MQ Watcher<\/title>/);
  assert.match(url, /^http:\/\/127\.0\.0\.1:/);
  process.stdout.write(`${JSON.stringify({ executable, pid: child.pid, url, status: response.status, title: "MQ Watcher" }, null, 2)}\n`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await waitForExit(child, 5_000);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
}
