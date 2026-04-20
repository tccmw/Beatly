from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    upload_dir: Path = Field(default=Path("uploads"), alias="BEATLY_UPLOAD_DIR")
    separated_dir: Path = Field(default=Path("separated"), alias="BEATLY_SEPARATED_DIR")
    whisper_model: str = Field(default="large-v3-turbo", alias="WHISPER_MODEL")
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
    return settings
