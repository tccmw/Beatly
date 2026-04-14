from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


class DrumSeparationError(RuntimeError):
    pass


def separate_drums_with_demucs(input_audio: Path, output_dir: Path, use_stub: bool = False) -> Path:
    """Return a path to an isolated drum stem.

    Demucs writes stems under: output_dir/htdemucs/<track_name>/drums.wav.
    For stub mode, the original file is copied and treated as the drum stem so
    the rest of the pipeline remains testable without model downloads.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    if use_stub:
        stub_path = output_dir / f"{input_audio.stem}.drums.wav"
        shutil.copyfile(input_audio, stub_path)
        return stub_path

    command = [
        "python",
        "-m",
        "demucs.separate",
        "--two-stems",
        "drums",
        "--name",
        "htdemucs",
        "--out",
        str(output_dir),
        str(input_audio),
    ]

    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise DrumSeparationError(completed.stderr or completed.stdout)

    drum_path = output_dir / "htdemucs" / input_audio.stem / "drums.wav"
    if not drum_path.exists():
        raise DrumSeparationError(f"Demucs completed, but drum stem was not found at {drum_path}")

    return drum_path
