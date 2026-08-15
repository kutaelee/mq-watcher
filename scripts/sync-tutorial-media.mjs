import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const locale of ["en", "ko"]) {
  const target = path.join(repositoryRoot, "public", "tutorial", locale);
  await mkdir(target, { recursive: true });
  await Promise.all([
    copyFile(path.join(repositoryRoot, "docs", "media", locale, "mq-watcher-walkthrough.mp4"), path.join(target, "mq-watcher-walkthrough.mp4")),
    copyFile(path.join(repositoryRoot, "docs", "screenshots", locale, "scenario-overview.png"), path.join(target, "scenario-overview.png")),
  ]);
}
