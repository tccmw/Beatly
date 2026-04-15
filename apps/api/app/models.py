from typing import Literal

from pydantic import BaseModel, Field


DrumNote = Literal["kick", "snare", "hihat_closed", "hihat_open", "tom", "crash", "ride"]
NotationVoice = Literal[1, 2]


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
    articulation: Literal["accent", "open", "none"] = "none"
    lyric: str | None = None
    confidence: float = Field(ge=0, le=1)


class EngravedEvent(BaseModel):
    drum: DrumNote
    midi_note: int
    staff_key: str
    notehead: Literal["normal", "x"]
    articulation: Literal["accent", "open", "none"] = "none"
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


class EngravedMeasure(BaseModel):
    measure: int
    voice1: list[EngravedTick]
    voice2: list[EngravedTick]


class AnalysisResult(BaseModel):
    bpm: float
    events: list[ScoreEvent]
    words: list[LyricWord]
    ticks_per_quarter: int = 480
    midi_ticks: list[MidiTickEvent] = []
    engraved_measures: list[EngravedMeasure] = []
