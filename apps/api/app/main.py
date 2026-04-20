from __future__ import annotations

import logging
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.models import AnalysisJobStatus, AnalysisResult, LyricWord
from app.services.audio_preprocess import AudioPreprocessError, prepare_audio_for_analysis
from app.services.drum_analysis import analyze_drum_track
from app.services.drum_separation import DrumSeparationError, separate_stems_with_demucs
from app.services.lyrics import preload_whisper_model, transcribe_words_with_whisper
from app.services.notation import TICKS_PER_QUARTER, build_engraved_measures, build_midi_tick_list
from app.services.score_merge import build_lyric_lane, merge_drums_and_lyrics

logger = logging.getLogger("uvicorn.error")
KOREAN_WHISPER_MODELS = {"tiny", "base", "small", "medium", "large-v3"}
_jobs: dict[str, AnalysisJobStatus] = {}
_jobs_lock = Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    if settings.enable_lyrics and not settings.use_stubs:
        preload_whisper_model(_korean_whisper_model(settings.whisper_model))
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
async def analyze(
    file: UploadFile = File(...),
    enable_lyrics: bool | None = Form(default=None),
) -> AnalysisResult:
    settings = get_settings()
    should_extract_lyrics = settings.enable_lyrics if enable_lyrics is None else enable_lyrics
    request_id = uuid4().hex[:8]
    upload_path = _save_upload(file, request_id, settings.upload_dir)

    try:
        return _run_analysis(upload_path, file.filename or upload_path.name, request_id, should_extract_lyrics)
    except DrumSeparationError as exc:
        raise HTTPException(status_code=502, detail=f"Drum separation failed: {exc}") from exc
    except AudioPreprocessError as exc:
        raise HTTPException(status_code=502, detail=f"Audio preprocessing failed: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}") from exc


@app.post("/analyze/jobs", response_model=AnalysisJobStatus)
async def start_analysis_job(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    enable_lyrics: bool | None = Form(default=None),
) -> AnalysisJobStatus:
    settings = get_settings()
    should_extract_lyrics = settings.enable_lyrics if enable_lyrics is None else enable_lyrics
    request_id = uuid4().hex[:8]
    upload_path = _save_upload(file, request_id, settings.upload_dir)
    job = AnalysisJobStatus(
        job_id=request_id,
        status="queued",
        detail="Queued for analysis.",
    )
    _set_job(job)
    background_tasks.add_task(
        _run_analysis_job,
        request_id,
        upload_path,
        file.filename or upload_path.name,
        should_extract_lyrics,
    )
    return job


@app.get("/analyze/jobs/{job_id}", response_model=AnalysisJobStatus)
def get_analysis_job(job_id: str) -> AnalysisJobStatus:
    job = _get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Analysis job not found.")
    return job


def _run_analysis_job(
    job_id: str,
    upload_path: Path,
    original_filename: str,
    should_extract_lyrics: bool,
) -> None:
    _update_job(job_id, status="running", detail="Analyzing audio.")
    try:
        result = _run_analysis(upload_path, original_filename, job_id, should_extract_lyrics)
    except Exception as exc:
        logger.exception("[%s] background analysis failed", job_id)
        _update_job(job_id, status="failed", detail=f"Analysis failed: {exc}", result=None)
        return

    _update_job(job_id, status="succeeded", detail="Analysis finished.", result=result)


def _run_analysis(
    upload_path: Path,
    original_filename: str,
    request_id: str,
    should_extract_lyrics: bool,
) -> AnalysisResult:
    settings = get_settings()
    analysis_started = time.perf_counter()
    logger.info("[%s] analysis started for %s", request_id, original_filename)
    demucs_mode = _demucs_mode_for_request(
        settings.demucs_mode,
        should_extract_lyrics,
        settings.force_vocals_for_lyrics,
    )
    whisper_model = _korean_whisper_model(settings.whisper_model) if should_extract_lyrics else settings.whisper_model

    step_started = time.perf_counter()
    logger.info("[%s] demucs separation started mode=%s", request_id, demucs_mode)
    stems = separate_stems_with_demucs(
        upload_path,
        settings.separated_dir / upload_path.stem,
        use_stub=settings.use_stubs,
        model_name=settings.demucs_model,
        mode=demucs_mode,
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
        include_vocals=should_extract_lyrics,
    )
    logger.info("[%s] audio preprocessing finished in %.1fs", request_id, time.perf_counter() - step_started)

    step_started = time.perf_counter()
    logger.info("[%s] drum analysis started", request_id)
    bpm, drum_events = analyze_drum_track(prepared_audio.drums)
    logger.info(
        "[%s] drum analysis finished in %.1fs with %d events",
        request_id,
        time.perf_counter() - step_started,
        len(drum_events),
    )

    if should_extract_lyrics:
        step_started = time.perf_counter()
        logger.info(
            "[%s] whisper transcription started model=%s language=ko word_timestamps=True",
            request_id,
            whisper_model,
        )
        words = transcribe_words_with_whisper(
            prepared_audio.vocals,
            model_name=whisper_model,
            use_stub=settings.use_stubs,
            language="ko",
            word_timestamps=True,
        )
        logger.info(
            "[%s] whisper transcription finished in %.1fs with %d words",
            request_id,
            time.perf_counter() - step_started,
            len(words),
        )
    else:
        logger.info("[%s] whisper transcription skipped because lyrics are disabled for this request", request_id)
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


def _save_upload(file: UploadFile, request_id: str, upload_dir: Path) -> Path:
    if not file.filename or not file.filename.lower().endswith((".mp3", ".wav", ".m4a", ".flac")):
        raise HTTPException(status_code=400, detail="Upload an MP3, WAV, M4A, or FLAC file.")

    upload_path = upload_dir / f"{request_id}{Path(file.filename).suffix.lower()}"
    with upload_path.open("wb") as destination:
        shutil.copyfileobj(file.file, destination)
    return upload_path


def _set_job(job: AnalysisJobStatus) -> None:
    with _jobs_lock:
        _jobs[job.job_id] = job


def _update_job(job_id: str, **updates: object) -> None:
    with _jobs_lock:
        current = _jobs.get(job_id)
        if current is None:
            return
        _jobs[job_id] = current.model_copy(update=updates)


def _get_job(job_id: str) -> AnalysisJobStatus | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return job.model_copy() if job else None


def _measure_count_from_words(words: list[LyricWord], bpm: float) -> int:
    if not words:
        return 1

    beat_seconds = 60 / max(bpm, 1)
    measure_seconds = beat_seconds * 4
    return max(1, max(int(word.start // measure_seconds) + 1 for word in words))


def _demucs_mode_for_request(configured_mode: str, enable_lyrics: bool, force_vocals_for_lyrics: bool) -> str:
    mode = configured_mode.lower().strip()
    if enable_lyrics and force_vocals_for_lyrics and mode in {"none", "off", "skip"}:
        return "vocals"
    return configured_mode


def _korean_whisper_model(configured_model: str) -> str:
    model = configured_model.strip()
    if model in KOREAN_WHISPER_MODELS:
        return model
    logger.warning("WHISPER_MODEL=%s is not supported; using base", configured_model)
    return "base"
