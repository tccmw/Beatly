from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from app.models import DrumEvent, DrumNote

ANALYSIS_SAMPLE_RATE = 11025
HOP_LENGTH = 512
N_FFT = 1024


def estimate_bpm(audio_path: Path) -> float:
    bpm, _ = analyze_drum_track(audio_path)
    return bpm


def detect_drum_events(audio_path: Path) -> list[DrumEvent]:
    _, events = analyze_drum_track(audio_path)
    return events


def analyze_drum_track(audio_path: Path) -> tuple[float, list[DrumEvent]]:
    """Detect coarse drum events from an isolated drum stem.

    This is intentionally heuristic: Demucs isolates the drum stem, then librosa
    onset detection finds hit times. Spectral features classify common drum
    voices well enough to produce editable notation. A production system can
    replace `_classify_hit` with a trained drum transcription model without
    changing the API contract.
    """
    y, sr = _load_analysis_audio(audio_path)
    if y.size < N_FFT:
        return 120.0, []

    onset_envelope = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH, n_fft=N_FFT)
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_envelope,
        sr=sr,
        hop_length=HOP_LENGTH,
        units="frames",
        backtrack=True,
        pre_max=4,
        post_max=4,
        pre_avg=8,
        post_avg=8,
        delta=0.18,
        wait=2,
    )
    bpm = _estimate_bpm_from_onsets(onset_frames, sr)
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=HOP_LENGTH)
    rms = librosa.feature.rms(y=y, frame_length=N_FFT, hop_length=HOP_LENGTH)[0]
    spectrum = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP_LENGTH))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
    band_energies = _band_energy_matrix(spectrum, freqs)

    events: list[DrumEvent] = []
    for frame, time in zip(onset_frames, onset_times):
        if frame >= band_energies.shape[1]:
            continue

        energy_confidence = min(1.0, float(rms[min(frame, len(rms) - 1)] * 18))
        for note, confidence in _classify_frame(band_energies[:, frame], spectrum[:, frame], freqs):
            events.append(
                DrumEvent(
                    time=round(float(time), 3),
                    note=note,
                    confidence=round(max(confidence, energy_confidence), 3),
                )
            )

    events.extend(_detect_frequency_band_events_from_spectrum(spectrum, freqs, sr))
    return bpm, _dedupe_events(events)


def _load_analysis_audio(audio_path: Path) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(audio_path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    if sr != ANALYSIS_SAMPLE_RATE:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=ANALYSIS_SAMPLE_RATE)
        sr = ANALYSIS_SAMPLE_RATE
    return np.asarray(audio, dtype=np.float32), sr


def _estimate_bpm_from_onsets(onset_frames: np.ndarray, sr: int) -> float:
    if len(onset_frames) < 2:
        return 120.0

    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=HOP_LENGTH)
    intervals = np.diff(onset_times)
    intervals = intervals[(intervals >= 0.22) & (intervals <= 1.2)]
    if intervals.size == 0:
        return 120.0

    interval = float(np.median(intervals))
    bpm = 60 / max(interval, 1e-6)
    while bpm < 70:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    return round(float(bpm), 2)


def _band_energy_matrix(spectrum: np.ndarray, freqs: np.ndarray) -> np.ndarray:
    return np.vstack(
        [
            _band_energy_by_frame(spectrum, freqs, 35, 160),
            _band_energy_by_frame(spectrum, freqs, 160, 1200),
            _band_energy_by_frame(spectrum, freqs, 2500, 10000),
        ]
    )


def _band_energy_by_frame(spectrum: np.ndarray, freqs: np.ndarray, low: float, high: float) -> np.ndarray:
    mask = (freqs >= low) & (freqs <= high)
    if not np.any(mask):
        return np.zeros(spectrum.shape[1])
    return np.sum(spectrum[mask] ** 2, axis=0)


