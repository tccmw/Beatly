from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

from app.models import LyricWord


def preload_whisper_model(model_name: str = "small") -> None:
    """Warm the cached Whisper model during FastAPI startup."""
    _load_whisper_model(model_name)


def transcribe_words_with_whisper(
    audio_path: Path,
    model_name: str = "small",
    use_stub: bool = False,
) -> list[LyricWord]:
    if use_stub:
        return [
            LyricWord(word="Hello", start=0.45, end=0.82),
            LyricWord(word="Beatly", start=1.1, end=1.65),
            LyricWord(word="drummer", start=2.05, end=2.6),
        ]

    model = _load_whisper_model(model_name)
    result: dict[str, Any] = model.transcribe(
        str(audio_path),
        word_timestamps=True,
        fp16=False,
        verbose=False,
    )

    words: list[LyricWord] = []
    for segment in result.get("segments", []):
        for item in segment.get("words", []):
            word = str(item.get("word", "")).strip()
            if not word:
                continue
            words.append(
                LyricWord(
                    word=word,
                    start=round(float(item.get("start", segment.get("start", 0))), 3),
                    end=round(float(item.get("end", segment.get("end", 0))), 3),
                )
            )
    return words


@lru_cache(maxsize=2)
def _load_whisper_model(model_name: str):
    import whisper

    return whisper.load_model(model_name)
