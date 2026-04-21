from __future__ import annotations

import unicodedata

from app.models import DrumEvent, LyricSlot, LyricWord, ScoreEvent

MAX_LYRIC_SHIFT_SECONDS = 0.2
LYRIC_LANE_ROWS = 2
SLOTS_PER_MEASURE = 16


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
    slot_seconds = measure_seconds / SLOTS_PER_MEASURE
    lane: dict[int, list[LyricSlot]] = {measure: [] for measure in range(1, measure_count + 1)}
    occupied_positions: set[tuple[int, int]] = set()
    max_shift_slots = max(0, int(MAX_LYRIC_SHIFT_SECONDS // slot_seconds))

    for word in sorted(words, key=lambda item: item.start):
        text = unicodedata.normalize("NFC", word.word.strip())
        if not text:
            continue
        preferred_slot = max(0, int(word.start // slot_seconds))
        absolute_slot, row = _place_lyric_slot(preferred_slot, occupied_positions, max_shift_slots)
        occupied_positions.add((absolute_slot, row))
        measure_index = absolute_slot // SLOTS_PER_MEASURE
        slot = absolute_slot % SLOTS_PER_MEASURE
        measure_number = measure_index + 1
        lane.setdefault(measure_number, []).append(LyricSlot(slot=slot, lyric=text, row=row))

    return {
        measure: sorted(slots, key=lambda slot: (slot.slot, slot.row, slot.lyric))
        for measure, slots in sorted(lane.items())
    }


def _place_lyric_slot(
    preferred_slot: int,
    occupied_positions: set[tuple[int, int]],
    max_shift_slots: int,
) -> tuple[int, int]:
    for offset in range(0, max_shift_slots + 1):
        candidate_slot = preferred_slot + offset
        for row in range(LYRIC_LANE_ROWS):
            if (candidate_slot, row) not in occupied_positions:
                return candidate_slot, row

    for row in range(LYRIC_LANE_ROWS):
        if (preferred_slot, row) not in occupied_positions:
            return preferred_slot, row

    return preferred_slot, 0


def word_at_slot_time(words: list[LyricWord], slot_time: float) -> str | None:
    """Lookup helper for notation post-processing remaps."""
    for word in sorted(words, key=lambda item: item.start):
        if word.start <= slot_time < word.end:
            return unicodedata.normalize("NFC", word.word.strip()) or None
    return None
