"use client";

import type {
  AnalysisResult,
  AnalysisTrack,
  BassDuration,
  BassRenderMode,
  BassSpec,
  BassSpecNote,
  BassTechnique,
  DrumNote,
  EngravedMeasure,
  InstrumentNotation,
  InstrumentType,
  LyricWord,
  MidiTickEvent,
  ScoreEvent,
} from "./types";

type VoiceNumber = 1 | 2;

type TrackSource = "explicit" | "derived" | "legacy";

type TrackLikeScore = Pick<AnalysisResult, "bpm" | "engraved_measures" | "events" | "midi_ticks" | "ticks_per_quarter" | "words"> & {
  BASS_SPEC?: BassSpec;
  bassSpec?: BassSpec;
  bass_spec?: BassSpec;
};

type SourceTagged = {
  BASS_SPEC?: BassSpec;
  bassSpec?: BassSpec;
  bass_spec?: BassSpec;
  instrumentType?: InstrumentType;
  instrument_type?: InstrumentType;
};

type LyricRow = {
  lyric: string;
  row: number;
};

export type MelodicNoteEvent = {
  confidence: number;
  lyric?: string | null;
  midiNote: number | null;
  staffKey: string;
  voice: VoiceNumber;
};

export type MelodicSlot = {
  lyric?: string | null;
  lyrics: LyricRow[];
  voice1: MelodicNoteEvent[];
  voice2: MelodicNoteEvent[];
};

export type MelodicMeasure = {
  slots: MelodicSlot[];
};

export type MelodicRenderTrack = {
  bpm: number;
  clef: "bass" | "treble";
  instrumentType: Exclude<InstrumentType, "DRUM" | "BASS">;
  label: string;
  measures: MelodicMeasure[];
  notation: Exclude<InstrumentNotation, "percussion">;
  source: Exclude<TrackSource, "legacy">;
  words: LyricWord[];
};

export type BassRenderNote = {
  actualMidi: number | null;
  chord?: string | null;
  confidence: number;
  displayStaffKey: string;
  duration: Exclude<BassDuration, "w" | "h"> | "w" | "h";
  durationSlots: number;
  fret: number | "X";
  id: string;
  isDead: boolean;
  isStaccato: boolean;
  lyric?: string | null;
  measure: number;
  slot: number;
  string: 1 | 2 | 3 | 4;
  techniques: BassTechnique[];
  tieFromPrevious: boolean;
  tieToNext: boolean;
};

export type BassSlot = {
  lyric?: string | null;
  lyrics: LyricRow[];
  notes: BassRenderNote[];
};

export type BassMeasure = {
  notes: BassRenderNote[];
  slots: BassSlot[];
};

export type BassRenderTrack = {
  bpm: number;
  instrumentType: "BASS";
  label: string;
  measures: BassMeasure[];
  mode: BassRenderMode;
  source: Exclude<TrackSource, "legacy">;
  words: LyricWord[];
};

export type ResolvedInstrumentView =
  | {
      instrumentType: "DRUM";
      label: string;
      score: AnalysisResult;
      source: Extract<TrackSource, "explicit" | "legacy">;
    }
  | {
      instrumentType: "BASS";
      label: string;
      source: Exclude<TrackSource, "legacy">;
      track: BassRenderTrack;
    }
  | {
      instrumentType: Exclude<InstrumentType, "DRUM" | "BASS">;
      label: string;
      source: Exclude<TrackSource, "legacy">;
      track: MelodicRenderTrack;
    };

export const INSTRUMENT_OPTIONS: Array<{ icon: string; instrument: InstrumentType; label: string }> = [
  { icon: "🥁", instrument: "DRUM", label: "Drum" },
  { icon: "🎸", instrument: "BASS", label: "Bass" },
  { icon: "🎸", instrument: "GUITAR", label: "Guitar" },
  { icon: "🎹", instrument: "KEYBOARD", label: "Keyboard" },
];

const SLOTS_PER_MEASURE = 16;
const BASS_STRING_OPEN_MIDI: Record<1 | 2 | 3 | 4, number> = {
  1: 43,
  2: 38,
  3: 33,
  4: 28,
};
const BASS_FRET_MIN = 0;
const BASS_FRET_MAX = 24;
const BASS_DEFAULT_RENDER_MODE: BassRenderMode = "both";
const BASS_DERIVED_ACTUAL_MIDI: Record<DrumNote, number> = {
  crash: 43,
  hihat_closed: 38,
  hihat_open: 40,
  kick: 28,
  ride: 35,
  snare: 33,
  tom: 36,
};

