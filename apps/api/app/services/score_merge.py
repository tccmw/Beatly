from __future__ import annotations

import unicodedata

from app.models import DrumEvent, LyricSlot, LyricWord, ScoreEvent


def merge_drums_and_lyrics(
    drum_events: list[DrumEvent],
    words: list[LyricWord],
    lyric_window_seconds: float = 0.18,
) -> list[ScoreEvent]:
    """Convert drum events into score events without binding lyrics to hits.

    Lyrics are maintained as an independent timeline. The notation layer maps
    them to 16th-note slots so words remain visible even when no drum is hit.
    """
    return [
        ScoreEvent(
            time=drum.time,
            note=drum.note,
            lyric=None,
            confidence=drum.confidence,
        )
        for drum in sorted(drum_events, key=lambda event: event.time)
    ]


def build_lyric_lane(words: list[LyricWord], bpm: float, measure_count: int) -> dict[int, list[LyricSlot]]:
    beat_seconds = 60 / max(bpm, 1)
    measure_seconds = beat_seconds * 4
    slot_seconds = measure_seconds / 16
    lane: dict[int, dict[int, str]] = {measure: {} for measure in range(1, measure_count + 1)}
    occupied_slots: set[int] = set()
    total_slots = max(16, measure_count * 16)

    for word in sorted(words, key=lambda item: item.start):
        text = unicodedata.normalize("NFC", word.word.strip())
        if not text:
            continue
        absolute_slot = max(0, int(word.start // slot_seconds))
        while absolute_slot in occupied_slots:
            absolute_slot += 1
        if absolute_slot >= total_slots:
            total_slots = absolute_slot + 1

        occupied_slots.add(absolute_slot)
        measure_index = absolute_slot // 16
        slot = absolute_slot % 16
        measure_number = measure_index + 1
        lane.setdefault(measure_number, {})[slot] = text

    return {
        measure: [
            LyricSlot(slot=slot, lyric=lyric)
            for slot, lyric in sorted(slots.items())
        ]
        for measure, slots in sorted(lane.items())
    }


def word_at_slot_time(words: list[LyricWord], slot_time: float) -> str | None:
    """Lookup helper for notation post-processing remaps."""
    for word in sorted(words, key=lambda item: item.start):
        if word.start <= slot_time < word.end:
            return unicodedata.normalize("NFC", word.word.strip()) or None
    return None
