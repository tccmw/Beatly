from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    upload_dir: Path = Field(default=Path("uploads"), alias="BEATLY_UPLOAD_DIR")
    separated_dir: Path = Field(default=Path("separated"), alias="BEATLY_SEPARATED_DIR")
    analysis_cache_dir: Path = Field(default=Path("analysis-cache"), alias="BEATLY_ANALYSIS_CACHE_DIR")
    whisper_model: str = Field(default="large-v3-turbo", alias="WHISPER_MODEL")
    whisper_engine: str = Field(default="faster-whisper", alias="WHISPER_ENGINE")
    whisper_device: str = Field(default="cpu", alias="WHISPER_DEVICE")
    whisper_compute_type: str = Field(default="int8", alias="WHISPER_COMPUTE_TYPE")
    whisper_beam_size: int = Field(default=1, alias="WHISPER_BEAM_SIZE")
    whisper_vad_filter: bool = Field(default=False, alias="WHISPER_VAD_FILTER")
    whisper_download_root: Path | None = Field(default=None, alias="WHISPER_DOWNLOAD_ROOT")
    whisper_openai_fallback: bool = Field(default=False, alias="WHISPER_OPENAI_FALLBACK")
    enable_lyrics: bool = Field(default=True, alias="BEATLY_ENABLE_LYRICS")
    preload_whisper: bool = Field(default=False, alias="BEATLY_PRELOAD_WHISPER")
    force_vocals_for_lyrics: bool = Field(default=True, alias="BEATLY_FORCE_VOCALS_FOR_LYRICS")
    use_stubs: bool = Field(default=False, alias="BEATLY_USE_STUBS")
    demucs_model: str = Field(default="htdemucs", alias="DEMUCS_MODEL")
    demucs_mode: str = Field(default="full", alias="DEMUCS_MODE")
    demucs_device: str | None = Field(default=None, alias="DEMUCS_DEVICE")
    demucs_jobs: int = Field(default=0, alias="DEMUCS_JOBS")
    demucs_segment_seconds: int | None = Field(default=None, alias="DEMUCS_SEGMENT_SECONDS")


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    settings.separated_dir.mkdir(parents=True, exist_ok=True)
    settings.analysis_cache_dir.mkdir(parents=True, exist_ok=True)
    if settings.whisper_download_root is not None:
        settings.whisper_download_root.mkdir(parents=True, exist_ok=True)
    return settings
