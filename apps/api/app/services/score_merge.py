from __future__ import annotations

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
    lane: dict[int, dict[int, list[str]]] = {measure: {} for measure in range(1, measure_count + 1)}

    for word in sorted(words, key=lambda item: item.start):
        measure_index = int(word.start // measure_seconds)
        if measure_index < 0 or measure_index >= measure_count:
            continue
        measure_start = measure_index * measure_seconds
        slot = min(15, max(0, int((word.start - measure_start) // slot_seconds)))
        lane.setdefault(measure_index + 1, {}).setdefault(slot, []).append(word.word)

    return {
        measure: [
            LyricSlot(slot=slot, lyric=" ".join(tokens))
            for slot, tokens in sorted(slots.items())
        ]
        for measure, slots in lane.items()
    }
