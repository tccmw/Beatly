from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class UniversalInstrumentSpec:
    slug: str
    family: str
    midi_note: int
    staff_key: str
    voice: int
    notehead: str
    display_line: float
    sample_articulation: str


DRUM_INSTRUMENT_SPECS: tuple[UniversalInstrumentSpec, ...] = (
    UniversalInstrumentSpec(
        slug="crash",
        family="drum-kit",
        midi_note=49,
        staff_key="a/5",
        voice=1,
        notehead="x",
        display_line=-1.5,
        sample_articulation="accent",
    ),
    UniversalInstrumentSpec(
        slug="hihat_open",
        family="drum-kit",
        midi_note=46,
        staff_key="g/5",
        voice=1,
        notehead="x",
        display_line=-1.0,
        sample_articulation="open",
    ),
    UniversalInstrumentSpec(
        slug="hihat_closed",
        family="drum-kit",
        midi_note=42,
        staff_key="g/5",
        voice=1,
        notehead="x",
        display_line=-1.0,
        sample_articulation="closed",
    ),
    UniversalInstrumentSpec(
        slug="ride",
        family="drum-kit",
        midi_note=51,
        staff_key="f/5",
        voice=1,
        notehead="x",
        display_line=-0.5,
        sample_articulation="accent",
    ),
    UniversalInstrumentSpec(
        slug="snare",
        family="drum-kit",
        midi_note=38,
        staff_key="c/5",
        voice=1,
        notehead="normal",
        display_line=1.5,
        sample_articulation="none",
    ),
    UniversalInstrumentSpec(
        slug="tom",
        family="drum-kit",
        midi_note=45,
        staff_key="e/5",
        voice=1,
        notehead="normal",
        display_line=0.5,
        sample_articulation="none",
    ),
    UniversalInstrumentSpec(
        slug="kick",
        family="drum-kit",
        midi_note=36,
        staff_key="f/4",
        voice=2,
        notehead="normal",
        display_line=3.5,
        sample_articulation="none",
    ),
)


ALL_INSTRUMENT_SPECS: dict[str, UniversalInstrumentSpec] = {
    spec.slug: spec
    for spec in DRUM_INSTRUMENT_SPECS
}
