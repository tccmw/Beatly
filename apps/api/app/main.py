from __future__ import annotations

import shutil
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.models import AnalysisResult
from app.services.drum_analysis import detect_drum_events, estimate_bpm
from app.services.drum_separation import DrumSeparationError, separate_drums_with_demucs
from app.services.lyrics import transcribe_words_with_whisper
from app.services.score_merge import merge_drums_and_lyrics

app = FastAPI(title="Beatly API", version="0.1.0")

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
        drum_stem = separate_drums_with_demucs(
            upload_path,
            settings.separated_dir / upload_path.stem,
            use_stub=settings.use_stubs,
        )
        bpm = estimate_bpm(drum_stem)
        drum_events = detect_drum_events(drum_stem)
        words = transcribe_words_with_whisper(
            upload_path,
            model_name=settings.whisper_model,
            use_stub=settings.use_stubs,
        )
        events = merge_drums_and_lyrics(drum_events, words)
        return AnalysisResult(bpm=bpm, events=events, words=words)
    except DrumSeparationError as exc:
        raise HTTPException(status_code=502, detail=f"Drum separation failed: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}") from exc
