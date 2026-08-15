import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenes = [
  "scenario-overview.png",
  "view-guide.png",
  "snapshot-compare.png",
  "message-trace.png",
  "journal-progressive.png",
  "incident-case.png",
  "evidence-timeline.png",
  "evidence-export.png",
];
const sceneSeconds = 2.6;
const transitionSeconds = 0.35;

function run(args) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || `ffmpeg exited with ${result.status}`);
}

function filterGraph() {
  const normalized = scenes.map((_, index) => `[${index}:v]scale=1264:712:force_original_aspect_ratio=decrease,pad=1264:712:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p,setsar=1[v${index}]`);
  let previous = "v0";
  for (let index = 1; index < scenes.length; index += 1) {
    const output = `x${index}`;
    const offset = (index * (sceneSeconds - transitionSeconds)).toFixed(2);
    normalized.push(`[${previous}][v${index}]xfade=transition=fade:duration=${transitionSeconds}:offset=${offset}[${output}]`);
    previous = output;
  }
  return { graph: normalized.join(";"), output: previous };
}

for (const locale of ["en", "ko"]) {
  const screenshotDirectory = path.join(repositoryRoot, "docs", "screenshots", locale);
  const mediaDirectory = path.join(repositoryRoot, "docs", "media", locale);
  await mkdir(mediaDirectory, { recursive: true });
  const mp4 = path.join(mediaDirectory, "mq-watcher-walkthrough.mp4");
  const gif = path.join(mediaDirectory, "mq-watcher-walkthrough.gif");
  const palette = path.join(mediaDirectory, ".walkthrough-palette.png");
  const inputs = scenes.flatMap((scene) => ["-loop", "1", "-t", String(sceneSeconds), "-i", path.join(screenshotDirectory, scene)]);
  const { graph, output } = filterGraph();
  run([...inputs, "-filter_complex", graph, "-map", `[${output}]`, "-r", "24", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-movflags", "+faststart", mp4]);
  run(["-i", mp4, "-vf", "fps=6,scale=960:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff", palette]);
  run(["-i", mp4, "-i", palette, "-lavfi", "fps=6,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle", gif]);
  await rm(palette, { force: true });
  process.stdout.write(`${locale}: ${path.relative(repositoryRoot, mp4)}\n${locale}: ${path.relative(repositoryRoot, gif)}\n`);
}