const DERIVED_SINGLE_STAFF_PITCHES: Record<Exclude<InstrumentType, "DRUM" | "KEYBOARD">, Record<DrumNote, string>> = {
  BASS: {
    crash: "f/3",
    hihat_closed: "g/2",
    hihat_open: "a/2",
    kick: "e/2",
    ride: "d/3",
    snare: "a/2",
    tom: "c/3",
  },
  GUITAR: {
    crash: "f/5",
    hihat_closed: "g/4",
    hihat_open: "a/4",
    kick: "e/4",
    ride: "d/5",
    snare: "a/4",
    tom: "c/5",
  },
};

const DERIVED_KEYBOARD_PITCHES: Record<VoiceNumber, Record<DrumNote, string>> = {
  1: {
    crash: "e/5",
    hihat_closed: "g/5",
    hihat_open: "a/5",
    kick: "c/5",
    ride: "d/5",
    snare: "b/4",
    tom: "g/4",
  },
  2: {
    crash: "c/3",
    hihat_closed: "g/2",
    hihat_open: "a/2",
    kick: "e/2",
    ride: "d/3",
    snare: "c/3",
    tom: "g/2",
  },
};

export function resolveInstrumentView(score: AnalysisResult, instrument: InstrumentType): ResolvedInstrumentView {
  const label = instrumentLabel(instrument);
  const explicitTrack = findTrack(score, instrument);

  if (instrument === "DRUM") {
    return {
      instrumentType: "DRUM",
      label,
      score: materializeDrumScore(score, explicitTrack),
      source: explicitTrack ? "explicit" : "legacy",
    };
  }

  if (instrument === "BASS") {
    if (explicitTrack) {
      return {
        instrumentType: "BASS",
        label,
        source: "explicit",
        track: buildBassTrackFromPayload(explicitTrack, "explicit", score.words),
      };
    }

    return {
      instrumentType: "BASS",
      label,
      source: "derived",
      track: buildDerivedBassTrack(score),
    };
  }

  if (explicitTrack) {
    return {
      instrumentType: instrument,
      label,
      source: "explicit",
      track: buildMelodicTrackFromPayload(explicitTrack, instrument, "explicit", score.words),
    };
  }

  return {
    instrumentType: instrument,
    label,
    source: "derived",
    track: buildDerivedMelodicTrack(score, instrument),
  };
}

export function instrumentLabel(instrument: InstrumentType): string {
  return INSTRUMENT_OPTIONS.find((option) => option.instrument === instrument)?.label ?? instrument;
}

export function resolvedViewMeasureCount(view: ResolvedInstrumentView): number {
  if (view.instrumentType === "DRUM") {
    return Math.max(1, view.score.engraved_measures.length || countMeasuresFromTicks(view.score.midi_ticks));
  }

  return view.track.measures.length;
}

export function resolvedViewNoteCount(view: ResolvedInstrumentView): number {
  if (view.instrumentType === "DRUM") {
    return view.score.midi_ticks.length || view.score.events.length;
  }

  if (view.instrumentType === "BASS") {
    return view.track.measures.reduce((total, measure) => total + measure.notes.length, 0);
  }

  return view.track.measures.reduce(
    (total, measure) =>
      total + measure.slots.reduce((slotTotal, slot) => slotTotal + slot.voice1.length + slot.voice2.length, 0),
    0,
  );
}

function findTrack(score: AnalysisResult, instrument: InstrumentType): AnalysisTrack | null {
  return score.tracks?.find((track) => resolveInstrumentType(track) === instrument) ?? null;
}

function materializeDrumScore(score: AnalysisResult, track: AnalysisTrack | null): AnalysisResult {
  if (!track) {
    return score;
  }

  return {
    bpm: track.bpm ?? score.bpm,
    engraved_measures: track.engraved_measures ?? [],
    events: track.events ?? [],
    instrumentType: "DRUM",
    instrument_type: "DRUM",
    midi_ticks: track.midi_ticks ?? [],
    ticks_per_quarter: track.ticks_per_quarter ?? score.ticks_per_quarter,
    tracks: score.tracks,
    words: track.words ?? score.words,
  };
}

