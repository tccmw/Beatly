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
    bass: Path | None = None


def separate_stems_with_demucs(
    input_audio: Path,
    output_dir: Path,
    use_stub: bool = False,
    model_name: str = "htdemucs",
    mode: str = "full",
    device: str | None = None,
    jobs: int = 0,
    segment_seconds: int | None = None,
) -> StemPaths:
    output_dir.mkdir(parents=True, exist_ok=True)

    if use_stub:
        drum_stub = output_dir / f"{input_audio.stem}.drums.wav"
        vocal_stub = output_dir / f"{input_audio.stem}.vocals.wav"
        bass_stub = output_dir / f"{input_audio.stem}.bass.wav"
        shutil.copyfile(input_audio, drum_stub)
        shutil.copyfile(input_audio, vocal_stub)
        shutil.copyfile(input_audio, bass_stub)
        return StemPaths(drums=drum_stub, vocals=vocal_stub, bass=bass_stub)

    normalized_mode = mode.lower().strip()
    if normalized_mode in {"none", "off", "skip"}:
        return StemPaths(drums=input_audio, vocals=input_audio)

    command = [
        "python",
        "-m",
        "demucs.separate",
        "--name",
        model_name,
        "--out",
        str(output_dir),
    ]
    if normalized_mode == "vocals":
        command.extend(["--two-stems", "vocals"])
    if device:
        command.extend(["--device", device])
    if jobs > 0:
        command.extend(["-j", str(jobs)])
    if segment_seconds and segment_seconds > 0:
        command.extend(["--segment", str(segment_seconds)])
    command.append(str(input_audio))

    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise DrumSeparationError(completed.stderr or completed.stdout)

    stem_dir = output_dir / model_name / input_audio.stem
    drum_path = stem_dir / ("no_vocals.wav" if normalized_mode == "vocals" else "drums.wav")
    vocal_path = stem_dir / "vocals.wav"
    bass_path = stem_dir / "bass.wav" if normalized_mode != "vocals" else None
    if not drum_path.exists():
        raise DrumSeparationError(f"Demucs completed, but analysis stem was not found at {drum_path}")
    if not vocal_path.exists():
        raise DrumSeparationError(f"Demucs completed, but vocal stem was not found at {vocal_path}")
    if bass_path is not None and not bass_path.exists():
        bass_path = None

    return StemPaths(drums=drum_path, vocals=vocal_path, bass=bass_path)


def separate_drums_with_demucs(input_audio: Path, output_dir: Path, use_stub: bool = False) -> Path:
    """Return a path to an isolated drum stem.

    Demucs writes stems under: output_dir/htdemucs/<track_name>/drums.wav.
    For stub mode, the original file is copied and treated as the drum stem so
    the rest of the pipeline remains testable without model downloads.
    """
    return separate_stems_with_demucs(input_audio, output_dir, use_stub=use_stub).drums
