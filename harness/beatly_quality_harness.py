from __future__ import annotations

import argparse
import inspect
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence, get_args

ROOT = Path(__file__).resolve().parents[1]
API_DIR = ROOT / "apps" / "api"
if not API_DIR.exists():
    API_DIR = ROOT
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from instrument_specs import ALL_INSTRUMENT_SPECS, UniversalInstrumentSpec

from app.models import DrumNote, LyricSlot, MidiTickEvent, ScoreEvent
from app.services import lyrics
from app.services.notation import (
    DRUM_MAP,
    HAND_DRUMS,
    MEASURE_TICKS,
    SIXTEENTH_TICKS,
    build_engraved_measures,
    build_midi_tick_list,
)

FRONTEND_SHEET_PATH = ROOT / "apps" / "web" / "components" / "DrumSheet.tsx"


@dataclass(frozen=True)
class HarnessFailure:
    suite: str
    case: str
    detail: str


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Beatly quality harness")
    parser.add_argument(
        "--suite",
        choices=("all", "common", "instrument"),
        default="all",
        help="Run the common suite, the per-instrument suite, or both.",
    )
    parser.add_argument(
        "--instrument",
        action="append",
        default=[],
        help="Run only the named instrument spec. Repeat to select multiple instruments.",
    )
    return parser.parse_args()


def _failure(suite: str, case: str, detail: str) -> HarnessFailure:
    return HarnessFailure(suite=suite, case=case, detail=detail)


def _voice_duration_total(ticks: Sequence[object]) -> int:
    return sum(int(getattr(tick, "duration_ticks", 0)) for tick in ticks)


def _run_common_suite() -> list[HarnessFailure]:
    failures: list[HarnessFailure] = []
    failures.extend(_check_registry_coverage())
    failures.extend(_check_quantization_and_measure_contract())
    failures.extend(_check_voice_and_polyphony_contract())
    failures.extend(_check_lyric_lane_preservation())
    failures.extend(_check_bass_voice_readability())
    failures.extend(_check_whisper_contract())
    return failures


def _run_instrument_suite(selected: Sequence[str] | None = None) -> list[HarnessFailure]:
    failures: list[HarnessFailure] = []
    frontend_note_map, frontend_display_lines = _parse_frontend_maps()
    names = list(selected) if selected else sorted(ALL_INSTRUMENT_SPECS)
    for name in names:
        spec = ALL_INSTRUMENT_SPECS.get(name)
        if spec is None:
            failures.append(_failure("instrument", name, "Unknown instrument spec"))
            continue
        failures.extend(_check_backend_mapping(spec))
        failures.extend(_check_frontend_mapping(spec, frontend_note_map, frontend_display_lines))
        failures.extend(_check_engraving_round_trip(spec))
    return failures


def _check_registry_coverage() -> list[HarnessFailure]:
    failures: list[HarnessFailure] = []
    model_notes = set(get_args(DrumNote))
    harness_notes = set(ALL_INSTRUMENT_SPECS)
    notation_notes = set(DRUM_MAP)

    if model_notes != harness_notes:
        failures.append(
            _failure(
                "common",
                "registry",
                f"Instrument spec coverage mismatch. models={sorted(model_notes)} harness={sorted(harness_notes)}",
            )
        )
    if model_notes != notation_notes:
        failures.append(
            _failure(
                "common",
                "registry",
                f"Notation map coverage mismatch. models={sorted(model_notes)} notation={sorted(notation_notes)}",
            )
        )
    return failures


