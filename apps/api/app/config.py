from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    upload_dir: Path = Field(default=Path("uploads"), alias="BEATLY_UPLOAD_DIR")
    separated_dir: Path = Field(default=Path("separated"), alias="BEATLY_SEPARATED_DIR")
    whisper_model: str = Field(default="small", alias="WHISPER_MODEL")
    use_stubs: bool = Field(default=False, alias="BEATLY_USE_STUBS")


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    settings.separated_dir.mkdir(parents=True, exist_ok=True)
    return settings
