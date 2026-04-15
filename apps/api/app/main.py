from __future__ import annotations

import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.models import AnalysisResult, LyricWord
from app.services.drum_analysis import detect_drum_events, estimate_bpm
from app.services.drum_separation import DrumSeparationError, separate_stems_with_demucs
from app.services.lyrics import preload_whisper_model, transcribe_words_with_whisper
from app.services.notation import TICKS_PER_QUARTER, build_engraved_measures, build_midi_tick_list
from app.services.score_merge import build_lyric_lane, merge_drums_and_lyrics


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    if not settings.use_stubs:
        preload_whisper_model(settings.whisper_model)
    yield


app = FastAPI(title="Beatly API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/analyze", response_model=AnalysisResult)
async def analyze(file: UploadFile = File(...)) -> AnalysisResult:
    settings = get_settings()
    if not file.filename or not file.filename.lower().endswith((".mp3", ".wav", ".m4a", ".flac")):
        raise HTTPException(status_code=400, detail="Upload an MP3, WAV, M4A, or FLAC file.")

    upload_path = settings.upload_dir / f"{uuid4().hex}{Path(file.filename).suffix.lower()}"
    with upload_path.open("wb") as destination:
        shutil.copyfileobj(file.file, destination)

    try:
        stems = separate_stems_with_demucs(
            upload_path,
            settings.separated_dir / upload_path.stem,
            use_stub=settings.use_stubs,
        )
        bpm = estimate_bpm(stems.drums)
        drum_events = detect_drum_events(stems.drums)
        words = transcribe_words_with_whisper(
            stems.vocals,
            model_name=settings.whisper_model,
            use_stub=settings.use_stubs,
        )
        events = merge_drums_and_lyrics(drum_events, words)
        midi_ticks = build_midi_tick_list(events, bpm)
        measure_count = max(
            max((tick.measure for tick in midi_ticks), default=1),
            _measure_count_from_words(words, bpm),
        )
        lyric_lane = build_lyric_lane(words, bpm, measure_count)
        engraved_measures = build_engraved_measures(midi_ticks, lyric_lane=lyric_lane)
        return AnalysisResult(
            bpm=bpm,
            events=events,
            words=words,
            ticks_per_quarter=TICKS_PER_QUARTER,
            midi_ticks=midi_ticks,
            engraved_measures=engraved_measures,
        )
    except DrumSeparationError as exc:
        raise HTTPException(status_code=502, detail=f"Drum separation failed: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}") from exc


def _measure_count_from_words(words: list[LyricWord], bpm: float) -> int:
    if not words:
        return 1

    beat_seconds = 60 / max(bpm, 1)
    measure_seconds = beat_seconds * 4
    return max(1, max(int(word.start // measure_seconds) + 1 for word in words))
