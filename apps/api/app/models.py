from typing import Literal

from pydantic import BaseModel, Field


DrumNote = Literal["kick", "snare", "hihat_closed", "hihat_open", "tom", "crash", "ride"]
NotationVoice = Literal[1, 2]
Articulation = Literal["accent", "open", "closed", "ghost", "none"]
InstrumentType = Literal["DRUM", "BASS", "GUITAR", "KEYBOARD"]
BassRenderMode = Literal["standard", "tab", "both"]
BassDuration = Literal["w", "h", "q", "8", "16"]
BassSlideDirection = Literal["up", "down"]


class LyricWord(BaseModel):
    word: str
    start: float
    end: float


class DrumEvent(BaseModel):
    time: float
    note: DrumNote
    confidence: float = Field(ge=0, le=1)


class ScoreEvent(BaseModel):
    time: float
    note: DrumNote
    lyric: str | None = None
    confidence: float = Field(ge=0, le=1)


class MidiTickEvent(BaseModel):
    tick: int
    duration_ticks: int
    measure: int
    slot: int
    voice: NotationVoice
    midi_note: int
    drum: DrumNote
    staff_key: str
    notehead: Literal["normal", "x"]
    articulation: Articulation = "none"
    lyric: str | None = None
    confidence: float = Field(ge=0, le=1)


class EngravedEvent(BaseModel):
    drum: DrumNote
    midi_note: int
    staff_key: str
    notehead: Literal["normal", "x"]
    articulation: Articulation = "none"
    lyric: str | None = None
    confidence: float = Field(ge=0, le=1)


class EngravedTick(BaseModel):
    slot: int
    duration: Literal["q", "8", "16"]
    duration_ticks: int
    rest: bool
    voice: NotationVoice
    events: list[EngravedEvent]
    lyric: str | None = None


class LyricSlot(BaseModel):
    slot: int
    lyric: str
    row: int = 0


class EngravedSlot(BaseModel):
    slot: int
    lyric: str | None = None


class EngravedMeasure(BaseModel):
    measure: int
    voice1: list[EngravedTick]
    voice2: list[EngravedTick]
    slots: list[EngravedSlot] = Field(default_factory=list)
    lyric_slots: list[LyricSlot] = Field(default_factory=list)


class BassSpecNote(BaseModel):
    id: str | None = None
    time: float | None = None
    measure: int | None = None
    slot: int | None = None
    duration: BassDuration | None = None
    duration_slots: int | None = None
    midi_note: int | None = None
    staff_key: str | None = None
    string: Literal[1, 2, 3, 4] | None = None
    fret: int | Literal["X", "x", "0"] | None = None
    lyric: str | None = None
    confidence: float | None = None
    chord: str | None = None
    harmony: str | None = None
    technique: str | None = None
    techniques: list[str] = Field(default_factory=list)
    is_dead: bool = False
    is_staccato: bool = False
    tie_to_next: bool = False
    tie_from_previous: bool = False
    slur_to_next: bool = False
    slur_from_previous: bool = False
    slide_direction: BassSlideDirection | None = None
    slide_out_direction: BassSlideDirection | None = None
    slide_out_to_nowhere: bool = False
    prefer_string: Literal[1, 2, 3, 4] | None = None
    slap_style: bool = False
    is_pop: bool = False
    is_pull_off: bool = False


class BassSpec(BaseModel):
    mode: BassRenderMode = "both"
    notes: list[BassSpecNote] = Field(default_factory=list)


class AnalysisTrack(BaseModel):
    id: str | None = None
    label: str | None = None
    name: str | None = None
    bpm: float | None = None
    instrumentType: InstrumentType | None = None
    instrument_type: InstrumentType | None = None
    bassSpec: BassSpec | None = None
    bass_spec: BassSpec | None = None
    BASS_SPEC: BassSpec | None = None
    words: list[LyricWord] = Field(default_factory=list)
    midi_ticks: list[MidiTickEvent] = Field(default_factory=list)
    engraved_measures: list[EngravedMeasure] = Field(default_factory=list)


class AnalysisResult(BaseModel):
    bpm: float
    events: list[ScoreEvent]
    words: list[LyricWord]
    ticks_per_quarter: int = 480
    midi_ticks: list[MidiTickEvent] = Field(default_factory=list)
    engraved_measures: list[EngravedMeasure] = Field(default_factory=list)
    instrumentType: InstrumentType | None = None
    instrument_type: InstrumentType | None = None
    bassSpec: BassSpec | None = None
    bass_spec: BassSpec | None = None
    BASS_SPEC: BassSpec | None = None
    tracks: list[AnalysisTrack] = Field(default_factory=list)


class AnalysisJobStatus(BaseModel):
    job_id: str
    status: Literal["queued", "running", "succeeded", "failed"]
    detail: str | None = None
    result: AnalysisResult | None = None
