#!/usr/bin/env python3
"""Read JSON lines {"wav": path} and write language, probability, and a short transcript."""

import json
import sys

from faster_whisper import WhisperModel

model = WhisperModel("tiny", device="cpu", compute_type="int8")


def transcribe(wav: str) -> dict:
    segments, info = model.transcribe(wav, beam_size=1)
    text = " ".join(segment.text.strip() for segment in segments if segment.text)
    return {
        "language": info.language,
        "probability": info.language_probability,
        "text": text[:4000],
    }


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            body = json.loads(line)
            wav = body.get("wav")
            if not isinstance(wav, str) or not wav:
                raise ValueError("Expected a wav path.")
            sys.stdout.write(json.dumps(transcribe(wav)) + "\n")
        except Exception as caught:  # noqa: BLE001 - report any failure to the worker
            sys.stdout.write(json.dumps({"error": str(caught)}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