function buildDerivedMelodicTrack(
  score: AnalysisResult,
  instrument: Exclude<InstrumentType, "DRUM">,
): MelodicRenderTrack {
  return buildMelodicTrackFromPayload(
    {
      bpm: score.bpm,
      engraved_measures: score.engraved_measures,
      events: score.events,
      midi_ticks: score.midi_ticks,
      ticks_per_quarter: score.ticks_per_quarter,
      words: score.words,
    },
    instrument,
    "derived",
    score.words,
    true,
  );
}

function buildMelodicTrackFromPayload(
  payload: TrackLikeScore | AnalysisTrack,
  instrument: Exclude<InstrumentType, "DRUM">,
  source: Exclude<TrackSource, "legacy">,
  fallbackWords: LyricWord[],
  useDerivedPitchMap = false,
): MelodicRenderTrack {
  const bpm = payload.bpm ?? 120;
  const words = payload.words ?? fallbackWords;
  const measures = payload.engraved_measures?.length
    ? measuresFromEngraved(payload.engraved_measures, instrument, useDerivedPitchMap)
    : payload.midi_ticks?.length
      ? measuresFromMidiTicks(payload.midi_ticks, instrument, useDerivedPitchMap)
      : measuresFromScoreEvents(payload.events ?? [], bpm, instrument, useDerivedPitchMap);

  return {
    bpm,
    clef: instrument === "BASS" ? "bass" : "treble",
    instrumentType: instrument,
    label: instrumentLabel(instrument),
    measures: hasAnyLyrics(measures) ? measures : applyWordsFallback(measures, words, bpm),
    notation: instrument === "KEYBOARD" ? "grand" : "staff",
    source,
    words,
  };
}

function measuresFromEngraved(
  engravedMeasures: EngravedMeasure[],
  instrument: Exclude<InstrumentType, "DRUM">,
  useDerivedPitchMap: boolean,
): MelodicMeasure[] {
  return engravedMeasures.map((measure) => {
    const slots = emptyMelodicSlots();

    for (const legacySlot of measure.slots ?? []) {
      addSlotLyric(slots[clampSlot(legacySlot.slot)], legacySlot.lyric ?? null, 0);
    }

    for (const lyricSlot of measure.lyric_slots ?? []) {
      addSlotLyric(slots[clampSlot(lyricSlot.slot)], lyricSlot.lyric, lyricSlot.row ?? 0);
    }

    const voiceTicks = [...measure.voice1, ...measure.voice2].sort((left, right) => left.slot - right.slot);
    for (const tick of voiceTicks) {
      const slot = slots[clampSlot(tick.slot)];
      for (const event of tick.events) {
        const melodicEvent = useDerivedPitchMap
          ? melodicEventFromDrumLike(event, tick.voice, instrument)
          : melodicEventFromAnySource(event, tick.voice, instrument);
        if (melodicEvent) {
          addMelodicEvent(slot, melodicEvent);
        }
      }

      addSlotLyric(slot, tick.lyric ?? tick.events.find((event) => Boolean(event.lyric?.trim()))?.lyric ?? null, 0);
    }

    return { slots };
  });
}

function measuresFromMidiTicks(
  ticks: MidiTickEvent[],
  instrument: Exclude<InstrumentType, "DRUM">,
  useDerivedPitchMap: boolean,
): MelodicMeasure[] {
  const grouped = new Map<number, MidiTickEvent[]>();
  for (const tick of ticks) {
    const measureIndex = Math.max(0, tick.measure - 1);
    const entries = grouped.get(measureIndex) ?? [];
    entries.push(tick);
    grouped.set(measureIndex, entries);
  }

  const measureCount = Math.max(1, Math.max(...grouped.keys(), 0) + 1);
  return Array.from({ length: measureCount }, (_, measureIndex) => {
    const slots = emptyMelodicSlots();
    for (const tick of grouped.get(measureIndex) ?? []) {
      const slot = slots[clampSlot(tick.slot)];
      const melodicEvent = useDerivedPitchMap
        ? melodicEventFromDrumLike(tick, tick.voice, instrument)
        : melodicEventFromAnySource(tick, tick.voice, instrument);
      if (melodicEvent) {
        addMelodicEvent(slot, melodicEvent);
      }

      addSlotLyric(slot, tick.lyric ?? null, 0);
    }
    return { slots };
  });
}