def _classify_frame(energy: np.ndarray, magnitude: np.ndarray, freqs: np.ndarray) -> list[tuple[DrumNote, float]]:
    low, mid, high = [float(value) for value in energy]
    total = max(low + mid + high, 1e-9)
    low_ratio = low / total
    mid_ratio = mid / total
    high_ratio = high / total
    centroid, bandwidth = _spectral_shape(magnitude, freqs)

    hits: list[tuple[DrumNote, float]] = []
    if low_ratio > 0.38:
        hits.append(("kick", min(0.96, 0.55 + low_ratio)))
    if mid_ratio > 0.26 and centroid < 4200:
        hits.append(("snare", min(0.9, 0.48 + mid_ratio)))
    if high_ratio > 0.16:
        cymbal_confidence = min(0.93, 0.46 + high_ratio)
        if bandwidth > 4200 or centroid > 6500:
            hits.append(("crash", cymbal_confidence))
        else:
            hits.append(("hihat_closed", cymbal_confidence))

    if hits:
        return _limit_polyphony(hits)
    if high_ratio >= max(low_ratio, mid_ratio):
        return [("hihat_closed", min(0.76, 0.44 + high_ratio))]
    if low_ratio >= mid_ratio:
        return [("kick", min(0.76, 0.44 + low_ratio))]
    return [("snare", min(0.72, 0.42 + mid_ratio))]


def _detect_frequency_band_events_from_spectrum(spectrum: np.ndarray, freqs: np.ndarray, sr: int) -> list[DrumEvent]:
    """Detect low kick and high cymbal transients from one shared STFT."""
    return [
        *_detect_low_frequency_kicks_from_spectrum(spectrum, freqs, sr),
        *_detect_high_frequency_cymbals_from_spectrum(spectrum, freqs, sr),
    ]


def _detect_low_frequency_kicks_from_spectrum(
    spectrum: np.ndarray,
    freqs: np.ndarray,
    sr: int,
) -> list[DrumEvent]:
    """Detect low-end kick transients in the 35Hz-160Hz band."""
    low_mask = (freqs >= 35) & (freqs <= 160)
    if not np.any(low_mask):
        return []

    low_energy = np.mean(spectrum[low_mask], axis=0)
    if float(np.max(low_energy)) <= 1e-10:
        return []

    low_energy = low_energy / max(float(np.max(low_energy)), 1e-10)
    flux = np.maximum(0, np.diff(low_energy, prepend=low_energy[0]))
    frames = librosa.onset.onset_detect(
        onset_envelope=flux,
        sr=sr,
        hop_length=HOP_LENGTH,
        units="frames",
        pre_max=2,
        post_max=2,
        pre_avg=4,
        post_avg=4,
        delta=0.025,
        wait=3,
    )

    times = librosa.frames_to_time(frames, sr=sr, hop_length=HOP_LENGTH)
    events: list[DrumEvent] = []
    for frame, time in zip(frames, times):
        confidence = min(0.95, 0.5 + float(flux[min(frame, len(flux) - 1)]) * 2.5)
        events.append(DrumEvent(time=round(float(time), 3), note="kick", confidence=round(confidence, 3)))
    return events


def _detect_high_frequency_cymbals_from_spectrum(
    spectrum: np.ndarray,
    freqs: np.ndarray,
    sr: int,
) -> list[DrumEvent]:
    """Aggressively detect hi-hat/cymbal transients in the 3kHz-15kHz band.

    This detector intentionally favors false positives over missed cymbals. The
    downstream notation pass can simplify/remove clutter, but it cannot recover
    a cymbal transient that was never emitted.
    """
    high_mask = (freqs >= 3000) & (freqs <= min(15000, sr / 2))
    if not np.any(high_mask):
        return []

    high_energy = np.mean(spectrum[high_mask], axis=0)
    if float(np.max(high_energy)) <= 1e-10:
        return []

    high_energy = high_energy / max(float(np.max(high_energy)), 1e-10)
    flux = np.maximum(0, np.diff(high_energy, prepend=high_energy[0]))
    if float(np.max(flux)) <= 1e-10:
        return []

    frames = librosa.onset.onset_detect(
        onset_envelope=flux,
        sr=sr,
        hop_length=HOP_LENGTH,
        units="frames",
        pre_max=1,
        post_max=1,
        pre_avg=2,
        post_avg=2,
        delta=0.0001,
        wait=1,
    )

    times = librosa.frames_to_time(frames, sr=sr, hop_length=HOP_LENGTH)
    events: list[DrumEvent] = []
    for frame, time in zip(frames, times):
        note = _classify_cymbal_family_from_spectrum(spectrum[:, min(frame, spectrum.shape[1] - 1)], freqs)
        confidence = min(0.92, 0.42 + float(flux[min(frame, len(flux) - 1)]) * 3.5)
        events.append(DrumEvent(time=round(float(time), 3), note=note, confidence=round(confidence, 3)))

    return events


