from __future__ import annotations

import logging
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.models import AnalysisResult, LyricWord
from app.services.audio_preprocess import AudioPreprocessError, prepare_audio_for_analysis
from app.services.drum_analysis import analyze_drum_track
from app.services.drum_separation import DrumSeparationError, separate_stems_with_demucs
from app.services.lyrics import preload_whisper_model, transcribe_words_with_whisper
from app.services.notation import TICKS_PER_QUARTER, build_engraved_measures, build_midi_tick_list
from app.services.score_merge import build_lyric_lane, merge_drums_and_lyrics

logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    if settings.enable_lyrics and not settings.use_stubs:
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

    request_id = uuid4().hex[:8]
    upload_path = settings.upload_dir / f"{request_id}{Path(file.filename).suffix.lower()}"
    with upload_path.open("wb") as destination:
        shutil.copyfileobj(file.file, destination)

    try:
        analysis_started = time.perf_counter()
        logger.info("[%s] analysis started for %s", request_id, file.filename)

        step_started = time.perf_counter()
        logger.info("[%s] demucs separation started mode=%s", request_id, settings.demucs_mode)
        stems = separate_stems_with_demucs(
            upload_path,
            settings.separated_dir / upload_path.stem,
            use_stub=settings.use_stubs,
            model_name=settings.demucs_model,
            mode=settings.demucs_mode,
            device=settings.demucs_device,
            jobs=settings.demucs_jobs,
            segment_seconds=settings.demucs_segment_seconds,
        )
        logger.info("[%s] demucs separation finished in %.1fs", request_id, time.perf_counter() - step_started)

        step_started = time.perf_counter()
        logger.info("[%s] audio preprocessing started", request_id)
        prepared_audio = prepare_audio_for_analysis(
            stems.drums,
            stems.vocals,
            settings.separated_dir / upload_path.stem / "prepared",
            include_vocals=settings.enable_lyrics,
        )
        logger.info("[%s] audio preprocessing finished in %.1fs", request_id, time.perf_counter() - step_started)

        step_started = time.perf_counter()
        logger.info("[%s] drum analysis started", request_id)
        bpm, drum_events = analyze_drum_track(prepared_audio.drums)
        logger.info("[%s] drum analysis finished in %.1fs with %d events", request_id, time.perf_counter() - step_started, len(drum_events))

        if settings.enable_lyrics:
            step_started = time.perf_counter()
            logger.info("[%s] whisper transcription started model=%s", request_id, settings.whisper_model)
            words = transcribe_words_with_whisper(
                prepared_audio.vocals,
                model_name=settings.whisper_model,
                use_stub=settings.use_stubs,
            )
            logger.info("[%s] whisper transcription finished in %.1fs with %d words", request_id, time.perf_counter() - step_started, len(words))
        else:
            logger.info("[%s] whisper transcription skipped because BEATLY_ENABLE_LYRICS=false", request_id)
            words = []

        step_started = time.perf_counter()
        logger.info("[%s] notation merge started", request_id)
        events = merge_drums_and_lyrics(drum_events, words)
        midi_ticks = build_midi_tick_list(events, bpm)
        measure_count = max(
            max((tick.measure for tick in midi_ticks), default=1),
            _measure_count_from_words(words, bpm),
        )
        lyric_lane = build_lyric_lane(words, bpm, measure_count)
        engraved_measures = build_engraved_measures(midi_ticks, lyric_lane=lyric_lane)
        logger.info(
            "[%s] notation merge finished in %.1fs with %d measures",
            request_id,
            time.perf_counter() - step_started,
            len(engraved_measures),
        )
        logger.info("[%s] analysis finished in %.1fs", request_id, time.perf_counter() - analysis_started)
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
    except AudioPreprocessError as exc:
        raise HTTPException(status_code=502, detail=f"Audio preprocessing failed: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}") from exc


def _measure_count_from_words(words: list[LyricWord], bpm: float) -> int:
    if not words:
        return 1

    beat_seconds = 60 / max(bpm, 1)
    measure_seconds = beat_seconds * 4
    return max(1, max(int(word.start // measure_seconds) + 1 for word in words))
