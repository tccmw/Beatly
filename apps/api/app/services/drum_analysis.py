from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np

from app.models import DrumEvent, DrumNote


def estimate_bpm(audio_path: Path) -> float:
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    if isinstance(tempo, np.ndarray):
        tempo = float(tempo[0])
    return round(float(tempo), 2)


def detect_drum_events(audio_path: Path) -> list[DrumEvent]:
    """Detect coarse drum events from an isolated drum stem.

    This is intentionally heuristic: Demucs isolates the drum stem, then librosa
    onset detection finds hit times. Spectral features classify common drum
    voices well enough to produce editable notation. A production system can
    replace `_classify_hit` with a trained drum transcription model without
    changing the API contract.
    """
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    onset_frames = librosa.onset.onset_detect(
        y=y,
        sr=sr,
        units="frames",
        backtrack=True,
        pre_max=4,
        post_max=4,
        pre_avg=8,
        post_avg=8,
        delta=0.18,
        wait=2,
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr)
    rms = librosa.feature.rms(y=y)[0]

    events: list[DrumEvent] = []
    for frame, time in zip(onset_frames, onset_times):
        start = max(0, librosa.frames_to_samples(frame) - int(0.035 * sr))
        end = min(len(y), start + int(0.16 * sr))
        segment = y[start:end]
        if segment.size < 32:
            continue

        note, confidence = _classify_hit(segment, sr)
        energy_confidence = min(1.0, float(rms[min(frame, len(rms) - 1)] * 18))
        events.append(
            DrumEvent(
                time=round(float(time), 3),
                note=note,
                confidence=round(max(confidence, energy_confidence), 3),
            )
        )

    return _dedupe_events(events)


def _classify_hit(segment: np.ndarray, sr: int) -> tuple[DrumNote, float]:
    centroid = float(librosa.feature.spectral_centroid(y=segment, sr=sr)[0].mean())
    bandwidth = float(librosa.feature.spectral_bandwidth(y=segment, sr=sr)[0].mean())
    zcr = float(librosa.feature.zero_crossing_rate(segment)[0].mean())
    spectrum = np.abs(np.fft.rfft(segment))
    freqs = np.fft.rfftfreq(segment.size, 1 / sr)

    low = _band_energy(spectrum, freqs, 35, 140)
    mid = _band_energy(spectrum, freqs, 160, 900)
    high = _band_energy(spectrum, freqs, 2500, 10000)
    total = max(low + mid + high, 1e-9)

    low_ratio = low / total
    mid_ratio = mid / total
    high_ratio = high / total

    if low_ratio > 0.52 and centroid < 900:
        return "kick", min(0.98, 0.62 + low_ratio)
    if high_ratio > 0.5 and zcr > 0.08:
        if bandwidth > 4200 or centroid > 6500:
            return "crash", min(0.95, 0.48 + high_ratio)
        return "hihat_closed", min(0.94, 0.5 + high_ratio)
    if mid_ratio > 0.36 and centroid < 3200:
        return "snare", min(0.92, 0.5 + mid_ratio)
    if low_ratio > 0.28 and mid_ratio > 0.28:
        return "tom", 0.72
    return "ride", 0.58


def _band_energy(spectrum: np.ndarray, freqs: np.ndarray, low: float, high: float) -> float:
    mask = (freqs >= low) & (freqs <= high)
    return float(np.sum(spectrum[mask] ** 2))


def _dedupe_events(events: list[DrumEvent]) -> list[DrumEvent]:
    if not events:
        return []

    result = [events[0]]
    for event in events[1:]:
        previous = result[-1]
        if event.note == previous.note and event.time - previous.time < 0.055:
            if event.confidence > previous.confidence:
                result[-1] = event
            continue
        result.append(event)
    return result
