from __future__ import annotations

import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.models import LyricWord

MIN_LYRIC_DURATION_SECONDS = 0.1
MAX_UNSPLIT_KOREAN_SYLLABLES = 2
KOREAN_TRANSCRIPTION_PROMPT = (
    "Transcribe Korean song lyrics exactly in Hangul. "
    "Do not translate. Keep Korean spacing natural and omit non-lyric noise labels."
)


def preload_whisper_model(model_name: str = "large-v3-turbo") -> None:
    """Warm the cached Whisper model during FastAPI startup."""
    _load_whisper_model(model_name)


def transcribe_words_with_whisper(
    audio_path: Path,
    model_name: str = "large-v3-turbo",
    use_stub: bool = False,
    language: str = "ko",
    word_timestamps: bool = True,
) -> list[LyricWord]:
    if use_stub:
        return [
            LyricWord(word="\uc548", start=0.45, end=0.55),
            LyricWord(word="\ub155", start=0.6, end=0.72),
            LyricWord(word="\ube44", start=1.1, end=1.22),
            LyricWord(word="\ud2c0", start=1.28, end=1.4),
        ]

    model = _load_whisper_model(model_name)
    result: dict[str, Any] = model.transcribe(
        str(audio_path),
        language=language,
        task="transcribe",
        word_timestamps=word_timestamps,
        fp16=False,
        temperature=0.0,
        condition_on_previous_text=False,
        initial_prompt=KOREAN_TRANSCRIPTION_PROMPT if language == "ko" else None,
        verbose=False,
    )

    words: list[LyricWord] = []
    for segment in result.get("segments", []):
        segment_words = segment.get("words", []) if word_timestamps else []
        if not segment_words:
            words.extend(_words_from_segment_text(segment))
            continue

        segment_output: list[LyricWord] = []
        for item in segment.get("words", []):
            word = _normalize_lyric(str(item.get("word", "")))
            if not word:
                continue
            start = float(item.get("start", segment.get("start", 0)))
            end = max(
                start + MIN_LYRIC_DURATION_SECONDS,
                float(item.get("end", segment.get("end", start + MIN_LYRIC_DURATION_SECONDS))),
            )
            segment_output.extend(_split_korean_word_if_needed(word, start, end))
        if segment_output:
            words.extend(segment_output)
        else:
            words.extend(_words_from_segment_text(segment))
    return _sanitize_word_timeline(words)


@lru_cache(maxsize=2)
def _load_whisper_model(model_name: str):
    import whisper

    return whisper.load_model(model_name)


def _normalize_lyric(text: str) -> str:
    return unicodedata.normalize("NFC", text.strip())


def _words_from_segment_text(segment: dict[str, Any]) -> list[LyricWord]:
    text = _normalize_lyric(str(segment.get("text", "")))
    if not text:
        return []

    start = float(segment.get("start", 0))
    end = max(start + MIN_LYRIC_DURATION_SECONDS, float(segment.get("end", start + MIN_LYRIC_DURATION_SECONDS)))
    units = _expand_lyric_units(text)
    if not units:
        return []

    duration = max(end - start, MIN_LYRIC_DURATION_SECONDS * len(units))
    step = duration / len(units)
    return [
        _lyric_word(unit, start + index * step, start + (index + 1) * step)
        for index, unit in enumerate(units)
    ]


def _expand_lyric_units(text: str) -> list[str]:
    units: list[str] = []
    for token in text.split():
        normalized = _strip_token(token)
        if not normalized:
            continue
        syllables = [char for char in normalized if _is_hangul_syllable(char)]
        if len(syllables) > MAX_UNSPLIT_KOREAN_SYLLABLES:
            units.extend(syllables)
        else:
            units.append(normalized)
    return units


def _strip_token(token: str) -> str:
    return _normalize_lyric(token.strip(".,!?;:\"'()[]{}<>"))


def _split_korean_word_if_needed(word: str, start: float, end: float) -> list[LyricWord]:
    syllables = [char for char in word if _is_hangul_syllable(char)]
    if len(syllables) <= MAX_UNSPLIT_KOREAN_SYLLABLES:
        return [_lyric_word(word, start, end)]

    duration = max(end - start, MIN_LYRIC_DURATION_SECONDS * len(syllables))
    step = duration / len(syllables)
    return [
        _lyric_word(syllable, start + index * step, start + (index + 1) * step)
        for index, syllable in enumerate(syllables)
    ]


def _sanitize_word_timeline(words: list[LyricWord]) -> list[LyricWord]:
    sanitized: list[LyricWord] = []
    previous_end = 0.0
    for word in sorted(words, key=lambda item: (item.start, item.end)):
        text = _normalize_lyric(word.word)
        if not text:
            continue
        start = max(0.0, float(word.start))
        end = max(start + MIN_LYRIC_DURATION_SECONDS, float(word.end))
        if sanitized and start < previous_end:
            start = previous_end
            end = max(start + MIN_LYRIC_DURATION_SECONDS, end)
        sanitized.append(_lyric_word(text, start, end))
        previous_end = sanitized[-1].end
    return sanitized


def _lyric_word(word: str, start: float, end: float) -> LyricWord:
    safe_start = round(max(0.0, start), 3)
    safe_end = round(max(safe_start + MIN_LYRIC_DURATION_SECONDS, end), 3)
    return LyricWord(word=_normalize_lyric(word), start=safe_start, end=safe_end)


def _is_hangul_syllable(char: str) -> bool:
    return 0xAC00 <= ord(char) <= 0xD7A3
