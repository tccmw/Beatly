from typing import Literal

from pydantic import BaseModel, Field


DrumNote = Literal["kick", "snare", "hihat_closed", "hihat_open", "tom", "crash", "ride"]


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


class AnalysisResult(BaseModel):
    bpm: float
    events: list[ScoreEvent]
    words: list[LyricWord]