def _check_quantization_and_measure_contract() -> list[HarnessFailure]:
    failures: list[HarnessFailure] = []
    sample_events = [
        ScoreEvent(time=0.03, note="kick", lyric="ga", confidence=0.95),
        ScoreEvent(time=0.29, note="hihat_closed", confidence=0.93),
        ScoreEvent(time=0.51, note="snare", lyric="na", confidence=0.94),
        ScoreEvent(time=0.78, note="hihat_closed", confidence=0.92),
        ScoreEvent(time=1.01, note="kick", confidence=0.96),
        ScoreEvent(time=1.27, note="tom", confidence=0.91),
        ScoreEvent(time=1.53, note="snare", lyric="da", confidence=0.95),
        ScoreEvent(time=1.81, note="ride", confidence=0.90),
    ]
    midi_ticks = build_midi_tick_list(sample_events, bpm=120)
    measures = build_engraved_measures(midi_ticks)

    for tick in midi_ticks:
        if tick.tick % SIXTEENTH_TICKS != 0:
            failures.append(_failure("common", "quantization", f"Tick {tick.tick} is not on the 1/16 grid"))
        if tick.duration_ticks != SIXTEENTH_TICKS:
            failures.append(
                _failure("common", "quantization", f"Tick {tick.tick} duration {tick.duration_ticks} != {SIXTEENTH_TICKS}")
            )
        if not 0 <= tick.slot < 16:
            failures.append(_failure("common", "quantization", f"Tick {tick.tick} has out-of-range slot {tick.slot}"))

    for measure in measures:
        if _voice_duration_total(measure.voice1) != MEASURE_TICKS:
            failures.append(
                _failure("common", "measure-shape", f"Measure {measure.measure} voice1 totals {_voice_duration_total(measure.voice1)} ticks")
            )
        if _voice_duration_total(measure.voice2) != MEASURE_TICKS:
            failures.append(
                _failure("common", "measure-shape", f"Measure {measure.measure} voice2 totals {_voice_duration_total(measure.voice2)} ticks")
            )
        invalid_durations = {
            tick.duration
            for tick in [*measure.voice1, *measure.voice2]
            if tick.duration not in {"q", "8", "16"}
        }
        if invalid_durations:
            failures.append(
                _failure("common", "measure-shape", f"Measure {measure.measure} emitted unsupported durations {sorted(invalid_durations)}")
            )

    return failures


def _check_voice_and_polyphony_contract() -> list[HarnessFailure]:
    failures: list[HarnessFailure] = []
    sample_events = [
        ScoreEvent(time=0.0, note="snare", confidence=0.94),
        ScoreEvent(time=0.0, note="hihat_closed", confidence=0.93),
        ScoreEvent(time=0.0, note="crash", confidence=0.92),
        ScoreEvent(time=0.0, note="tom", confidence=0.91),
        ScoreEvent(time=0.0, note="kick", confidence=0.95),
    ]
    midi_ticks = build_midi_tick_list(sample_events, bpm=120)
    by_tick: dict[int, list[MidiTickEvent]] = {}
    for tick in midi_ticks:
        by_tick.setdefault(tick.tick, []).append(tick)

    for tick, events in by_tick.items():
        hand_hits = [event for event in events if event.drum in HAND_DRUMS]
        if len(hand_hits) > 2:
            failures.append(_failure("common", "polyphony", f"Tick {tick} kept {len(hand_hits)} hand hits"))
        for event in events:
            if event.voice == 1 and event.drum not in HAND_DRUMS:
                failures.append(_failure("common", "voice-separation", f"Voice 1 contains non-hand drum {event.drum} at tick {tick}"))
            if event.voice == 2 and event.drum != "kick":
                failures.append(_failure("common", "voice-separation", f"Voice 2 contains non-kick drum {event.drum} at tick {tick}"))

    return failures


def _check_lyric_lane_preservation() -> list[HarnessFailure]:
    failures: list[HarnessFailure] = []
    lyric_lane = {
        1: [LyricSlot(slot=3, lyric="ga"), LyricSlot(slot=7, lyric="na")],
        2: [LyricSlot(slot=5, lyric="da")],
    }
    measures = build_engraved_measures([], lyric_lane=lyric_lane)
    if len(measures) != 2:
        failures.append(_failure("common", "lyric-lane", f"Expected 2 lyric-only measures, got {len(measures)}"))
        return failures

    expected = {
        1: {(3, "ga"), (7, "na")},
        2: {(5, "da")},
    }
    for measure in measures:
        actual = {(slot.slot, slot.lyric) for slot in measure.lyric_slots}
        if actual != expected[measure.measure]:
            failures.append(
                _failure(
                    "common",
                    "lyric-lane",
                    f"Measure {measure.measure} lyric slots mismatch. expected={sorted(expected[measure.measure])} actual={sorted(actual)}",
                )
            )
    return failures


