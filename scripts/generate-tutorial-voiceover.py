#!/usr/bin/env python3
"""Generate local MQ Watcher tutorial narration with Chatterbox Multilingual V3."""

from __future__ import annotations

import argparse
from pathlib import Path

import soundfile as sf
import torch
from chatterbox.mtl_tts import ChatterboxMultilingualTTS


NARRATION = {
    "en": [
        "Start with two consistent Store copies, one before the incident and one from the investigation point. M Q Watcher keeps them in separate tabs so evidence does not silently mix between Stores.",
        "Compare the snapshots before reading individual records. The investigation Store shows one hundred sixty-one Advisory observations, which narrows the changed area without claiming a cause.",
        "Open Journal retention to locate the files and offsets behind the change. Offset order is evidence only inside the same journal, not a global timeline across files.",
        "Trace one exact J M S Message I D. Supported message additions, acknowledgements or removals, transactions, and raw observations stay separated by Store and journal, so provenance remains visible.",
        "Send only the selected observation to an Incident Case. Record the question you are testing, then pin the evidence together with its Store signature and provenance.",
        "Finally, choose what to export and review every redaction option. The offline evidence bundle excludes the original Store, and M Q Watcher does not determine the root cause automatically.",
    ],
    "ko": [
        "장애 전 기준 시점과 조사 시점의 일관된 스토어 사본을 준비합니다. 엠큐 와처는 두 저장소를 별도 탭으로 유지하므로 근거가 서로 섞이지 않습니다.",
        "개별 레코드를 보기 전에 스냅샷부터 비교합니다. 조사 스토어의 어드바이저리 관찰이 백육십일 건으로 늘어난 사실은 변화 영역을 좁혀 주지만 원인을 단정하지는 않습니다.",
        "저널 보존 탐색에서 변화가 기록된 파일과 오프셋을 확인합니다. 오프셋 순서는 같은 저널 안에서만 사건 순서의 근거로 사용합니다.",
        "정확한 제이엠에스 메시지 아이디 하나를 추적합니다. 지원되는 추가, 에이씨케이 또는 제거, 트랜잭션, 원시 관찰을 각 스토어와 각 저널로 나누어 보여주므로 출처를 유지합니다.",
        "검토할 관찰 하나만 조사 케이스로 보냅니다. 확인할 질문이나 가설을 적고 스토어 서명과 출처가 포함된 근거를 고정합니다.",
        "마지막으로 포함할 항목과 모든 마스킹 옵션을 확인합니다. 오프라인 증거 번들에는 원본 스토어가 들어가지 않으며, 엠큐 와처는 장애 원인을 자동 판정하지 않습니다.",
    ],
}

SAMPLES = {
    "en": "Start with two consistent Store copies, one before the incident and one from the investigation point.",
    "ko": "장애 전 기준 시점과 조사 시점의 일관된 스토어 사본을 준비합니다.",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--english-reference", type=Path, required=True)
    parser.add_argument("--korean-reference", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--mode", choices=("sample", "all"), default="sample")
    parser.add_argument("--only", choices=("en", "ko", "both"), default="both")
    parser.add_argument("--scene", type=int, choices=range(1, 7))
    return parser.parse_args()


def generate(
    model: ChatterboxMultilingualTTS,
    text: str,
    language: str,
    reference: Path,
    output: Path,
    seed: int,
) -> None:
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    wav = model.generate(
        text,
        language_id=language,
        audio_prompt_path=str(reference),
        exaggeration=0.38,
        cfg_weight=0.35,
        temperature=0.72,
        repetition_penalty=1.25,
        min_p=0.05,
        top_p=0.92,
    )
    peak = wav.abs().max().clamp_min(1e-6)
    wav = wav * (0.7079 / peak)
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output), wav.squeeze(0).cpu().numpy(), model.sr, subtype="PCM_16")
    print(f"generated {language}: {output}")


def main() -> None:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for this tutorial narration build")

    model_dir = args.model_dir.resolve()
    references = {
        "en": args.english_reference.resolve(),
        "ko": args.korean_reference.resolve(),
    }
    for path in [model_dir, *references.values()]:
        if not path.exists():
            raise FileNotFoundError(path)

    device = torch.device("cuda")
    model = ChatterboxMultilingualTTS.from_local(model_dir, device, t3_model="v3")
    scripts = SAMPLES if args.mode == "sample" else NARRATION
    for language, lines in scripts.items():
        if args.only != "both" and language != args.only:
            continue
        language_lines = [lines] if isinstance(lines, str) else lines
        for index, line in enumerate(language_lines, start=1):
            if args.scene is not None and index != args.scene:
                continue
            name = "sample.wav" if args.mode == "sample" else f"{index:02d}.wav"
            generate(
                model,
                line,
                language,
                references[language],
                args.output_dir / language / name,
                seed=20260815 + index + (100 if language == "ko" else 0),
            )


if __name__ == "__main__":
    main()
