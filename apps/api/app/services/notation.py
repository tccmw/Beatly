from __future__ import annotations

from dataclasses import dataclass

from app.models import (
    DrumNote,
    EngravedEvent,
    EngravedMeasure,
    EngravedSlot,
    EngravedTick,
    LyricSlot,
    MidiTickEvent,
    ScoreEvent,
)

TICKS_PER_QUARTER = 480
SIXTEENTH_TICKS = TICKS_PER_QUARTER // 4
MEASURE_TICKS = TICKS_PER_QUARTER * 4
SLOTS_PER_MEASURE = 16
CLUSTER_WINDOW_SECONDS = 0.02
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
    optimized = _dedupe_cymbals_per_slot(optimized)
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


def build_engraved_measures(
    midi_ticks: list[MidiTickEvent],
    lyric_lane: dict[int, list[LyricSlot]] | None = None,
) -> list[EngravedMeasure]:
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

    lyric_measure_count = max(lyric_lane.keys(), default=1) if lyric_lane else 1
    measure_count = max(max(grouped.keys(), default=1), lyric_measure_count)
    measures: list[EngravedMeasure] = []
    for measure_number in range(1, measure_count + 1):
        slots = _empty_measure_slots()
        measure_lyrics = lyric_lane.get(measure_number, []) if lyric_lane else []
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
                slots=_engraved_slots_from_lyric_slots(measure_lyrics),
                lyric_slots=measure_lyrics,
            )
        )
    return _sanitize_engraved_measures(measures)


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


def _dedupe_cymbals_per_slot(
    by_slot: dict[tuple[int, DrumNote], ScoreEvent],
) -> dict[tuple[int, DrumNote], ScoreEvent]:
    result = dict(by_slot)
    cymbal_priority: dict[DrumNote, int] = {
        "hihat_closed": 0,
        "hihat_open": 1,
        "ride": 2,
        "crash": 3,
        "snare": 9,
        "kick": 9,
        "tom": 9,
    }

    for tick in sorted({tick for tick, _ in result}):
        cymbals = [
            (drum, event)
            for (event_tick, drum), event in result.items()
            if event_tick == tick and drum in CYMBALS
        ]
        if len(cymbals) <= 1:
            continue

        keep_drum, _ = sorted(cymbals, key=lambda item: (cymbal_priority[item[0]], -item[1].confidence))[0]
        for drum, _ in cymbals:
            if drum != keep_drum:
                del result[(tick, drum)]

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


def _sanitize_engraved_measures(measures: list[EngravedMeasure]) -> list[EngravedMeasure]:
    sanitized: list[EngravedMeasure] = []
    for measure in measures:
        voice1 = _sanitize_voice_ticks(measure.voice1, 1)
        voice2 = _sanitize_bass_voice_ticks(measure.voice2)
        lyric_slots = _sanitize_lyric_slots(measure.lyric_slots)
        sanitized.append(
            EngravedMeasure(
                measure=measure.measure,
                voice1=voice1,
                voice2=voice2,
                slots=_engraved_slots_from_lyric_slots(lyric_slots),
                lyric_slots=lyric_slots,
            )
        )
    return sanitized


def _sanitize_voice_ticks(ticks: list[EngravedTick], voice: int) -> list[EngravedTick]:
    cleaned: list[EngravedTick] = []
    for tick in ticks:
        duration = tick.duration if tick.duration in {"q", "8", "16"} else "16"
        slot = min(SLOTS_PER_MEASURE - 1, max(0, tick.slot))
        events = _sanitize_tick_events(tick.events, voice)
        cleaned.append(
            EngravedTick(
                slot=slot,
                duration=duration,
                duration_ticks=_duration_ticks(duration),
                rest=tick.rest or not events,
                voice=1 if voice == 1 else 2,
                events=events,
                lyric=tick.lyric,
            )
        )

    return _rebalance_voice_to_4_4(cleaned, voice)


