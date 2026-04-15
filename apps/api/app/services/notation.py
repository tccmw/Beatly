from __future__ import annotations

from dataclasses import dataclass

from app.models import DrumNote, MidiTickEvent, ScoreEvent

TICKS_PER_QUARTER = 480
SIXTEENTH_TICKS = TICKS_PER_QUARTER // 4
MEASURE_TICKS = TICKS_PER_QUARTER * 4
SLOTS_PER_MEASURE = 16
CLUSTER_WINDOW_SECONDS = 0.03


@dataclass(frozen=True)
class DrumMapping:
    midi_note: int
    staff_key: str
    voice: int
    notehead: str
    order: int


DRUM_MAP: dict[DrumNote, DrumMapping] = {
    "hihat_closed": DrumMapping(42, "g/5", 1, "x", 0),
    "hihat_open": DrumMapping(46, "g/5", 1, "x", 1),
    "ride": DrumMapping(51, "f/5", 1, "x", 2),
    "crash": DrumMapping(49, "a/5", 1, "x", 3),
    "snare": DrumMapping(38, "c/5", 1, "normal", 4),
    "tom": DrumMapping(45, "e/5", 2, "normal", 5),
    "kick": DrumMapping(36, "f/4", 2, "normal", 6),
}


def build_midi_tick_list(events: list[ScoreEvent], bpm: float) -> list[MidiTickEvent]:
    """Post-process raw transcription into readable standard drum notation ticks.

    The output is a 16th-note MIDI tick list. It intentionally removes sub-16th
    jitter, separates hands/snare into voice 1 and kick/floor tom into voice 2,
    and keeps one best event per drum per quantized slot.
    """
    events = _snap_near_simultaneous_events(events)
    seconds_per_tick = 60 / max(bpm, 1) / TICKS_PER_QUARTER
    by_slot: dict[tuple[int, DrumNote], ScoreEvent] = {}

    for event in events:
        raw_tick = round(event.time / seconds_per_tick)
        quantized_tick = round(raw_tick / SIXTEENTH_TICKS) * SIXTEENTH_TICKS
        slot_key = (quantized_tick, event.note)
        current = by_slot.get(slot_key)
        if current is None or event.confidence > current.confidence:
            by_slot[slot_key] = event

    optimized = _stabilize_groove(by_slot)
    optimized = _collapse_cymbal_clusters(optimized)
    tick_events: list[MidiTickEvent] = []
    for (tick, drum), event in sorted(optimized.items(), key=lambda item: (item[0][0], DRUM_MAP[item[0][1]].order)):
        mapping = DRUM_MAP[drum]
        measure = tick // MEASURE_TICKS + 1
        slot = (tick % MEASURE_TICKS) // SIXTEENTH_TICKS
        tick_events.append(
            MidiTickEvent(
                tick=tick,
                duration_ticks=SIXTEENTH_TICKS,
                measure=measure,
                slot=slot,
                voice=1 if mapping.voice == 1 else 2,
                midi_note=mapping.midi_note,
                drum=drum,
                staff_key=mapping.staff_key,
                notehead="x" if mapping.notehead == "x" else "normal",
                articulation=_articulation_for(drum, event.confidence),
                lyric=event.lyric,
                confidence=event.confidence,
            )
        )

    return tick_events


def _stabilize_groove(
    by_slot: dict[tuple[int, DrumNote], ScoreEvent],
) -> dict[tuple[int, DrumNote], ScoreEvent]:
    """Make common hi-hat grids visually consistent, prioritizing readability."""
    result = dict(by_slot)
    measures = sorted({tick // MEASURE_TICKS for tick, _ in by_slot})

    for measure in measures:
        base_tick = measure * MEASURE_TICKS
        hihat_slots = [
            (tick - base_tick) // SIXTEENTH_TICKS
            for (tick, drum) in by_slot
            if drum in {"hihat_closed", "hihat_open"} and base_tick <= tick < base_tick + MEASURE_TICKS
        ]
        if len(hihat_slots) < 3:
            continue

        _force_straight_hihat(result, base_tick)

    return result


def _force_straight_hihat(
    result: dict[tuple[int, DrumNote], ScoreEvent],
    base_tick: int,
) -> None:
    hihat_events = [
        (tick, drum, event)
        for (tick, drum), event in result.items()
        if drum in {"hihat_closed", "hihat_open"} and base_tick <= tick < base_tick + MEASURE_TICKS
    ]
    if not hihat_events:
        return

    representative = max((event for _, _, event in hihat_events), key=lambda event: event.confidence)
    open_slots = {
        round((tick - base_tick) / SIXTEENTH_TICKS)
        for tick, drum, _ in hihat_events
        if drum == "hihat_open"
    }

    for tick, drum, _ in hihat_events:
        del result[(tick, drum)]

    for slot in range(0, SLOTS_PER_MEASURE, 2):
        drum: DrumNote = "hihat_open" if slot in open_slots else "hihat_closed"
        result[(base_tick + slot * SIXTEENTH_TICKS, drum)] = ScoreEvent(
            time=representative.time,
            note=drum,
            lyric=None,
            confidence=max(0.72, representative.confidence),
        )


def _snap_near_simultaneous_events(events: list[ScoreEvent]) -> list[ScoreEvent]:
    if not events:
        return []

    sorted_events = sorted(events, key=lambda event: event.time)
    clusters: list[list[ScoreEvent]] = [[sorted_events[0]]]
    for event in sorted_events[1:]:
        if event.time - clusters[-1][-1].time <= CLUSTER_WINDOW_SECONDS:
            clusters[-1].append(event)
        else:
            clusters.append([event])

    snapped: list[ScoreEvent] = []
    for cluster in clusters:
        anchor = max(cluster, key=lambda event: event.confidence).time
        for event in cluster:
            snapped.append(
                ScoreEvent(
                    time=round(anchor, 3),
                    note=event.note,
                    lyric=event.lyric,
                    confidence=event.confidence,
                )
            )
    return snapped


def _collapse_cymbal_clusters(
    by_slot: dict[tuple[int, DrumNote], ScoreEvent],
) -> dict[tuple[int, DrumNote], ScoreEvent]:
    result = dict(by_slot)
    cymbal_priority: dict[DrumNote, int] = {
        "crash": 0,
        "hihat_open": 1,
        "hihat_closed": 2,
        "ride": 3,
        "kick": 9,
        "snare": 9,
        "tom": 9,
    }

    ticks = sorted({tick for tick, _ in result})
    for tick in ticks:
        cymbals = [
            (drum, event)
            for (event_tick, drum), event in result.items()
            if event_tick == tick and drum in {"hihat_closed", "hihat_open", "ride", "crash"}
        ]
        if len(cymbals) <= 1:
            continue

        keep_drum, _ = sorted(cymbals, key=lambda item: (cymbal_priority[item[0]], -item[1].confidence))[0]
        for drum, _ in cymbals:
            if drum != keep_drum:
                del result[(tick, drum)]

    return result


def _articulation_for(drum: DrumNote, confidence: float) -> str:
    if drum == "hihat_open":
        return "open"
    if drum in {"crash", "ride"} and confidence >= 0.82:
        return "accent"
    return "none"