def _check_bass_voice_readability() -> list[HarnessFailure]:
    failures: list[HarnessFailure] = []
    kick = ALL_INSTRUMENT_SPECS["kick"]
    midi_ticks = [
        MidiTickEvent(
            tick=slot * SIXTEENTH_TICKS,
            duration_ticks=SIXTEENTH_TICKS,
            measure=1,
            slot=slot,
            voice=2,
            midi_note=kick.midi_note,
            drum="kick",
            staff_key=kick.staff_key,
            notehead=kick.notehead,
            articulation=kick.sample_articulation,
            lyric=None,
            confidence=0.9,
        )
        for slot in (0, 1, 2, 3, 8, 9, 10, 11)
    ]
    measure = build_engraved_measures(midi_ticks)[0]
    if any(not tick.rest and tick.duration == "16" for tick in measure.voice2):
        failures.append(_failure("common", "bass-voice", "Voice 2 emitted 16th-note kicks"))
    if any(not tick.rest and tick.voice != 2 for tick in measure.voice2):
        failures.append(_failure("common", "bass-voice", "Voice 2 output carries the wrong voice number"))
    return failures


def _check_whisper_contract() -> list[HarnessFailure]:
    failures: list[HarnessFailure] = []
    signature = inspect.signature(lyrics.transcribe_words_with_whisper)
    if signature.parameters["word_timestamps"].default is not True:
        failures.append(_failure("common", "whisper", "transcribe_words_with_whisper no longer defaults word_timestamps=True"))
    if not hasattr(lyrics._load_faster_whisper_model, "cache_info"):
        failures.append(_failure("common", "whisper", "_load_faster_whisper_model is not cached"))
    if not hasattr(lyrics._load_whisper_model, "cache_info"):
        failures.append(_failure("common", "whisper", "_load_whisper_model is not cached"))
    preload_source = inspect.getsource(lyrics.preload_whisper_model)
    if "_load_faster_whisper_model" not in preload_source or "_load_whisper_model" not in preload_source:
        failures.append(_failure("common", "whisper", "preload_whisper_model no longer warms the cached loaders"))
    return failures


def _parse_frontend_maps() -> tuple[dict[str, dict[str, str | int]], dict[str, float]]:
    source = FRONTEND_SHEET_PATH.read_text(encoding="utf-8")

    note_map_match = re.search(
        r"const NOTE_MAP:[^{]+\{(?P<body>.*?)^\};",
        source,
        flags=re.MULTILINE | re.DOTALL,
    )
    display_line_match = re.search(
        r"const STAFF_KEY_DISPLAY_LINES:[^{]+\{(?P<body>.*?)^\};",
        source,
        flags=re.MULTILINE | re.DOTALL,
    )
    if note_map_match is None or display_line_match is None:
        raise RuntimeError("Failed to parse DrumSheet NOTE_MAP or STAFF_KEY_DISPLAY_LINES")

    note_map: dict[str, dict[str, str | int]] = {}
    for slug, key, voice, notehead in re.findall(
        r'^\s*(\w+): \{ key: "([^"]+)", voice: ([12]), notehead: "(normal|x)", order: \d+ \},?$',
        note_map_match.group("body"),
        flags=re.MULTILINE,
    ):
        note_map[slug] = {
            "key": key,
            "voice": int(voice),
            "notehead": notehead,
        }

    display_lines: dict[str, float] = {}
    for staff_key, display_line in re.findall(
        r'^\s*"([^"]+)": (-?\d+(?:\.\d+)?),?$',
        display_line_match.group("body"),
        flags=re.MULTILINE,
    ):
        display_lines[staff_key] = float(display_line)

    return note_map, display_lines


def _check_backend_mapping(spec: UniversalInstrumentSpec) -> list[HarnessFailure]:
    failures: list[HarnessFailure] = []
    mapping = DRUM_MAP.get(spec.slug)
    if mapping is None:
        return [_failure("instrument", spec.slug, "Missing backend DRUM_MAP entry")]

    if mapping.midi_note != spec.midi_note:
        failures.append(_failure("instrument", spec.slug, f"Backend midi_note={mapping.midi_note} expected {spec.midi_note}"))
    if mapping.staff_key != spec.staff_key:
        failures.append(_failure("instrument", spec.slug, f"Backend staff_key={mapping.staff_key} expected {spec.staff_key}"))
    if mapping.voice != spec.voice:
        failures.append(_failure("instrument", spec.slug, f"Backend voice={mapping.voice} expected {spec.voice}"))
    if mapping.notehead != spec.notehead:
        failures.append(_failure("instrument", spec.slug, f"Backend notehead={mapping.notehead} expected {spec.notehead}"))
    return failures


