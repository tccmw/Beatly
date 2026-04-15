from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


class AudioPreprocessError(RuntimeError):
    pass


@dataclass(frozen=True)
class PreparedAudio:
    drums: Path
    vocals: Path


def prepare_audio_for_analysis(
    drums_audio: Path,
    vocals_audio: Path,
    output_dir: Path,
    include_vocals: bool = True,
) -> PreparedAudio:
    """Create lightweight mono WAV files for analysis and transcription.

    MP3 decoding through analysis libraries is slow in Docker. Converting once
    with ffmpeg keeps the downstream librosa and Whisper stages from repeating
    expensive decode/resample work.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    drums_wav = output_dir / "drums-analysis-11025.wav"
    vocals_wav = output_dir / "vocals-whisper-16000.wav"
    _convert_to_mono_wav(drums_audio, drums_wav, sample_rate=11025)
    if include_vocals:
        _convert_to_mono_wav(vocals_audio, vocals_wav, sample_rate=16000)
    else:
        vocals_wav = vocals_audio
    return PreparedAudio(drums=drums_wav, vocals=vocals_wav)


def _convert_to_mono_wav(input_audio: Path, output_audio: Path, sample_rate: int) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_audio),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        str(output_audio),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise AudioPreprocessError(completed.stderr or completed.stdout)