def _classify_cymbal_family_from_spectrum(magnitude: np.ndarray, freqs: np.ndarray) -> DrumNote:
    centroid, bandwidth = _spectral_shape(magnitude, freqs)
    if centroid > 7200 or bandwidth > 5200:
        return "crash"
    if centroid > 5600:
        return "ride"
    return "hihat_closed"


def _classify_hits(segment: np.ndarray, sr: int) -> list[tuple[DrumNote, float]]:
    spectrum = np.abs(np.fft.rfft(segment))
    freqs = np.fft.rfftfreq(segment.size, 1 / sr)
    centroid, bandwidth = _spectral_shape(spectrum, freqs)
    zcr = _zero_crossing_rate(segment)

    low = _band_energy(spectrum, freqs, 35, 140)
    mid = _band_energy(spectrum, freqs, 160, 900)
    high = _band_energy(spectrum, freqs, 2500, 10000)
    total = max(low + mid + high, 1e-9)

    low_ratio = low / total
    mid_ratio = mid / total
    high_ratio = high / total

    hits: list[tuple[DrumNote, float]] = []

    if low_ratio > 0.32 and centroid < 1800:
        hits.append(("kick", min(0.98, 0.58 + low_ratio)))

    if mid_ratio > 0.3 and 900 <= centroid <= 4200:
        hits.append(("snare", min(0.92, 0.5 + mid_ratio)))

    if high_ratio > 0.08 and zcr > 0.025:
        cymbal_confidence = min(0.95, 0.48 + high_ratio)
        if bandwidth > 4400 or centroid > 6800:
            hits.append(("crash", cymbal_confidence))
        else:
            hits.append(("hihat_closed", cymbal_confidence))

    if hits:
        return _limit_polyphony(hits)

    if low_ratio > 0.52 and centroid < 900:
        return [("kick", min(0.98, 0.62 + low_ratio))]
    if high_ratio > 0.5 and zcr > 0.08:
        if bandwidth > 4200 or centroid > 6500:
            return [("crash", min(0.95, 0.48 + high_ratio))]
        return [("hihat_closed", min(0.94, 0.5 + high_ratio))]
    if mid_ratio > 0.36 and centroid < 3200:
        return [("snare", min(0.92, 0.5 + mid_ratio))]
    if low_ratio > 0.28 and mid_ratio > 0.28:
        return [("tom", 0.72)]
    return [("ride", 0.58)]


def _spectral_shape(magnitude: np.ndarray, freqs: np.ndarray) -> tuple[float, float]:
    total = max(float(np.sum(magnitude)), 1e-9)
    centroid = float(np.sum(freqs * magnitude) / total)
    bandwidth = float(np.sqrt(np.sum(((freqs - centroid) ** 2) * magnitude) / total))
    return centroid, bandwidth


def _zero_crossing_rate(segment: np.ndarray) -> float:
    if segment.size < 2:
        return 0.0
    signs = np.signbit(segment)
    return float(np.mean(signs[1:] != signs[:-1]))


def _band_energy(spectrum: np.ndarray, freqs: np.ndarray, low: float, high: float) -> float:
    mask = (freqs >= low) & (freqs <= high)
    return float(np.sum(spectrum[mask] ** 2))


def _dedupe_events(events: list[DrumEvent]) -> list[DrumEvent]:
    if not events:
        return []

    events = sorted(events, key=lambda event: (event.time, event.note))
    result = [events[0]]
    for event in events[1:]:
        previous = result[-1]
        if event.note == previous.note and event.time - previous.time < 0.055:
            if event.confidence > previous.confidence:
                result[-1] = event
            continue
        result.append(event)
    return result


def _limit_polyphony(hits: list[tuple[DrumNote, float]]) -> list[tuple[DrumNote, float]]:
    priority: dict[DrumNote, int] = {
        "kick": 0,
        "snare": 1,
        "hihat_closed": 2,
        "hihat_open": 2,
        "ride": 2,
        "crash": 2,
        "tom": 3,
    }
    unique: dict[DrumNote, float] = {}
    for note, confidence in hits:
        unique[note] = max(unique.get(note, 0), confidence)
    ordered = sorted(unique.items(), key=lambda item: (priority[item[0]], -item[1]))
    return ordered[:3]
