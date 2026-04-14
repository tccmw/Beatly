from __future__ import annotations

from app.models import DrumEvent, LyricWord, ScoreEvent


def merge_drums_and_lyrics(
    drum_events: list[DrumEvent],
    words: list[LyricWord],
    lyric_window_seconds: float = 0.18,
) -> list[ScoreEvent]:
    events: list[ScoreEvent] = []
    word_index = 0
    sorted_words = sorted(words, key=lambda word: word.start)

    for drum in sorted(drum_events, key=lambda event: event.time):
        while word_index + 1 < len(sorted_words) and sorted_words[word_index].end < drum.time:
            word_index += 1

        lyric = _word_at_time(sorted_words, drum.time, word_index, lyric_window_seconds)
        events.append(
            ScoreEvent(
                time=drum.time,
                note=drum.note,
                lyric=lyric,
                confidence=drum.confidence,
            )
        )

    return events


def _word_at_time(
    words: list[LyricWord],
    time: float,
    preferred_index: int,
    window: float,
) -> str | None:
    if not words:
        return None

    candidates = words[max(0, preferred_index - 1) : min(len(words), preferred_index + 3)]
    for word in candidates:
        if word.start - window <= time <= word.end + window:
            return word.word
    return None
