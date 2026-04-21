from __future__ import annotations

import logging
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from app.models import LyricWord

logger = logging.getLogger("uvicorn.error")

ALIGNMENT_VERSION = "youtube-whisper-energy-v1"
MIN_SYLLABLE_DURATION_SECONDS = 0.04
DEFAULT_SAMPLE_RATE = 16000
ENERGY_HOP_LENGTH = 256
ENERGY_FRAME_LENGTH = 1024


@dataclass(frozen=True)
class TimedUnit:
    text: str
    start: float
    end: float


def align_caption_words_to_whisper_timing(
    caption_words: list[LyricWord],
    whisper_words: list[LyricWord],
    vocals_audio_path: Path,
) -> list[LyricWord]:
    """Map clean YouTube lyric text onto Whisper timing anchors.

    YouTube captions usually provide better Korean spelling but only coarse cue
    timing. Whisper provides less reliable text but useful word timing. This
    function keeps the YouTube text and replaces its timing with a forced,
    monotonic alignment against Whisper's timestamped vocal units.
    """
    caption_units = _caption_units(caption_words)
    if not caption_units:
        return []

    timing_units = _whisper_timing_units(whisper_words, vocals_audio_path)
    if not timing_units:
        logger.warning("No Whisper timing units available; using caption cue timing as fallback")
        return _fallback_caption_timing(caption_units)

    caption_keys = [_alignment_key(unit.text) for unit in caption_units]
    timing_keys = [_alignment_key(unit.text) for unit in timing_units]
    matcher = SequenceMatcher(a=caption_keys, b=timing_keys, autojunk=False)

    aligned: list[LyricWord] = []
    for tag, caption_start, caption_end, timing_start, timing_end in matcher.get_opcodes():
        caption_slice = caption_units[caption_start:caption_end]
        timing_slice = timing_units[timing_start:timing_end]
        if tag == "insert":
            continue
        if tag == "equal":
            aligned.extend(_pair_equal_units(caption_slice, timing_slice))
            continue
        if tag in {"replace", "delete"}:
            aligned.extend(_map_caption_range_to_timing(caption_slice, timing_slice, aligned, timing_units, timing_end))

    if not aligned:
        return _fallback_caption_timing(caption_units)
    return _sanitize_aligned_words(aligned)


def _caption_units(words: list[LyricWord]) -> list[TimedUnit]:
    units: list[TimedUnit] = []
    for word in words:
        text = unicodedata.normalize("NFC", word.word.strip())
        if not text:
            continue
        units.append(TimedUnit(text=text, start=float(word.start), end=float(word.end)))
    return units


def _whisper_timing_units(words: list[LyricWord], vocals_audio_path: Path) -> list[TimedUnit]:
    energy = _load_vocal_energy(vocals_audio_path)
    units: list[TimedUnit] = []
    for word in words:
        text = unicodedata.normalize("NFC", word.word.strip())
        if not text:
            continue
        expanded = _expand_text_units(text)
        if not expanded:
            continue
        if len(expanded) == 1:
            units.append(TimedUnit(text=expanded[0], start=float(word.start), end=float(word.end)))
            continue
        units.extend(_split_word_by_energy(expanded, float(word.start), float(word.end), energy))
    return _sanitize_timed_units(units)


def _load_vocal_energy(audio_path: Path) -> tuple[np.ndarray, np.ndarray]:
    try:
        audio, sr = sf.read(audio_path, dtype="float32", always_2d=False)
    except Exception:
        logger.warning("Could not load vocal energy from %s; using even Whisper word splits", audio_path)
        return np.asarray([], dtype=np.float32), np.asarray([], dtype=np.float32)

    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    if sr != DEFAULT_SAMPLE_RATE:
        audio = librosa.resample(np.asarray(audio, dtype=np.float32), orig_sr=sr, target_sr=DEFAULT_SAMPLE_RATE)
        sr = DEFAULT_SAMPLE_RATE
    if audio.size < ENERGY_FRAME_LENGTH:
        return np.asarray([], dtype=np.float32), np.asarray([], dtype=np.float32)

    rms = librosa.feature.rms(y=audio, frame_length=ENERGY_FRAME_LENGTH, hop_length=ENERGY_HOP_LENGTH)[0]
    times = librosa.frames_to_time(np.arange(rms.size), sr=sr, hop_length=ENERGY_HOP_LENGTH)
    return np.asarray(times, dtype=np.float32), np.asarray(rms, dtype=np.float32)


def _split_word_by_energy(
    units: list[str],
    start: float,
    end: float,
    energy: tuple[np.ndarray, np.ndarray],
) -> list[TimedUnit]:
    duration = max(end - start, MIN_SYLLABLE_DURATION_SECONDS * len(units))
    fallback_step = duration / len(units)
    peaks = _energy_peaks_in_regions(start, start + duration, len(units), energy)
    if len(peaks) != len(units):
        peaks = [start + index * fallback_step for index in range(len(units))]

    output: list[TimedUnit] = []
    for index, unit in enumerate(units):
        unit_start = peaks[index]
        if index + 1 < len(peaks):
            unit_end = max(unit_start + MIN_SYLLABLE_DURATION_SECONDS, peaks[index + 1])
        else:
            unit_end = max(unit_start + MIN_SYLLABLE_DURATION_SECONDS, start + duration)
        output.append(TimedUnit(text=unit, start=unit_start, end=unit_end))
    return output


