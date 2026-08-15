#!/usr/bin/env python3
"""Generate expressive tutorial narration with the Fish Audio S2.1 Pro API."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request


NARRATION = {
    "en": [
        "[warm and inviting, as if showing a colleague] Start with two consistent Store copies. [brief reflective pause] [slightly more focused] One from before the incident, and one from the investigation point. [short pause] [gently emphasize the safeguard] MQ Watcher keeps them in separate tabs. [reassuring, lighter finish] That way, evidence never silently mixes between Stores.",
        "[curious, thoughtful explanation; measured pace] Before opening individual records, compare the two snapshots. [short pause] Here, the investigation Store contains one hundred sixty-one Advisory observations. That tells us where to look next, [gentle emphasis] but it does not prove a cause.",
        "[calm technical guidance; natural pauses] Next, open Journal retention. This is where you locate the files and byte offsets behind the change. [short pause] Remember: offset order is meaningful inside the same journal. It is not a global timeline across different files.",
        "[focused and reassuring; slightly slower on technical terms] Now trace one exact J M S Message I D. MQ Watcher keeps supported message additions, acknowledgements or removals, transactions, and raw observations separated by Store and journal, so you can always see where each observation came from.",
        "[collaborative, investigative tone] When one observation matters, send only that item to an Incident Case. Write down the question you are testing, [short pause] then pin the evidence with its Store signature and provenance. This keeps the case tied to evidence, rather than memory.",
        "[calm conclusion; clear caution] Finally, choose exactly what to export and review every redaction option. The offline evidence bundle excludes the original Store. [short pause] And MQ Watcher does not determine the root cause automatically. It preserves evidence for a human investigation.",
    ],
    "ko": [
        "이번 예시는 장애 전 기준 스토어와 조사 시점 스토어를 비교해, 어드바이저리 관찰이 왜 늘었는지 따라가는 과정입니다. 먼저 두 사본이 각각 별도 탭에 열렸는지 확인합니다.",
        "스냅샷 비교에서 조사 스토어에 어드바이저리 관찰 백육십일 건이 추가된 사실을 확인합니다. 차이 목록에서 아이디, 신세틱, 어드바이저리, 공공공일을 골라 다음 단계에서 추적합니다. 이 차이만으로 원인을 단정하지는 않습니다.",
        "저널 보존 탐색에서 해당 관찰이 집중된 디비 이 로그를 선택합니다. 역색인 상세에서 파일과 오프셋을 확인해 근거 위치를 좁힙니다. 오프셋 순서는 같은 저널 안에서만 사건 순서의 근거가 됩니다.",
        "메시지 추적에 정확한 제이엠에스 메시지 아이디를 넣고, 열린 모든 스토어를 검색합니다. 예시에서는 메시지 추가 한 건이 보이고, 에이씨케이 또는 제거 기록은 관찰되지 않았습니다. 다만 이것이 미처리를 증명하지는 않습니다.",
        "추적 결과에서 확인할 메시지 추가 근거를 선택해 조사 케이스로 보냅니다. 확인할 질문을 적고, 스토어 서명과 파일, 오프셋이 포함된 근거를 고정합니다. 이렇게 해야 나중에도 같은 근거를 다시 찾을 수 있습니다.",
        "마지막으로 앞에서 만든 케이스와 비교 스토어, 메시지 아이디를 선택합니다. 식별자와 목적지, 파일 경로, 메모의 마스킹 범위를 검토한 뒤 오프라인 증거 묶음을 만듭니다. 원본 스토어는 포함되지 않으며, 원인을 자동으로 판정하지도 않습니다.",
    ],
}

DEFAULT_VOICES = {
    "en": "933563129e564b19a115bedd57b7406a",
    "ko": "ff2945cbfd274c85b440bd39d8cb3729",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--scene", type=int, choices=range(1, 7))
    parser.add_argument("--only", choices=("en", "ko", "both"), default="both")
    parser.add_argument("--english-reference-id", default=DEFAULT_VOICES["en"])
    parser.add_argument("--korean-reference-id", default=DEFAULT_VOICES["ko"])
    parser.add_argument(
        "--neutral-delivery",
        action="store_true",
        help="Remove performance tags and use low-variance professional narration settings.",
    )
    return parser.parse_args()


def synthesize(
    *, api_key: str, voice_id: str, text: str, output: Path, neutral_delivery: bool
) -> None:
    if neutral_delivery:
        text = re.sub(r"\s*\[[^\]]+\]\s*", " ", text).strip()
    body = json.dumps(
        {
            "text": text,
            "reference_id": voice_id,
            "format": "wav",
            "sample_rate": 44100,
            "normalize": True,
            "latency": "normal",
            "temperature": 0.62 if neutral_delivery else 0.78,
            "top_p": 0.68 if neutral_delivery else 0.82,
            "prosody": {
                "speed": 1.0,
                "volume": 0,
                "normalize_loudness": True,
            },
            "condition_on_previous_chunks": True,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(
        "https://api.fish.audio/v1/tts",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "model": "s2.1-pro-free",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=240) as response:
            audio = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Fish Audio TTS failed: HTTP {exc.code}: {detail[:500]}"
        ) from exc
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(audio)


def main() -> None:
    args = parse_args()
    api_key = os.environ.get("FISH_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("FISH_API_KEY is required")
    voices = {
        "en": args.english_reference_id,
        "ko": args.korean_reference_id,
    }
    for language, lines in NARRATION.items():
        if args.only != "both" and args.only != language:
            continue
        for index, text in enumerate(lines, start=1):
            if args.scene is not None and args.scene != index:
                continue
            output = args.output_dir / language / f"{index:02d}.wav"
            synthesize(
                api_key=api_key,
                voice_id=voices[language],
                text=text,
                output=output,
                neutral_delivery=args.neutral_delivery,
            )
            print(f"generated {language} scene {index}: {output}")


if __name__ == "__main__":
    main()