def _sanitize_bass_voice_ticks(ticks: list[EngravedTick]) -> list[EngravedTick]:
    """Bass drum output policy: no beamed 16th groups in the lower voice."""
    kick_slots = {
        tick.slot
        for tick in ticks
        if not tick.rest and any(event.drum == "kick" for event in tick.events)
    }
    kick_events = {
        tick.slot: [event for event in tick.events if event.drum == "kick"][:1]
        for tick in ticks
        if not tick.rest
    }

    output: list[EngravedTick] = []
    for beat_start in range(0, SLOTS_PER_MEASURE, 4):
        beat_kicks = sorted(slot for slot in kick_slots if beat_start <= slot < beat_start + 4)

        if not beat_kicks:
            output.append(_engraved_rest(beat_start, "q", 2))
            continue

        if len(beat_kicks) == 1:
            slot = beat_kicks[0]
            if slot == beat_start:
                output.append(_engraved_note(slot, "q", 2, kick_events[slot]))
            else:
                for eighth_slot in (beat_start, beat_start + 2):
                    if abs(slot - eighth_slot) <= 1:
                        output.append(_engraved_note(eighth_slot, "8", 2, kick_events[slot]))
                    else:
                        output.append(_engraved_rest(eighth_slot, "8", 2))
            continue

        by_eighth: dict[int, list[EngravedEvent]] = {}
        for slot in beat_kicks:
            target = beat_start if slot < beat_start + 2 else beat_start + 2
            by_eighth.setdefault(target, kick_events[slot])

        for eighth_slot in (beat_start, beat_start + 2):
            events = by_eighth.get(eighth_slot)
            output.append(
                _engraved_note(eighth_slot, "8", 2, events)
                if events
                else _engraved_rest(eighth_slot, "8", 2)
            )

    return output


def _sanitize_tick_events(events: list[EngravedEvent], voice: int) -> list[EngravedEvent]:
    allowed = HAND_DRUMS if voice == 1 else {"kick"}
    playable = [event for event in _dedupe_engraved_events(events) if event.drum in allowed]

    if voice == 1:
        cymbals = [event for event in playable if event.drum in CYMBALS]
        non_cymbals = [event for event in playable if event.drum not in CYMBALS]
        if len(cymbals) > 1:
            cymbals = sorted(cymbals, key=lambda event: (DRUM_MAP[event.drum].order, -event.confidence))[:1]
        playable = sorted([*non_cymbals, *cymbals], key=lambda event: DRUM_MAP[event.drum].order)[:2]

    if voice == 2:
        playable = playable[:1]

    return playable


def _rebalance_voice_to_4_4(ticks: list[EngravedTick], voice: int) -> list[EngravedTick]:
    balanced: list[EngravedTick] = []
    for beat_start in range(0, SLOTS_PER_MEASURE, 4):
        beat_ticks = [
            tick
            for tick in ticks
            if beat_start <= tick.slot < beat_start + 4
        ]
        occupied = [tick for tick in beat_ticks if not tick.rest and tick.events]

        if not occupied:
            balanced.append(_engraved_rest(beat_start, "q", voice))
            continue

        if len(occupied) == 1 and occupied[0].slot == beat_start:
            balanced.append(_engraved_note(beat_start, "q", voice, occupied[0].events))
            continue

        if all(tick.slot % 2 == 0 for tick in occupied):
            by_slot = {tick.slot: tick for tick in occupied}
            for slot in (beat_start, beat_start + 2):
                tick = by_slot.get(slot)
                balanced.append(
                    _engraved_note(slot, "8", voice, tick.events)
                    if tick
                    else _engraved_rest(slot, "8", voice)
                )
            continue

        by_slot = {tick.slot: tick for tick in occupied}
        for slot in range(beat_start, beat_start + 4):
            tick = by_slot.get(slot)
            balanced.append(
                _engraved_note(slot, "16", voice, tick.events)
                if tick
                else _engraved_rest(slot, "16", voice)
            )

    return balanced


def _sanitize_lyric_slots(slots: list[LyricSlot]) -> list[LyricSlot]:
    by_slot: dict[int, list[str]] = {}
    for slot in slots:
        index = min(SLOTS_PER_MEASURE - 1, max(0, slot.slot))
        text = slot.lyric.strip()
        if text:
            by_slot.setdefault(index, []).append(text)

    return [
        LyricSlot(slot=slot, lyric=" ".join(parts))
        for slot, parts in sorted(by_slot.items())
    ]


def _engraved_slots_from_lyric_slots(lyric_slots: list[LyricSlot]) -> list[EngravedSlot]:
    lyric_by_slot = {slot.slot: slot.lyric for slot in lyric_slots}
    return [
        EngravedSlot(slot=slot, lyric=lyric_by_slot.get(slot))
        for slot in range(SLOTS_PER_MEASURE)
    ]