def _energy_peaks_in_regions(
    start: float,
    end: float,
    count: int,
    energy: tuple[np.ndarray, np.ndarray],
) -> list[float]:
    times, rms = energy
    if count <= 0 or times.size == 0 or rms.size == 0:
        return []

    region_edges = np.linspace(start, end, count + 1)
    peaks: list[float] = []
    for index in range(count):
        region_start = float(region_edges[index])
        region_end = float(region_edges[index + 1])
        mask = (times >= region_start) & (times < region_end)
        if not np.any(mask):
            peaks.append(region_start)
            continue
        region_times = times[mask]
        region_rms = rms[mask]
        peak_index = int(np.argmax(region_rms))
        peaks.append(float(region_times[peak_index]))
    return peaks


def _pair_equal_units(caption_units: list[TimedUnit], timing_units: list[TimedUnit]) -> list[LyricWord]:
    return [
        _lyric_word(caption.text, timing.start, timing.end)
        for caption, timing in zip(caption_units, timing_units)
    ]


def _map_caption_range_to_timing(
    caption_units: list[TimedUnit],
    timing_units: list[TimedUnit],
    already_aligned: list[LyricWord],
    all_timing_units: list[TimedUnit],
    next_timing_index: int,
) -> list[LyricWord]:
    if not caption_units:
        return []
    if timing_units:
        return _spread_caption_units_over_timing(caption_units, timing_units)

    previous_end = already_aligned[-1].end if already_aligned else caption_units[0].start
    next_start = all_timing_units[next_timing_index].start if next_timing_index < len(all_timing_units) else caption_units[-1].end
    if next_start <= previous_end:
        next_start = previous_end + MIN_SYLLABLE_DURATION_SECONDS * len(caption_units)
    return _spread_caption_units_over_span(caption_units, previous_end, next_start)


def _spread_caption_units_over_timing(caption_units: list[TimedUnit], timing_units: list[TimedUnit]) -> list[LyricWord]:
    if len(caption_units) == len(timing_units):
        return _pair_equal_units(caption_units, timing_units)

    span_start = timing_units[0].start
    span_end = max(timing_units[-1].end, span_start + MIN_SYLLABLE_DURATION_SECONDS * len(caption_units))
    return _spread_caption_units_over_span(caption_units, span_start, span_end)


def _spread_caption_units_over_span(caption_units: list[TimedUnit], start: float, end: float) -> list[LyricWord]:
    duration = max(end - start, MIN_SYLLABLE_DURATION_SECONDS * len(caption_units))
    step = duration / len(caption_units)
    return [
        _lyric_word(unit.text, start + index * step, start + (index + 1) * step)
        for index, unit in enumerate(caption_units)
    ]


def _fallback_caption_timing(caption_units: list[TimedUnit]) -> list[LyricWord]:
    return _sanitize_aligned_words([
        _lyric_word(unit.text, unit.start, unit.end)
        for unit in caption_units
    ])


def _sanitize_timed_units(units: list[TimedUnit]) -> list[TimedUnit]:
    output: list[TimedUnit] = []
    previous_start = 0.0
    for unit in sorted(units, key=lambda item: (item.start, item.end)):
        text = unicodedata.normalize("NFC", unit.text.strip())
        if not text:
            continue
        start = max(previous_start, float(unit.start))
        end = max(start + MIN_SYLLABLE_DURATION_SECONDS, float(unit.end))
        output.append(TimedUnit(text=text, start=start, end=end))
        previous_start = start
    return output


def _sanitize_aligned_words(words: list[LyricWord]) -> list[LyricWord]:
    output: list[LyricWord] = []
    previous_start = 0.0
    for word in sorted(words, key=lambda item: (item.start, item.end)):
        text = unicodedata.normalize("NFC", word.word.strip())
        if not text:
            continue
        start = max(previous_start, float(word.start))
        end = max(start + MIN_SYLLABLE_DURATION_SECONDS, float(word.end))
        output.append(_lyric_word(text, start, end))
        previous_start = start
    return output


def _expand_text_units(text: str) -> list[str]:
    units: list[str] = []
    buffer: list[str] = []

    def flush_buffer() -> None:
        if not buffer:
            return
        token = unicodedata.normalize("NFC", "".join(buffer).strip(".,!?;:\"'()[]{}<>“”‘’"))
        if token:
            units.append(token)
        buffer.clear()

    for char in unicodedata.normalize("NFC", text):
        if _is_hangul_syllable(char):
            flush_buffer()
            units.append(char)
            continue
        if char.isspace() or unicodedata.category(char).startswith("P"):
            flush_buffer()
            continue
        buffer.append(char)

    flush_buffer()
    return units


def _alignment_key(text: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFC", text).lower() if char.isalnum())


def _lyric_word(word: str, start: float, end: float) -> LyricWord:
    safe_start = round(max(0.0, start), 3)
    safe_end = round(max(safe_start + MIN_SYLLABLE_DURATION_SECONDS, end), 3)
    return LyricWord(word=unicodedata.normalize("NFC", word.strip()), start=safe_start, end=safe_end)


def _is_hangul_syllable(char: str) -> bool:
    return 0xAC00 <= ord(char) <= 0xD7A3
