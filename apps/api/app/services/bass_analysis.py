from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from app.models import BassSpec, BassSpecNote

BASS_EXTRACTION_VERSION = "bass-pyin-v3-low-register"
ANALYSIS_SAMPLE_RATE = 22050
FRAME_LENGTH = 2048
HOP_LENGTH = 256
MIN_BASS_MIDI = 28
MAX_BASS_MIDI = 67
PRACTICAL_BASS_UPPER_MIDI = 52
MIN_RMS_FLOOR = 0.0012
MIN_VOICED_PROBABILITY = 0.22
SLOTS_PER_MEASURE = 16


@dataclass
class SlotPitch:
    midi: int | None
    confidence: float
    energy: float


def analyze_bass_track(audio_path: Path | None, bpm: float) -> BassSpec:
    if audio_path is None or not audio_path.exists():
        return BassSpec(mode="both", notes=[])

    y, sr = _load_analysis_audio(audio_path)
    if y.size < FRAME_LENGTH or not np.any(np.abs(y) > 1e-6):
        return BassSpec(mode="both", notes=[])

    try:
        f0, voiced_flag, voiced_prob = librosa.pyin(
            y,
            sr=sr,
            fmin=librosa.note_to_hz("E1"),
            fmax=librosa.note_to_hz("G4"),
            frame_length=FRAME_LENGTH,
            hop_length=HOP_LENGTH,
        )
    except Exception:
        return BassSpec(mode="both", notes=[])

    rms = librosa.feature.rms(y=y, frame_length=FRAME_LENGTH, hop_length=HOP_LENGTH)[0]
    frame_count = min(len(rms), len(f0))
    if frame_count == 0:
        return BassSpec(mode="both", notes=[])

    f0 = np.asarray(f0[:frame_count], dtype=np.float32)
    voiced_prob = np.asarray(voiced_prob[:frame_count], dtype=np.float32)
    voiced_flag = np.asarray(voiced_flag[:frame_count], dtype=bool)
    rms = np.asarray(rms[:frame_count], dtype=np.float32)
    frame_times = librosa.frames_to_time(np.arange(frame_count), sr=sr, hop_length=HOP_LENGTH)
    slot_seconds = 60.0 / max(float(bpm), 1.0) / 4.0
    total_slots = max(1, int(np.ceil((len(y) / sr) / slot_seconds)))
    energy_reference = max(float(np.percentile(rms, 80)), MIN_RMS_FLOOR)

    slots: list[SlotPitch] = []
    previous_midi: int | None = None
    for slot_index in range(total_slots):
        slot_start = slot_index * slot_seconds
        slot_end = slot_start + slot_seconds
        frame_mask = (frame_times >= slot_start) & (frame_times < slot_end)
        if slot_index == total_slots - 1:
            frame_mask = (frame_times >= slot_start) & (frame_times <= slot_end + 1e-6)
        if not np.any(frame_mask):
            slots.append(SlotPitch(midi=None, confidence=0.0, energy=0.0))
            continue

        slot_energy = float(np.median(rms[frame_mask]))
        if slot_energy < max(MIN_RMS_FLOOR, energy_reference * 0.09):
            slots.append(SlotPitch(midi=None, confidence=0.0, energy=slot_energy))
            continue

        voiced_mask = frame_mask & voiced_flag & np.isfinite(f0) & (voiced_prob >= MIN_VOICED_PROBABILITY)
        if not np.any(voiced_mask):
            slots.append(SlotPitch(midi=None, confidence=0.0, energy=slot_energy))
            continue

        raw_midi = float(np.median(librosa.hz_to_midi(f0[voiced_mask])))
        midi = _normalize_detected_bass_midi(raw_midi, previous_midi)
        confidence = float(np.clip(np.mean(voiced_prob[voiced_mask]) * min(1.0, slot_energy / energy_reference + 0.1), 0.0, 1.0))
        if midi is None:
            slots.append(SlotPitch(midi=None, confidence=0.0, energy=slot_energy))
            continue

        slots.append(SlotPitch(midi=midi, confidence=confidence, energy=slot_energy))
        previous_midi = midi

    _smooth_slot_pitches(slots)
    return BassSpec(mode="both", notes=_slot_pitches_to_notes(slots, slot_seconds))


def _load_analysis_audio(audio_path: Path) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(audio_path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    if sr != ANALYSIS_SAMPLE_RATE:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=ANALYSIS_SAMPLE_RATE)
        sr = ANALYSIS_SAMPLE_RATE
    return np.asarray(audio, dtype=np.float32), sr


