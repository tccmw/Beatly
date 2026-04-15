from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class DrumSeparationError(RuntimeError):
    pass


@dataclass(frozen=True)
class StemPaths:
    drums: Path
    vocals: Path


def separate_stems_with_demucs(input_audio: Path, output_dir: Path, use_stub: bool = False) -> StemPaths:
    output_dir.mkdir(parents=True, exist_ok=True)

    if use_stub:
        drum_stub = output_dir / f"{input_audio.stem}.drums.wav"
        vocal_stub = output_dir / f"{input_audio.stem}.vocals.wav"
        shutil.copyfile(input_audio, drum_stub)
        shutil.copyfile(input_audio, vocal_stub)
        return StemPaths(drums=drum_stub, vocals=vocal_stub)

    command = [
        "python",
        "-m",
        "demucs.separate",
        "--name",
        "htdemucs",
        "--out",
        str(output_dir),
        str(input_audio),
    ]

    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise DrumSeparationError(completed.stderr or completed.stdout)

    stem_dir = output_dir / "htdemucs" / input_audio.stem
    drum_path = stem_dir / "drums.wav"
    vocal_path = stem_dir / "vocals.wav"
    if not drum_path.exists():
        raise DrumSeparationError(f"Demucs completed, but drum stem was not found at {drum_path}")
    if not vocal_path.exists():
        raise DrumSeparationError(f"Demucs completed, but vocal stem was not found at {vocal_path}")

    return StemPaths(drums=drum_path, vocals=vocal_path)


def separate_drums_with_demucs(input_audio: Path, output_dir: Path, use_stub: bool = False) -> Path:
    """Return a path to an isolated drum stem.

    Demucs writes stems under: output_dir/htdemucs/<track_name>/drums.wav.
    For stub mode, the original file is copied and treated as the drum stem so
    the rest of the pipeline remains testable without model downloads.
    """
    return separate_stems_with_demucs(input_audio, output_dir, use_stub=use_stub).drums