function measuresFromScoreEvents(
  events: ScoreEvent[],
  bpm: number,
  instrument: Exclude<InstrumentType, "DRUM">,
  useDerivedPitchMap: boolean,
): MelodicMeasure[] {
  const beatSeconds = 60 / Math.max(bpm || 120, 1);
  const measureSeconds = beatSeconds * 4;
  const grouped = new Map<number, ScoreEvent[]>();

  for (const event of [...events].sort((left, right) => left.time - right.time)) {
    const measureIndex = Math.max(0, Math.floor(event.time / measureSeconds));
    const entries = grouped.get(measureIndex) ?? [];
    entries.push(event);
    grouped.set(measureIndex, entries);
  }

  const measureCount = Math.max(1, Math.max(...grouped.keys(), 0) + 1);
  return Array.from({ length: measureCount }, (_, measureIndex) => {
    const slots = emptyMelodicSlots();
    for (const event of grouped.get(measureIndex) ?? []) {
      const slotIndex = Math.min(
        SLOTS_PER_MEASURE - 1,
        Math.max(0, Math.round((event.time - measureIndex * measureSeconds) / (beatSeconds / 4))),
      );
      const slot = slots[slotIndex];
      const melodicEvent = useDerivedPitchMap
        ? melodicEventFromDrumLike(event, 1, instrument)
        : melodicEventFromAnySource(event, 1, instrument);
      if (melodicEvent) {
        addMelodicEvent(slot, melodicEvent);
      }

      addSlotLyric(slot, event.lyric ?? null, 0);
    }
    return { slots };
  });
}

function melodicEventFromAnySource(
  event: { confidence?: number; lyric?: string | null; midi_note?: number; staff_key?: string | null },
  voice: VoiceNumber,
  instrument: Exclude<InstrumentType, "DRUM">,
): MelodicNoteEvent | null {
  const normalizedKey = normalizeStaffKey(event.staff_key ?? null);
  const staffKey = normalizedKey ?? staffKeyFromMidi(event.midi_note ?? null) ?? fallbackStaffKeyForInstrument(instrument, voice);
  if (!staffKey) {
    return null;
  }

  return {
    confidence: event.confidence ?? 1,
    lyric: event.lyric ?? null,
    midiNote: event.midi_note ?? null,
    staffKey,
    voice,
  };
}

function melodicEventFromDrumLike(
  event: { confidence?: number; drum?: DrumNote; lyric?: string | null },
  voice: VoiceNumber,
  instrument: Exclude<InstrumentType, "DRUM">,
): MelodicNoteEvent | null {
  if (!event.drum) {
    return null;
  }

  const staffKey =
    instrument === "KEYBOARD" ? DERIVED_KEYBOARD_PITCHES[voice][event.drum] : DERIVED_SINGLE_STAFF_PITCHES[instrument][event.drum];

  return {
    confidence: event.confidence ?? 1,
    lyric: event.lyric ?? null,
    midiNote: null,
    staffKey,
    voice,
  };
}

function emptyMelodicSlots(): MelodicSlot[] {
  return Array.from({ length: SLOTS_PER_MEASURE }, () => ({
    lyric: null,
    lyrics: [],
    voice1: [],
    voice2: [],
  }));
}

function addMelodicEvent(slot: MelodicSlot, event: MelodicNoteEvent) {
  const target = event.voice === 1 ? slot.voice1 : slot.voice2;
  const duplicate = target.find((entry) => entry.staffKey === event.staffKey);
  if (duplicate) {
    if (event.confidence > duplicate.confidence) {
      duplicate.confidence = event.confidence;
      duplicate.lyric = event.lyric ?? duplicate.lyric;
      duplicate.midiNote = event.midiNote ?? duplicate.midiNote;
    }
    return;
  }

  target.push(event);
  target.sort((left, right) => diatonicIndex(left.staffKey) - diatonicIndex(right.staffKey));
}

function hasAnyLyrics(measures: MelodicMeasure[]): boolean {
  return measures.some((measure) =>
    measure.slots.some((slot) => Boolean(slot.lyric?.trim()) || slot.lyrics.some((entry) => Boolean(entry.lyric.trim()))),
  );
}