def _normalize_detected_bass_midi(raw_midi: float, reference_midi: int | None) -> int | None:
    if not np.isfinite(raw_midi):
        return None

    rounded = int(round(raw_midi))
    candidates: list[int] = []
    for shift in (-36, -24, -12, 0, 12, 24, 36):
        candidate = rounded + shift
        if MIN_BASS_MIDI <= candidate <= MAX_BASS_MIDI:
            candidates.append(candidate)

    if not candidates:
        while rounded < MIN_BASS_MIDI:
            rounded += 12
        while rounded > MAX_BASS_MIDI:
            rounded -= 12
        if MIN_BASS_MIDI <= rounded <= MAX_BASS_MIDI:
            candidates.append(rounded)

    if not candidates:
        return None

    if reference_midi is None:
        selected = min(candidates, key=lambda value: abs(value - 40))
    else:
        selected = min(candidates, key=lambda value: (abs(value - reference_midi), abs(value - 40)))

    while selected > PRACTICAL_BASS_UPPER_MIDI and selected - 12 >= MIN_BASS_MIDI:
        selected -= 12
    return selected


def _smooth_slot_pitches(slots: list[SlotPitch]) -> None:
    if len(slots) < 3:
        return

    for index in range(1, len(slots) - 1):
        previous_slot = slots[index - 1]
        current_slot = slots[index]
        next_slot = slots[index + 1]

        if current_slot.midi is None and previous_slot.midi is not None and previous_slot.midi == next_slot.midi:
            if min(previous_slot.confidence, next_slot.confidence) >= 0.4:
                current_slot.midi = previous_slot.midi
                current_slot.confidence = min(previous_slot.confidence, next_slot.confidence) * 0.85
                continue

        if (
            current_slot.midi is not None
            and previous_slot.midi is not None
            and next_slot.midi is not None
            and previous_slot.midi == next_slot.midi
            and previous_slot.midi != current_slot.midi
        ):
            if current_slot.confidence < min(previous_slot.confidence, next_slot.confidence):
                current_slot.midi = previous_slot.midi
                current_slot.confidence = min(previous_slot.confidence, next_slot.confidence) * 0.9


def _slot_pitches_to_notes(slots: list[SlotPitch], slot_seconds: float) -> list[BassSpecNote]:
    notes: list[BassSpecNote] = []
    slot_index = 0

    while slot_index < len(slots):
        slot = slots[slot_index]
        if slot.midi is None:
            slot_index += 1
            continue

        run_start = slot_index
        run_confidences = [slot.confidence]
        slot_index += 1
        while slot_index < len(slots) and slots[slot_index].midi == slot.midi:
            run_confidences.append(slots[slot_index].confidence)
            slot_index += 1

        emitted_segments = _emit_segments(run_start, slot_index - run_start)
        for segment_index, (segment_start, duration_slots) in enumerate(emitted_segments):
            notes.append(
                BassSpecNote(
                    id=f"bass-{segment_start}",
                    time=round(segment_start * slot_seconds, 3),
                    measure=segment_start // SLOTS_PER_MEASURE + 1,
                    slot=segment_start % SLOTS_PER_MEASURE,
                    duration=_duration_from_slots(duration_slots),
                    duration_slots=duration_slots,
                    midi_note=slot.midi,
                    confidence=round(float(np.mean(run_confidences)), 3),
                    tie_from_previous=segment_index > 0,
                    tie_to_next=segment_index < len(emitted_segments) - 1,
                )
            )

    return notes


def _emit_segments(start_slot: int, total_slots: int) -> list[tuple[int, int]]:
    segments: list[tuple[int, int]] = []
    current_slot = start_slot
    remaining = total_slots

    while remaining > 0:
        slots_left_in_measure = SLOTS_PER_MEASURE - (current_slot % SLOTS_PER_MEASURE)
        available = min(remaining, slots_left_in_measure)
        duration_slots = _largest_supported_duration(available)
        segments.append((current_slot, duration_slots))
        current_slot += duration_slots
        remaining -= duration_slots

    return segments


def _largest_supported_duration(available_slots: int) -> int:
    for duration_slots in (16, 8, 4, 2, 1):
        if available_slots >= duration_slots:
            return duration_slots
    return 1


def _duration_from_slots(duration_slots: int) -> str:
    if duration_slots >= 16:
        return "w"
    if duration_slots >= 8:
        return "h"
    if duration_slots >= 4:
        return "q"
    if duration_slots >= 2:
        return "8"
    return "16"
