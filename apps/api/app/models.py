from typing import Literal

from pydantic import BaseModel, Field


DrumNote = Literal["kick", "snare", "hihat_closed", "hihat_open", "tom", "crash", "ride"]
NotationVoice = Literal[1, 2]
Articulation = Literal["accent", "open", "closed", "ghost", "none"]


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


class EngravedSlot(BaseModel):
    slot: int
    lyric: str | None = None


class EngravedMeasure(BaseModel):
    measure: int
    voice1: list[EngravedTick]
    voice2: list[EngravedTick]
    slots: list[EngravedSlot] = Field(default_factory=list)
    lyric_slots: list[LyricSlot] = Field(default_factory=list)


class AnalysisResult(BaseModel):
    bpm: float
    events: list[ScoreEvent]
    words: list[LyricWord]
    ticks_per_quarter: int = 480
    midi_ticks: list[MidiTickEvent] = Field(default_factory=list)
    engraved_measures: list[EngravedMeasure] = Field(default_factory=list)


class AnalysisJobStatus(BaseModel):
    job_id: str
    status: Literal["queued", "running", "succeeded", "failed"]
    detail: str | None = None
    result: AnalysisResult | None = None
