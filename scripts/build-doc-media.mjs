import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.join(repositoryRoot, "work", "tutorial-video-v2");
const requestedLocale = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : "both";
if (!["en", "ko", "both"].includes(requestedLocale)) {
  throw new Error("--only must be en, ko, or both");
}
const frameNames = [
  "01-overview.png",
  "02-snapshot-compare.png",
  "03-journal-retention.png",
  "04-message-trace.png",
  "05-incident-case.png",
  "06-evidence-export.png",
];
const subtitleLines = {
  en: [
    "Prepare consistent Store copies from before the incident and the investigation point.\\NEach Store stays in its own tab.",
    "Compare snapshots first. The increase to 161 Advisory observations narrows the changed area,\\Nbut does not prove the cause.",
    "Use Journal retention to locate the files and offsets behind the change.\\NOffset order is authoritative only within the same journal.",
    "Trace one exact JMSMessageID across supported ADD, ACK/remove,\\Ntransaction, and raw observations.",
    "Send only the selected observation to an Incident Case,\\Nthen pin it with its Store signature and provenance.",
    "Review every export and redaction option.\\NThe evidence bundle excludes the original Store and does not determine root cause.",
  ],
  ko: [
    "1/6 · Advisory 증가를 조사할 두 Store를 엽니다.\\N장애 전 기준 Store와 조사 시점 Store가 별도 탭에 있는지 확인합니다.",
    "2/6 · 161건 증가에서 추적할 ID를 고릅니다.\\N조사 Store에만 보이는 ID를 찾되 이 차이만으로 원인을 단정하지 않습니다.",
    "3/6 · ID가 기록된 journal과 offset을 찾습니다.\\Ndb-2.log 역색인에서 근거 위치를 좁히고 같은 journal 안의 순서만 해석합니다.",
    "4/6 · 같은 Message ID의 ADD와 ACK/remove를 확인합니다.\\NADD 1건과 ACK/remove 미관찰을 확인하되 미처리로 단정하지 않습니다.",
    "5/6 · 선택한 근거와 확인할 질문을 케이스에 고정합니다.\\NStore 서명, 파일과 offset이 함께 유지되는지 확인합니다.",
    "6/6 · 케이스와 비교 결과를 마스킹해 내보냅니다.\\N포함 항목과 마스킹을 검토하며 원본 Store는 묶음에 들어가지 않습니다.",
  ],
};

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited with ${result.status}`);
  return result.stdout;
}

function mediaDuration(file) {
  return Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]).trim());
}

function assTime(seconds) {
  const centiseconds = Math.round(seconds * 100);
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function vttTime(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function subtitleText(value) {
  return value.replaceAll("\\N", "\n");
}

function makeAss(locale, durations) {
  const font = locale === "ko" ? "Malgun Gothic" : "Segoe UI";
  const events = [];
  let cursor = 0;
  for (let index = 0; index < durations.length; index += 1) {
    events.push(`Dialogue: 0,${assTime(cursor + 0.35)},${assTime(cursor + durations[index] - 0.35)},Caption,,0,0,0,,${subtitleLines[locale][index]}`);
    cursor += durations[index];
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${font},42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,3,1.2,0,2,120,120,46,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

function makeVtt(locale, durations) {
  const cues = ["WEBVTT", ""];
  let cursor = 0;
  for (let index = 0; index < durations.length; index += 1) {
    cues.push(`${vttTime(cursor + 0.35)} --> ${vttTime(cursor + durations[index] - 0.35)}`);
    cues.push(subtitleText(subtitleLines[locale][index]));
    if (index < durations.length - 1) cues.push("");
    cursor += durations[index];
  }
  return `${cues.join("\n")}\n`;
}

function narratedFilter(durations, assPath) {
  const filters = [];
  for (let index = 0; index < durations.length; index += 1) {
    const videoInput = index * 2;
    const audioInput = videoInput + 1;
    const duration = durations[index].toFixed(3);
    filters.push(`[${videoInput}:v]scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p,trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`);
    filters.push(`[${audioInput}:a]aresample=48000,loudnorm=I=-17:TP=-1.5:LRA=7,adelay=450:all=1,apad=whole_dur=${duration},atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`);
  }
  filters.push(`${durations.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${durations.length}:v=1:a=1[base][audio]`);
  filters.push(`[base]ass='${assPath.replaceAll("\\", "/")}':fontsdir='C\\:/Windows/Fonts'[video]`);
  filters.push("[audio]loudnorm=I=-16:TP=-1.5:LRA=7[mix]");
  return filters.join(";");
}

function previewFilter(assPath) {
  const filters = frameNames.map((_, index) => `[${index}:v]scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p,trim=duration=3,setpts=PTS-STARTPTS[p${index}]`);
  filters.push(`${frameNames.map((_, index) => `[p${index}]`).join("")}concat=n=${frameNames.length}:v=1:a=0[base]`);
  filters.push(`[base]ass='${assPath.replaceAll("\\", "/")}':fontsdir='C\\:/Windows/Fonts'[preview]`);
  return filters.join(";");
}

for (const locale of ["en", "ko"].filter((value) => requestedLocale === "both" || requestedLocale === value)) {
  const captureDirectory = path.join(workRoot, "captures", locale);
  const audioDirectory = path.join(workRoot, "audio", locale);
  const editDirectory = path.join(workRoot, "edit", locale);
  const mediaDirectory = path.join(repositoryRoot, "docs", "media", locale);
  const publicDirectory = path.join(repositoryRoot, "public", "tutorial", locale);
  const frames = frameNames.map((name) => path.join(captureDirectory, name));
  const audio = frameNames.map((_, index) => path.join(audioDirectory, `${String(index + 1).padStart(2, "0")}.wav`));
  await Promise.all([...frames, ...audio].map((file) => access(file)));
  await Promise.all([mkdir(editDirectory, { recursive: true }), mkdir(mediaDirectory, { recursive: true }), mkdir(publicDirectory, { recursive: true })]);

  const durations = audio.map((file) => mediaDuration(file) + 0.9);
  const assPath = path.join(editDirectory, "captions.ass");
  const vttPath = path.join(publicDirectory, "captions.vtt");
  await writeFile(assPath, makeAss(locale, durations), "utf8");
  await writeFile(vttPath, makeVtt(locale, durations), "utf8");

  const mp4 = path.join(mediaDirectory, "mq-watcher-walkthrough.mp4");
  const gifPreview = path.join(editDirectory, "walkthrough-preview.mp4");
  const gif = path.join(mediaDirectory, "mq-watcher-walkthrough.gif");
  const palette = path.join(editDirectory, "walkthrough-palette.png");
  const narratedInputs = durations.flatMap((duration, index) => ["-loop", "1", "-t", String(duration), "-i", frames[index], "-i", audio[index]]);

  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...narratedInputs, "-filter_complex", narratedFilter(durations, path.relative(repositoryRoot, assPath)), "-map", "[video]", "-map", "[mix]", "-r", "30", "-c:v", "libx264", "-preset", "slow", "-tune", "stillimage", "-crf", "14", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", mp4]);

  const previewDurations = frameNames.map(() => 3);
  await writeFile(path.join(editDirectory, "preview-captions.ass"), makeAss(locale, previewDurations), "utf8");
  const previewInputs = frames.flatMap((frame) => ["-loop", "1", "-t", "3", "-i", frame]);
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...previewInputs, "-filter_complex", previewFilter(path.relative(repositoryRoot, path.join(editDirectory, "preview-captions.ass"))), "-map", "[preview]", "-r", "12", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", gifPreview]);
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", gifPreview, "-vf", "fps=8,scale=1280:720:flags=lanczos,palettegen=max_colors=192:stats_mode=diff", palette]);
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", gifPreview, "-i", palette, "-lavfi", "fps=8,scale=1280:720:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle", gif]);
  await rm(palette, { force: true });
  process.stdout.write(`${locale}: ${path.relative(repositoryRoot, mp4)}\n${locale}: ${path.relative(repositoryRoot, gif)}\n${locale}: ${path.relative(repositoryRoot, vttPath)}\n`);
}
