from __future__ import annotations

from dataclasses import dataclass

from app.models import DrumNote, EngravedEvent, EngravedMeasure, EngravedTick, MidiTickEvent, ScoreEvent

TICKS_PER_QUARTER = 480
SIXTEENTH_TICKS = TICKS_PER_QUARTER // 4
MEASURE_TICKS = TICKS_PER_QUARTER * 4
SLOTS_PER_MEASURE = 16
CLUSTER_WINDOW_SECONDS = 0.03
VELOCITY_FLOOR_RATIO = 0.3
CYMBALS: set[DrumNote] = {"hihat_closed", "hihat_open", "ride", "crash"}
HAND_DRUMS: set[DrumNote] = {*CYMBALS, "snare"}
FINAL_DRUMS: set[DrumNote] = {*HAND_DRUMS, "kick"}
BACKBEAT_SLOTS = (4, 12)
DEFAULT_KICK_SLOTS = (0, 8)
MAX_KICKS_PER_MEASURE = 4


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
    "tom": DrumMapping(45, "e/5", 1, "normal", 5),
    "kick": DrumMapping(36, "f/4", 2, "normal", 6),
}


def build_midi_tick_list(events: list[ScoreEvent], bpm: float) -> list[MidiTickEvent]:
    """Post-process raw transcription into readable standard drum notation ticks.

    The output is a 16th-note MIDI tick list. It intentionally removes sub-16th
    jitter, separates hats/snare/cymbals into voice 1 and kick into voice 2,
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

    by_slot = _drop_low_confidence_noise(by_slot)
    by_slot = _strip_unplayable_drums(by_slot)
    optimized = _normalize_playable_rock_groove(by_slot)
    optimized = _limit_kick_density(optimized)
    optimized = _limit_hand_polyphony(optimized)
    optimized = _strip_unplayable_drums(optimized)
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


def build_engraved_measures(midi_ticks: list[MidiTickEvent]) -> list[EngravedMeasure]:
    """Return complete, human-readable 4/4 drum notation JSON.

    Absolute constraints:
    - Each voice in each measure sums to exactly 4 quarter notes.
    - Durations are only q, 8, or 16. No 32nd/64th values can be emitted.
    - Beat groups never cross quarter-note boundaries.
    - Simultaneous hits share the same slot.
    """
    grouped: dict[int, list[MidiTickEvent]] = {}
    for event in midi_ticks:
        grouped.setdefault(event.measure, []).append(event)

    measure_count = max(grouped.keys(), default=1)
    measures: list[EngravedMeasure] = []
    for measure_number in range(1, measure_count + 1):
        slots = _empty_measure_slots()
        for event in grouped.get(measure_number, []):
            slot = min(SLOTS_PER_MEASURE - 1, max(0, event.slot))
            voice = 1 if event.voice == 1 else 2
            slots[slot][voice] = _dedupe_engraved_events(
                [
                    *slots[slot][voice],
                    EngravedEvent(
                        drum=event.drum,
                        midi_note=event.midi_note,
                        staff_key=event.staff_key,
                        notehead=event.notehead,
                        articulation=event.articulation,
                        lyric=event.lyric,
                        confidence=event.confidence,
                    ),
                ]
            )

        measures.append(
            EngravedMeasure(
                measure=measure_number,
                voice1=_engrave_voice(slots, 1),
                voice2=_engrave_voice(slots, 2),
            )
        )
    return measures


def _normalize_playable_rock_groove(
    by_slot: dict[tuple[int, DrumNote], ScoreEvent],
) -> dict[tuple[int, DrumNote], ScoreEvent]:
    """Convert noisy raw hits into a playable two-voice rock drum groove."""
    result = dict(by_slot)
    measures = sorted({tick // MEASURE_TICKS for tick, _ in by_slot})

    for measure in measures:
        base_tick = measure * MEASURE_TICKS
        measure_events = [
            (tick, drum, event)
            for (tick, drum), event in by_slot.items()
            if base_tick <= tick < base_tick + MEASURE_TICKS
        ]
        if not measure_events:
            continue

        representative = max((event for _, _, event in measure_events), key=lambda event: event.confidence)
        groove_detected = any(drum in {"kick", "snare"} or drum in CYMBALS for _, drum, _ in measure_events)
        if not groove_detected:
            continue

        _normalize_backbeat_snares(result, base_tick, representative)
        _reconstruct_kicks(result, base_tick, representative)
        _force_consistent_hihat(result, base_tick, representative, measure_events)

    return result


def _normalize_backbeat_snares(
    result: dict[tuple[int, DrumNote], ScoreEvent],
    base_tick: int,
    fallback_event: ScoreEvent,
) -> None:
    snare_items = [
        (tick, event)
        for (tick, drum), event in list(result.items())
        if drum == "snare" and base_tick <= tick < base_tick + MEASURE_TICKS
    ]

    for backbeat_slot in BACKBEAT_SLOTS:
        target_tick = base_tick + backbeat_slot * SIXTEENTH_TICKS
        nearby = [
            (tick, event)
            for tick, event in snare_items
            if abs(((tick - base_tick) // SIXTEENTH_TICKS) - backbeat_slot) <= 1
        ]
        if nearby:
            best_tick, best_event = max(nearby, key=lambda item: item[1].confidence)
            if best_tick != target_tick:
                result.pop((best_tick, "snare"), None)
            result[(target_tick, "snare")] = ScoreEvent(
                time=best_event.time,
                note="snare",
                lyric=best_event.lyric,
                confidence=max(0.74, best_event.confidence),
            )
            continue

        if (target_tick, "snare") not in result:
            result[(target_tick, "snare")] = ScoreEvent(
                time=fallback_event.time,
                note="snare",
                lyric=None,
                confidence=0.68,
            )


def _reconstruct_kicks(
    result: dict[tuple[int, DrumNote], ScoreEvent],
    base_tick: int,
    fallback_event: ScoreEvent,
) -> None:
    kick_slots = {
        (tick - base_tick) // SIXTEENTH_TICKS
        for (tick, drum) in result
        if drum == "kick" and base_tick <= tick < base_tick + MEASURE_TICKS
    }
    if len(kick_slots) >= 2:
        return

    for slot in DEFAULT_KICK_SLOTS:
        tick = base_tick + slot * SIXTEENTH_TICKS
        result.setdefault(
            (tick, "kick"),
            ScoreEvent(time=fallback_event.time, note="kick", lyric=None, confidence=0.7),
        )


def _force_consistent_hihat(
    result: dict[tuple[int, DrumNote], ScoreEvent],
    base_tick: int,
    fallback_event: ScoreEvent,
    measure_events: list[tuple[int, DrumNote, ScoreEvent]],
) -> None:
    snare_slots = {
        (tick - base_tick) // SIXTEENTH_TICKS
        for (tick, drum) in result
        if drum == "snare" and base_tick <= tick < base_tick + MEASURE_TICKS
    }
    open_slots = {
        (tick - base_tick) // SIXTEENTH_TICKS
        for tick, drum, _ in measure_events
        if drum == "hihat_open"
    }

    for tick, drum in list(result):
        if drum in CYMBALS and base_tick <= tick < base_tick + MEASURE_TICKS:
            del result[(tick, drum)]

    target_slots = set(range(0, SLOTS_PER_MEASURE, 2))
    target_slots.update(snare_slots)
    for slot in sorted(target_slots):
        drum: DrumNote = "hihat_open" if slot in open_slots else "hihat_closed"
        result[(base_tick + slot * SIXTEENTH_TICKS, drum)] = ScoreEvent(
            time=fallback_event.time,
            note=drum,
            lyric=None,
            confidence=max(0.72, fallback_event.confidence),
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


def _drop_low_confidence_noise(
    by_slot: dict[tuple[int, DrumNote], ScoreEvent],
) -> dict[tuple[int, DrumNote], ScoreEvent]:
    if not by_slot:
        return {}

    max_confidence = max(event.confidence for event in by_slot.values())
    threshold = max_confidence * VELOCITY_FLOOR_RATIO
    return {
        key: event
        for key, event in by_slot.items()
        if event.confidence >= threshold
    }


def _strip_unplayable_drums(
    by_slot: dict[tuple[int, DrumNote], ScoreEvent],
) -> dict[tuple[int, DrumNote], ScoreEvent]:
    return {
        (tick, drum): event
        for (tick, drum), event in by_slot.items()
        if drum in FINAL_DRUMS
    }


def _limit_kick_density(
    by_slot: dict[tuple[int, DrumNote], ScoreEvent],
) -> dict[tuple[int, DrumNote], ScoreEvent]:
    result = dict(by_slot)
    measures = sorted({tick // MEASURE_TICKS for tick, drum in result if drum == "kick"})
    slot_priority = {
        0: 0,
        8: 1,
        6: 2,
        10: 3,
        2: 4,
        14: 5,
        4: 6,
        12: 7,
    }

    for measure in measures:
        base_tick = measure * MEASURE_TICKS
        kicks = [
            (tick, event)
            for (tick, drum), event in result.items()
            if drum == "kick" and base_tick <= tick < base_tick + MEASURE_TICKS
        ]
        if len(kicks) <= MAX_KICKS_PER_MEASURE:
            continue

        ranked = sorted(
            kicks,
            key=lambda item: (
                slot_priority.get((item[0] - base_tick) // SIXTEENTH_TICKS, 99),
                -item[1].confidence,
            ),
        )
        keep_ticks = {tick for tick, _ in ranked[:MAX_KICKS_PER_MEASURE]}
        for tick, _ in kicks:
            if tick not in keep_ticks:
                del result[(tick, "kick")]

    return result


def _limit_hand_polyphony(
    by_slot: dict[tuple[int, DrumNote], ScoreEvent],
) -> dict[tuple[int, DrumNote], ScoreEvent]:
    result = dict(by_slot)
    hand_priority: dict[DrumNote, int] = {
        "snare": 0,
        "hihat_closed": 1,
        "hihat_open": 2,
        "ride": 3,
        "crash": 4,
        "kick": 9,
    }

    ticks = sorted({tick for tick, _ in result})
    for tick in ticks:
        hand_hits = [
            (drum, event)
            for (event_tick, drum), event in result.items()
            if event_tick == tick and drum in HAND_DRUMS
        ]
        if len(hand_hits) <= 2:
            continue

        keep = {drum for drum, _ in sorted(hand_hits, key=lambda item: (hand_priority[item[0]], -item[1].confidence))[:2]}
        for drum, _ in hand_hits:
            if drum not in keep:
                del result[(tick, drum)]

    return result


def _articulation_for(drum: DrumNote, confidence: float) -> str:
    if drum == "hihat_open":
        return "open"
    if drum == "hihat_closed":
        return "closed"
    if drum == "snare" and confidence < 0.5:
        return "ghost"
    if drum in {"crash", "ride"}:
        return "accent"
    return "none"


def _empty_measure_slots() -> list[dict[int, list[EngravedEvent]]]:
    return [{1: [], 2: []} for _ in range(SLOTS_PER_MEASURE)]


def _engrave_voice(slots: list[dict[int, list[EngravedEvent]]], voice: int) -> list[EngravedTick]:
    ticks: list[EngravedTick] = []
    for beat_start in range(0, SLOTS_PER_MEASURE, 4):
        beat_slots = list(range(beat_start, beat_start + 4))
        occupied = [slot for slot in beat_slots if slots[slot][voice]]

        if not occupied:
            ticks.append(_engraved_rest(beat_start, "q", voice))
            continue

        if len(occupied) == 1 and occupied[0] == beat_start:
            ticks.append(_engraved_note(beat_start, "q", voice, slots[beat_start][voice]))
            continue

        if all(slot % 2 == 0 for slot in occupied):
            for slot in (beat_start, beat_start + 2):
                events = slots[slot][voice]
                ticks.append(
                    _engraved_note(slot, "8", voice, events)
                    if events
                    else _engraved_rest(slot, "8", voice)
                )
            continue

        for slot in beat_slots:
            events = slots[slot][voice]
            ticks.append(
                _engraved_note(slot, "16", voice, events)
                if events
                else _engraved_rest(slot, "16", voice)
            )

    return ticks


def _engraved_note(slot: int, duration: str, voice: int, events: list[EngravedEvent]) -> EngravedTick:
    return EngravedTick(
        slot=slot,
        duration=duration,
        duration_ticks=_duration_ticks(duration),
        rest=False,
        voice=1 if voice == 1 else 2,
        events=events,
        lyric=next((event.lyric for event in events if event.lyric), None),
    )


def _engraved_rest(slot: int, duration: str, voice: int) -> EngravedTick:
    return EngravedTick(
        slot=slot,
        duration=duration,
        duration_ticks=_duration_ticks(duration),
        rest=True,
        voice=1 if voice == 1 else 2,
        events=[],
    )


def _duration_ticks(duration: str) -> int:
    if duration == "q":
        return TICKS_PER_QUARTER
    if duration == "8":
        return TICKS_PER_QUARTER // 2
    return SIXTEENTH_TICKS


def _dedupe_engraved_events(events: list[EngravedEvent]) -> list[EngravedEvent]:
    by_drum: dict[DrumNote, EngravedEvent] = {}
    for event in events:
        current = by_drum.get(event.drum)
        if current is None or event.confidence > current.confidence:
            by_drum[event.drum] = event
    return sorted(by_drum.values(), key=lambda event: DRUM_MAP[event.drum].order)