def _check_frontend_mapping(
    spec: UniversalInstrumentSpec,
    note_map: dict[str, dict[str, str | int]],
    display_lines: dict[str, float],
) -> list[HarnessFailure]:
    failures: list[HarnessFailure] = []
    frontend = note_map.get(spec.slug)
    if frontend is None:
        failures.append(_failure("instrument", spec.slug, "Missing frontend NOTE_MAP entry"))
        return failures

    if frontend["key"] != spec.staff_key:
        failures.append(_failure("instrument", spec.slug, f"Frontend key={frontend['key']} expected {spec.staff_key}"))
    if frontend["voice"] != spec.voice:
        failures.append(_failure("instrument", spec.slug, f"Frontend voice={frontend['voice']} expected {spec.voice}"))
    if frontend["notehead"] != spec.notehead:
        failures.append(_failure("instrument", spec.slug, f"Frontend notehead={frontend['notehead']} expected {spec.notehead}"))

    display_line = display_lines.get(spec.staff_key)
    if display_line is None:
        failures.append(_failure("instrument", spec.slug, f"Missing STAFF_KEY_DISPLAY_LINES entry for {spec.staff_key}"))
    elif display_line != spec.display_line:
        failures.append(_failure("instrument", spec.slug, f"Display line={display_line} expected {spec.display_line}"))

    return failures


def _check_engraving_round_trip(spec: UniversalInstrumentSpec) -> list[HarnessFailure]:
    failures: list[HarnessFailure] = []
    midi_tick = MidiTickEvent(
        tick=0,
        duration_ticks=SIXTEENTH_TICKS,
        measure=1,
        slot=0,
        voice=spec.voice,
        midi_note=spec.midi_note,
        drum=spec.slug,
        staff_key=spec.staff_key,
        notehead=spec.notehead,
        articulation=spec.sample_articulation,
        lyric="slot-lyric" if spec.voice == 1 else None,
        confidence=0.95,
    )
    measure = build_engraved_measures([midi_tick])[0]
    target_voice = measure.voice1 if spec.voice == 1 else measure.voice2
    other_voice = measure.voice2 if spec.voice == 1 else measure.voice1

    target_events = [
        event
        for tick in target_voice
        if not tick.rest
        for event in tick.events
        if event.drum == spec.slug
    ]
    other_voice_events = [
        event
        for tick in other_voice
        if not tick.rest
        for event in tick.events
        if event.drum == spec.slug
    ]

    if not target_events:
        failures.append(_failure("instrument", spec.slug, "Engraving removed the instrument from its target voice"))
        return failures
    if other_voice_events:
        failures.append(_failure("instrument", spec.slug, "Engraving leaked the instrument into the opposite voice"))

    event = target_events[0]
    if event.midi_note != spec.midi_note:
        failures.append(_failure("instrument", spec.slug, f"Engraved midi_note={event.midi_note} expected {spec.midi_note}"))
    if event.staff_key != spec.staff_key:
        failures.append(_failure("instrument", spec.slug, f"Engraved staff_key={event.staff_key} expected {spec.staff_key}"))
    if event.notehead != spec.notehead:
        failures.append(_failure("instrument", spec.slug, f"Engraved notehead={event.notehead} expected {spec.notehead}"))
    if event.articulation != spec.sample_articulation:
        failures.append(_failure("instrument", spec.slug, f"Engraved articulation={event.articulation} expected {spec.sample_articulation}"))

    return failures


def _print_summary(failures: Sequence[HarnessFailure], suites: Sequence[str], selected_instruments: Sequence[str]) -> None:
    print(f"Beatly harness run: suites={', '.join(suites)}")
    if selected_instruments:
        print(f"Instrument filter: {', '.join(selected_instruments)}")
    if not failures:
        print("PASS: all harness checks succeeded")
        return

    print(f"FAIL: {len(failures)} check(s) failed")
    for failure in failures:
        print(f" - [{failure.suite}] {failure.case}: {failure.detail}")


def main() -> int:
    args = _parse_args()
    suites: list[str] = []
    failures: list[HarnessFailure] = []

    if args.suite in {"all", "common"}:
        suites.append("common")
        failures.extend(_run_common_suite())
    if args.suite in {"all", "instrument"}:
        suites.append("instrument")
        failures.extend(_run_instrument_suite(args.instrument))

    _print_summary(failures, suites, args.instrument)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