function applyWordsFallback(measures: MelodicMeasure[], words: LyricWord[], bpm: number): MelodicMeasure[] {
  if (!words.length) {
    return measures.length ? measures : [{ slots: emptyMelodicSlots() }];
  }

  const beatSeconds = 60 / Math.max(bpm || 120, 1);
  const measureSeconds = beatSeconds * 4;
  const slotSeconds = measureSeconds / SLOTS_PER_MEASURE;

  for (const word of words) {
    const measureIndex = Math.max(0, Math.floor(word.start / measureSeconds));
    const measure = ensureMeasure(measures, measureIndex);
    const measureStart = measureIndex * measureSeconds;
    const slotIndex = Math.min(
      SLOTS_PER_MEASURE - 1,
      Math.max(0, Math.floor((word.start - measureStart) / slotSeconds)),
    );
    const targetSlot = firstAvailableLyricSlot(measure.slots, slotIndex);
    if (targetSlot !== null) {
      addSlotLyric(measure.slots[targetSlot], word.word.trim().normalize("NFC"), 0);
    }
  }

  return measures;
}

function ensureMeasure(measures: MelodicMeasure[], measureIndex: number): MelodicMeasure {
  while (measures.length <= measureIndex) {
    measures.push({ slots: emptyMelodicSlots() });
  }
  return measures[measureIndex];
}

function firstAvailableLyricSlot(slots: MelodicSlot[], preferredSlot: number): number | null {
  for (let slot = preferredSlot; slot < SLOTS_PER_MEASURE; slot += 1) {
    if (!slots[slot].lyric?.trim() && slots[slot].lyrics.length === 0) {
      return slot;
    }
  }
  return null;
}

function addSlotLyric(slot: MelodicSlot, next: string | null | undefined, row: number) {
  const cleanNext = next?.trim().normalize("NFC");
  if (!cleanNext) {
    return;
  }

  const cleanRow = Math.max(0, row);
  slot.lyrics.push({ lyric: cleanNext, row: cleanRow });
  slot.lyrics.sort((left, right) => left.row - right.row);
  slot.lyric = mergeLyric(slot.lyric, cleanNext);
}

function mergeLyric(current: string | null | undefined, next: string | null | undefined): string | null {
  const cleanNext = next?.trim();
  if (!cleanNext) {
    return current ?? null;
  }

  const cleanCurrent = current?.trim();
  if (!cleanCurrent) {
    return cleanNext;
  }
  if (cleanCurrent.split(/\s+/).includes(cleanNext)) {
    return cleanCurrent;
  }
  return `${cleanCurrent} ${cleanNext}`;
}

function resolveInstrumentType(value: SourceTagged | null | undefined): InstrumentType | null {
  return value?.instrumentType ?? value?.instrument_type ?? null;
}

function countMeasuresFromTicks(ticks: MidiTickEvent[]): number {
  return Math.max(1, Math.max(...ticks.map((tick) => tick.measure), 1));
}

function clampSlot(slot: number): number {
  return Math.min(SLOTS_PER_MEASURE - 1, Math.max(0, slot));
}

function normalizeStaffKey(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return /^[a-g][#b]?\/-?\d+$/.test(normalized) ? normalized : null;
}

function staffKeyFromMidi(midi: number | null): string | null {
  if (midi === null || !Number.isFinite(midi)) {
    return null;
  }

  const noteNames = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"] as const;
  const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  return `${noteNames[pitchClass]}/${octave}`;
}

function fallbackStaffKeyForInstrument(
  instrument: Exclude<InstrumentType, "DRUM">,
  voice: VoiceNumber,
): string {
  if (instrument === "KEYBOARD") {
    return voice === 1 ? "c/5" : "c/3";
  }
  if (instrument === "BASS") {
    return "e/2";
  }
  return "e/4";
}

function diatonicIndex(staffKey: string): number {
  const match = /^([a-g])[#b]?\/(-?\d+)$/.exec(staffKey);
  if (!match) {
    return 0;
  }

  const diatonicOrder: Record<string, number> = {
    a: 5,
    b: 6,
    c: 0,
    d: 1,
    e: 2,
    f: 3,
    g: 4,
  };

  return Number(match[2]) * 7 + diatonicOrder[match[1]];
}
