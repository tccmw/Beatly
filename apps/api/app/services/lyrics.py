from __future__ import annotations

import unicodedata
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.models import LyricWord

logger = logging.getLogger("uvicorn.error")
MIN_LYRIC_DURATION_SECONDS = 0.1
MAX_UNSPLIT_KOREAN_SYLLABLES = 2
KOREAN_TRANSCRIPTION_PROMPT = (
    "Transcribe Korean song lyrics exactly in Hangul. "
    "Do not translate. Keep Korean spacing natural and omit non-lyric noise labels."
)


def preload_whisper_model(
    model_name: str = "large-v3-turbo",
    engine: str = "faster-whisper",
    device: str = "cpu",
    compute_type: str = "int8",
    download_root: Path | None = None,
) -> None:
    """Warm the cached Whisper model during FastAPI startup."""
    if _is_faster_whisper_engine(engine):
        _load_faster_whisper_model(model_name, device, compute_type, str(download_root) if download_root else None)
        return
    _load_whisper_model(model_name)


def transcribe_words_with_whisper(
    audio_path: Path,
    model_name: str = "large-v3-turbo",
    engine: str = "faster-whisper",
    device: str = "cpu",
    compute_type: str = "int8",
    beam_size: int = 1,
    vad_filter: bool = False,
    download_root: Path | None = None,
    allow_openai_fallback: bool = False,
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

    if _is_faster_whisper_engine(engine):
        try:
            return _transcribe_words_with_faster_whisper(
                audio_path,
                model_name=model_name,
                device=device,
                compute_type=compute_type,
                beam_size=beam_size,
                vad_filter=vad_filter,
                download_root=download_root,
                language=language,
                word_timestamps=word_timestamps,
            )
        except Exception as exc:
            if not allow_openai_fallback:
                raise RuntimeError(
                    "faster-whisper transcription failed before transcription could run. "
                    "The model may not be downloaded yet or the Hugging Face download failed. "
                    "Retry after the model is cached, or set WHISPER_OPENAI_FALLBACK=true to allow the slower fallback."
                ) from exc
            logger.exception("faster-whisper transcription failed; falling back to openai-whisper")

    return _transcribe_words_with_openai_whisper(
        audio_path,
        model_name=model_name,
        beam_size=beam_size,
        language=language,
        word_timestamps=word_timestamps,
    )


def _transcribe_words_with_faster_whisper(
    audio_path: Path,
    model_name: str,
    device: str,
    compute_type: str,
    beam_size: int,
    vad_filter: bool,
    download_root: Path | None,
    language: str,
    word_timestamps: bool,
) -> list[LyricWord]:
    model = _load_faster_whisper_model(model_name, device, compute_type, str(download_root) if download_root else None)
    segments, _ = model.transcribe(
        str(audio_path),
        language=language,
        task="transcribe",
        word_timestamps=word_timestamps,
        beam_size=max(1, beam_size),
        best_of=1,
        temperature=0.0,
        condition_on_previous_text=False,
        initial_prompt=KOREAN_TRANSCRIPTION_PROMPT if language == "ko" else None,
        vad_filter=vad_filter,
    )

    words: list[LyricWord] = []
    for segment in segments:
        segment_words = getattr(segment, "words", None) if word_timestamps else None
        if not segment_words:
            words.extend(
                _words_from_segment_text(
                    {
                        "text": getattr(segment, "text", ""),
                        "start": getattr(segment, "start", 0),
                        "end": getattr(segment, "end", MIN_LYRIC_DURATION_SECONDS),
                    }
                )
            )
            continue
        segment_output = _words_from_timestamp_items(
            segment_words,
            segment_start=float(getattr(segment, "start", 0)),
            segment_end=float(getattr(segment, "end", MIN_LYRIC_DURATION_SECONDS)),
        )
        if segment_output:
            words.extend(segment_output)
        else:
            words.extend(
                _words_from_segment_text(
                    {
                        "text": getattr(segment, "text", ""),
                        "start": getattr(segment, "start", 0),
                        "end": getattr(segment, "end", MIN_LYRIC_DURATION_SECONDS),
                    }
                )
            )
    return _sanitize_word_timeline(words)


def _transcribe_words_with_openai_whisper(
    audio_path: Path,
    model_name: str,
    beam_size: int,
    language: str,
    word_timestamps: bool,
) -> list[LyricWord]:
    model = _load_whisper_model(model_name)
    result: dict[str, Any] = model.transcribe(
        str(audio_path),
        language=language,
        task="transcribe",
        word_timestamps=word_timestamps,
        beam_size=max(1, beam_size),
        best_of=1,
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

        segment_output = _words_from_timestamp_items(
            segment.get("words", []),
            segment_start=float(segment.get("start", 0)),
            segment_end=float(segment.get("end", MIN_LYRIC_DURATION_SECONDS)),
        )
        if segment_output:
            words.extend(segment_output)
        else:
            words.extend(_words_from_segment_text(segment))
    return _sanitize_word_timeline(words)


def _is_faster_whisper_engine(engine: str) -> bool:
    return engine.strip().lower() in {"faster-whisper", "faster_whisper", "ctranslate2", "ct2"}


@lru_cache(maxsize=2)
def _load_faster_whisper_model(model_name: str, device: str, compute_type: str, download_root: str | None):
    from faster_whisper import WhisperModel

    return WhisperModel(model_name, device=device, compute_type=compute_type, download_root=download_root)


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


def _words_from_timestamp_items(
    items: list[Any],
    segment_start: float,
    segment_end: float,
) -> list[LyricWord]:
    words: list[LyricWord] = []
    for item in items:
        word = _normalize_lyric(str(_timestamp_item_value(item, "word", "")))
        if not word:
            continue
        start = float(_timestamp_item_value(item, "start", segment_start))
        end = max(
            start + MIN_LYRIC_DURATION_SECONDS,
            float(_timestamp_item_value(item, "end", max(segment_end, start + MIN_LYRIC_DURATION_SECONDS))),
        )
        words.extend(_split_korean_word_if_needed(word, start, end))
    return words


def _timestamp_item_value(item: Any, key: str, default: Any) -> Any:
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


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
