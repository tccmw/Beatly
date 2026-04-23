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

type BassSourceLike = Partial<BassSpecNote> & {
  chord?: string | null;
  confidence?: number;
  drum?: DrumNote;
  harmony?: string | null;
  lyric?: string | null;
  midi_note?: number;
  note?: DrumNote;
  staff_key?: string | null;
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

function buildDerivedBassTrack(score: AnalysisResult): BassRenderTrack {
  return buildBassTrackFromPayload(
    {
      BASS_SPEC: score.BASS_SPEC,
      bassSpec: score.bassSpec,
      bass_spec: score.bass_spec,
      bpm: score.bpm,
      engraved_measures: score.engraved_measures,
      events: score.events,
      midi_ticks: score.midi_ticks,
      ticks_per_quarter: score.ticks_per_quarter,
      words: score.words,
    },
    "derived",
    score.words,
    true,
  );
}

function buildBassTrackFromPayload(
  payload: TrackLikeScore | AnalysisTrack,
  source: Exclude<TrackSource, "legacy">,
  fallbackWords: LyricWord[],
  useDerivedPitchMap = false,
): BassRenderTrack {
  const bpm = payload.bpm ?? 120;
  const words = payload.words ?? fallbackWords;
  const bassSpec = resolveBassSpec(payload);
  const ticksPerQuarter = payload.ticks_per_quarter ?? 480;
  const measures = bassSpec?.notes?.length
    ? measuresFromBassSpec(bassSpec.notes, bpm)
    : payload.midi_ticks?.length
      ? bassMeasuresFromMidiTicks(payload.midi_ticks, bpm, ticksPerQuarter, useDerivedPitchMap)
      : payload.engraved_measures?.length
        ? bassMeasuresFromEngraved(payload.engraved_measures, bpm, ticksPerQuarter, useDerivedPitchMap)
        : bassMeasuresFromScoreEvents(payload.events ?? [], bpm, useDerivedPitchMap);

  const lyricReadyMeasures = hasAnyBassLyrics(measures) ? measures : applyBassWordsFallback(measures, words, bpm);

  return {
    bpm,
    instrumentType: "BASS",
    label: instrumentLabel("BASS"),
    measures: lyricReadyMeasures.length ? lyricReadyMeasures : [{ notes: [], slots: emptyBassSlots() }],
    mode: bassSpec?.mode ?? BASS_DEFAULT_RENDER_MODE,
    source,
    words,
  };
}

function buildDerivedMelodicTrack(
  score: AnalysisResult,
  instrument: Exclude<InstrumentType, "DRUM" | "BASS">,
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
  instrument: Exclude<InstrumentType, "DRUM" | "BASS">,
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
    clef: "treble",
    instrumentType: instrument,
    label: instrumentLabel(instrument),
    measures: hasAnyLyrics(measures) ? measures : applyWordsFallback(measures, words, bpm),
    notation: instrument === "KEYBOARD" ? "grand" : "staff",
    source,
    words,
  };
}

function measuresFromBassSpec(notes: BassSpecNote[], bpm: number): BassMeasure[] {
  const measureMap = new Map<number, BassRenderNote[]>();

  [...notes]
    .sort((left, right) => compareBassSpecOrdering(left, right, bpm))
    .forEach((note, index) => {
      const measure = resolveBassMeasure(note, bpm);
      const slot = resolveBassSlot(note, bpm);
      const bassNote = bassSpecNoteToRenderNote(note, measure, slot, index);
      const entries = measureMap.get(measure) ?? [];
      entries.push(bassNote);
      measureMap.set(measure, entries);
    });

  const measureCount = Math.max(1, Math.max(...measureMap.keys(), 1));
  return Array.from({ length: measureCount }, (_, measureIndex) => buildBassMeasure(measureMap.get(measureIndex + 1) ?? []));
}

function bassMeasuresFromEngraved(
  engravedMeasures: EngravedMeasure[],
  _bpm: number,
  ticksPerQuarter: number,
  useDerivedPitchMap: boolean,
): BassMeasure[] {
  return engravedMeasures.map((measure) => {
    const rawNotes: BassRenderNote[] = [];
    let index = 0;

    const voiceTicks = [...measure.voice1, ...measure.voice2].sort((left, right) => left.slot - right.slot);
    for (const tick of voiceTicks) {
      if (tick.rest || tick.events.length === 0) {
        continue;
      }

      const sourceEvent = useDerivedPitchMap ? pickDerivedBassEvent(tick.events) : pickExplicitBassEvent(tick.events);
      if (!sourceEvent) {
        continue;
      }

      rawNotes.push(
        sourceEventToBassRenderNote(
          sourceEvent,
          measure.measure,
          clampSlot(tick.slot),
          durationSlotsFromTickLike(tick.duration_ticks, ticksPerQuarter),
          useDerivedPitchMap,
          `bass-${measure.measure}-${tick.slot}-${index}`,
        ),
      );
      index += 1;
    }

    const nextMeasure = buildBassMeasure(rawNotes);
    for (const legacySlot of measure.slots ?? []) {
      addBassSlotLyric(nextMeasure.slots[clampSlot(legacySlot.slot)], legacySlot.lyric ?? null, 0);
    }
    for (const lyricSlot of measure.lyric_slots ?? []) {
      addBassSlotLyric(nextMeasure.slots[clampSlot(lyricSlot.slot)], lyricSlot.lyric, lyricSlot.row ?? 0);
    }
    return nextMeasure;
  });
}

function bassMeasuresFromMidiTicks(
  ticks: MidiTickEvent[],
  _bpm: number,
  ticksPerQuarter: number,
  useDerivedPitchMap: boolean,
): BassMeasure[] {
  const grouped = new Map<number, MidiTickEvent[]>();
  for (const tick of ticks) {
    const measure = Math.max(1, tick.measure);
    const entries = grouped.get(measure) ?? [];
    entries.push(tick);
    grouped.set(measure, entries);
  }

  const measureCount = Math.max(1, Math.max(...grouped.keys(), 1));
  return Array.from({ length: measureCount }, (_, measureIndex) => {
    const rawNotes = (grouped.get(measureIndex + 1) ?? []).map((tick, noteIndex) =>
      sourceEventToBassRenderNote(
        tick,
        measureIndex + 1,
        clampSlot(tick.slot),
        durationSlotsFromTickLike(tick.duration_ticks, ticksPerQuarter),
        useDerivedPitchMap,
        `bass-${measureIndex + 1}-${tick.slot}-${noteIndex}`,
      ),
    );

    return buildBassMeasure(rawNotes);
  });
}

function bassMeasuresFromScoreEvents(
  events: ScoreEvent[],
  bpm: number,
  useDerivedPitchMap: boolean,
): BassMeasure[] {
  const beatSeconds = 60 / Math.max(bpm || 120, 1);
  const measureSeconds = beatSeconds * 4;
  const grouped = new Map<number, ScoreEvent[]>();

  for (const event of [...events].sort((left, right) => left.time - right.time)) {
    const measure = Math.max(1, Math.floor(event.time / measureSeconds) + 1);
    const entries = grouped.get(measure) ?? [];
    entries.push(event);
    grouped.set(measure, entries);
  }

  const measureCount = Math.max(1, Math.max(...grouped.keys(), 1));
  return Array.from({ length: measureCount }, (_, measureIndex) => {
    const measure = measureIndex + 1;
    const rawNotes = (grouped.get(measure) ?? []).map((event, noteIndex) => {
      const slot = clampSlot(Math.round((event.time - (measure - 1) * measureSeconds) / (beatSeconds / 4)));
      return sourceEventToBassRenderNote(event, measure, slot, 4, useDerivedPitchMap, `bass-${measure}-${slot}-${noteIndex}`);
    });

    return buildBassMeasure(rawNotes);
  });
}

function buildBassMeasure(rawNotes: BassRenderNote[]): BassMeasure {
  const slots = emptyBassSlots();
  const prioritizedNotes = prioritizeBassNotes(rawNotes);

  for (const note of prioritizedNotes) {
    slots[clampSlot(note.slot)].notes.push(note);
    addBassSlotLyric(slots[clampSlot(note.slot)], note.lyric ?? null, 0);
  }

  return {
    notes: prioritizedNotes,
    slots,
  };
}

function prioritizeBassNotes(notes: BassRenderNote[]): BassRenderNote[] {
  const grouped = new Map<number, BassRenderNote[]>();
  for (const note of notes) {
    const entries = grouped.get(note.slot) ?? [];
    entries.push(note);
    grouped.set(note.slot, entries);
  }

  return Array.from(grouped.entries())
    .map(([, sameSlotNotes]) =>
      [...sameSlotNotes].sort((left, right) => compareBassRenderPriority(left, right))[0],
    )
    .sort((left, right) => left.measure - right.measure || left.slot - right.slot);
}

function compareBassRenderPriority(left: BassRenderNote, right: BassRenderNote): number {
  const leftChordSlash = hasSlashChord(left.chord);
  const rightChordSlash = hasSlashChord(right.chord);
  if (leftChordSlash !== rightChordSlash) {
    return leftChordSlash ? -1 : 1;
  }

  if (left.isDead !== right.isDead) {
    return left.isDead ? 1 : -1;
  }

  const leftMidi = left.actualMidi ?? Number.POSITIVE_INFINITY;
  const rightMidi = right.actualMidi ?? Number.POSITIVE_INFINITY;
  if (leftMidi !== rightMidi) {
    return leftMidi - rightMidi;
  }

  if (left.string !== right.string) {
    return right.string - left.string;
  }

  return left.fret === "X" || right.fret === "X" ? 0 : left.fret - right.fret;
}

function compareBassSpecOrdering(left: BassSpecNote, right: BassSpecNote, bpm: number): number {
  const leftMeasure = resolveBassMeasure(left, bpm);
  const rightMeasure = resolveBassMeasure(right, bpm);
  if (leftMeasure !== rightMeasure) {
    return leftMeasure - rightMeasure;
  }

  const leftSlot = resolveBassSlot(left, bpm);
  const rightSlot = resolveBassSlot(right, bpm);
  return leftSlot - rightSlot;
}

function resolveBassMeasure(note: Pick<BassSpecNote, "measure" | "time">, bpm: number): number {
  if (note.measure && Number.isFinite(note.measure)) {
    return Math.max(1, Math.round(note.measure));
  }

  if (note.time !== undefined && Number.isFinite(note.time)) {
    const beatSeconds = 60 / Math.max(bpm || 120, 1);
    return Math.max(1, Math.floor(note.time / (beatSeconds * 4)) + 1);
  }

  return 1;
}

function resolveBassSlot(note: Pick<BassSpecNote, "measure" | "slot" | "time">, bpm: number): number {
  if (note.slot !== undefined && Number.isFinite(note.slot)) {
    return clampSlot(Math.round(note.slot));
  }

  if (note.time !== undefined && Number.isFinite(note.time)) {
    const beatSeconds = 60 / Math.max(bpm || 120, 1);
    const measureSeconds = beatSeconds * 4;
    const localMeasure = Math.floor(note.time / measureSeconds);
    const measureStart = localMeasure * measureSeconds;
    return clampSlot(Math.floor((note.time - measureStart) / (measureSeconds / SLOTS_PER_MEASURE)));
  }

  return 0;
}

function bassSpecNoteToRenderNote(note: BassSpecNote, measure: number, slot: number, index: number): BassRenderNote {
  const techniques = normalizeBassTechniques(note);
  const actualMidi = resolveBassActualMidi(note, techniques);
  const position = resolveBassPosition(note, actualMidi);
  const durationSlots = resolveBassDurationSlots(note.duration, note.duration_slots);
  const isDead = position.fret === "X" || techniques.includes("DEAD") || Boolean(note.is_dead);
  const stringMidi = BASS_STRING_OPEN_MIDI[position.string];
  const fallbackMidi = actualMidi ?? stringMidi;

  return {
    actualMidi: fallbackMidi,
    chord: note.chord ?? note.harmony ?? null,
    confidence: note.confidence ?? 1,
    displayStaffKey: resolveBassDisplayStaffKey(note.staff_key ?? null, fallbackMidi),
    duration: bassDurationFromSlots(durationSlots),
    durationSlots,
    fret: isDead ? "X" : position.fret,
    id: note.id ?? `bass-${measure}-${slot}-${index}`,
    isDead,
    isStaccato: Boolean(note.is_staccato),
    lyric: note.lyric ?? null,
    measure,
    slot,
    string: position.string,
    techniques,
    tieFromPrevious: Boolean(note.tie_from_previous),
    tieToNext: Boolean(note.tie_to_next),
  };
}

function sourceEventToBassRenderNote(
  source: BassSourceLike,
  measure: number,
  slot: number,
  rawDurationSlots: number,
  useDerivedPitchMap: boolean,
  id: string,
): BassRenderNote {
  const derivedDrum = (source.drum ?? source.note) ?? null;
  const techniques = normalizeBassTechniques(source);
  const actualMidi = useDerivedPitchMap
    ? (derivedDrum ? BASS_DERIVED_ACTUAL_MIDI[derivedDrum] : null)
    : resolveBassActualMidi(source, techniques);
  const position = resolveBassPosition(source, actualMidi);
  const durationSlots = enforceBassDurationSlots(rawDurationSlots);
  const fallbackMidi = actualMidi ?? BASS_STRING_OPEN_MIDI[position.string];
  const chord = readString(source.chord) ?? readString(source.harmony) ?? null;
  const lyric = readString(source.lyric);

  return {
    actualMidi: fallbackMidi,
    chord,
    confidence: readNumber(source.confidence) ?? 1,
    displayStaffKey: resolveBassDisplayStaffKey(readString(source.staff_key), fallbackMidi),
    duration: bassDurationFromSlots(durationSlots),
    durationSlots,
    fret: position.fret,
    id,
    isDead: position.fret === "X" || techniques.includes("DEAD") || readBoolean(source.is_dead),
    isStaccato: readBoolean(source.is_staccato),
    lyric,
    measure,
    slot,
    string: position.string,
    techniques,
    tieFromPrevious: readBoolean(source.tie_from_previous),
    tieToNext: readBoolean(source.tie_to_next),
  };
}

function pickDerivedBassEvent(events: BassSourceLike[]): BassSourceLike | null {
  return (
    [...events].sort((left, right) => {
      const leftDrum = left.drum ?? left.note;
      const rightDrum = right.drum ?? right.note;
      const leftMidi = leftDrum ? BASS_DERIVED_ACTUAL_MIDI[leftDrum] : Number.POSITIVE_INFINITY;
      const rightMidi = rightDrum ? BASS_DERIVED_ACTUAL_MIDI[rightDrum] : Number.POSITIVE_INFINITY;
      return leftMidi - rightMidi;
    })[0] ?? null
  );
}

function pickExplicitBassEvent(events: BassSourceLike[]): BassSourceLike | null {
  return (
    [...events].sort((left, right) => {
      const leftMidi = resolveBassActualMidi(left, normalizeBassTechniques(left)) ?? Number.POSITIVE_INFINITY;
      const rightMidi = resolveBassActualMidi(right, normalizeBassTechniques(right)) ?? Number.POSITIVE_INFINITY;
      return leftMidi - rightMidi;
    })[0] ?? null
  );
}

function resolveBassActualMidi(
  source: BassSourceLike,
  techniques: BassTechnique[],
): number | null {
  const explicitString = readBassString(source.string) ?? readBassString(source.prefer_string);
  const explicitFret = normalizeBassFret(source.fret);
  if (explicitString && typeof explicitFret === "number") {
    return BASS_STRING_OPEN_MIDI[explicitString] + explicitFret;
  }

  let midi = readNumber(source.midi_note);
  const slashMidi = slashChordBassMidi(readString(source.chord) ?? readString(source.harmony), midi);
  if (slashMidi !== null) {
    midi = slashMidi;
  }

  if (midi === null) {
    const displayMidi = midiFromStaffKey(readString(source.staff_key));
    if (displayMidi !== null) {
      midi = displayMidi - 12;
    }
  }

  if (midi === null && explicitString) {
    return BASS_STRING_OPEN_MIDI[explicitString];
  }

  if (techniques.includes("DEAD") && explicitString) {
    return BASS_STRING_OPEN_MIDI[explicitString];
  }

  return midi;
}

function resolveBassPosition(
  source: BassSourceLike,
  actualMidi: number | null,
): { fret: number | "X"; string: 1 | 2 | 3 | 4 } {
  const explicitString = readBassString(source.string);
  const preferredString = readBassString(source.prefer_string);
  const explicitFret = normalizeBassFret(source.fret);
  const deadRequested = explicitFret === "X" || readBoolean(source.is_dead);

  if (explicitString && explicitFret !== null) {
    return { fret: deadRequested ? "X" : explicitFret, string: explicitString };
  }

  if (explicitString && actualMidi !== null) {
    const fret = Math.round(actualMidi - BASS_STRING_OPEN_MIDI[explicitString]);
    if (fret >= BASS_FRET_MIN && fret <= BASS_FRET_MAX) {
      return { fret: deadRequested ? "X" : fret, string: explicitString };
    }
  }

  if (actualMidi !== null) {
    const candidate = chooseBassPosition(actualMidi, preferredString ?? explicitString ?? undefined);
    if (candidate) {
      return { fret: deadRequested ? "X" : candidate.fret, string: candidate.string };
    }
  }

  return { fret: deadRequested ? "X" : 0, string: preferredString ?? explicitString ?? 4 };
}

function chooseBassPosition(
  actualMidi: number,
  preferredString?: 1 | 2 | 3 | 4,
): { fret: number; string: 1 | 2 | 3 | 4 } | null {
  const roundedMidi = Math.round(actualMidi);
  const candidates: Array<{ fret: number; octaveShift: number; string: 1 | 2 | 3 | 4 }> = [];

  for (const string of [1, 2, 3, 4] as const) {
    const fret = roundedMidi - BASS_STRING_OPEN_MIDI[string];
    if (fret >= BASS_FRET_MIN && fret <= BASS_FRET_MAX) {
      candidates.push({ fret, octaveShift: 0, string });
    }
  }

  for (const shift of [-12, 12, -24, 24]) {
    for (const string of [1, 2, 3, 4] as const) {
      const fret = roundedMidi + shift - BASS_STRING_OPEN_MIDI[string];
      if (fret >= BASS_FRET_MIN && fret <= BASS_FRET_MAX) {
        candidates.push({ fret, octaveShift: Math.abs(shift), string });
      }
    }
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort((left, right) => {
    if (preferredString && left.string !== right.string) {
      if (left.string === preferredString) {
        return -1;
      }
      if (right.string === preferredString) {
        return 1;
      }
    }

    if (left.octaveShift !== right.octaveShift) {
      return left.octaveShift - right.octaveShift;
    }
    if (left.fret !== right.fret) {
      return left.fret - right.fret;
    }
    return left.string - right.string;
  });

  return candidates[0];
}

function normalizeBassTechniques(source: BassSourceLike): BassTechnique[] {
  const techniques = new Set<BassTechnique>();

  const rawValues = [
    source.technique,
    ...(Array.isArray(source.techniques) ? source.techniques : []),
  ];

  rawValues.forEach((value) => {
    const normalized = normalizeBassTechnique(value);
    if (normalized) {
      techniques.add(normalized);
    }
  });

  if (readBoolean(source.is_dead)) {
    techniques.add("DEAD");
  }
  if (readBoolean(source.slap_style)) {
    techniques.add("SLAP");
  }
  if (readBoolean(source.is_pop)) {
    techniques.add("POP");
  }
  if (readBoolean(source.is_pull_off)) {
    techniques.add("PULL_OFF");
  }

  return Array.from(techniques);
}

function normalizeBassTechnique(value: unknown): BassTechnique | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (normalized === "H" || normalized === "HAMMER" || normalized === "HAMMER_ON" || normalized === "HAMMERON") {
    return "HAMMER_ON";
  }
  if (normalized === "PULL" || normalized === "PULLOFF" || normalized === "PULL_OFF") {
    return "PULL_OFF";
  }
  if (normalized === "S" || normalized === "SLIDE") {
    return "SLIDE";
  }
  if (normalized === "X" || normalized === "DEAD" || normalized === "MUTED" || normalized === "MUTE") {
    return "DEAD";
  }
  if (normalized === "T" || normalized === "THUMB" || normalized === "SLAP") {
    return "SLAP";
  }
  if (normalized === "POP") {
    return "POP";
  }
  return null;
}

function resolveBassDurationSlots(duration?: BassDuration, durationSlots?: number): number {
  if (durationSlots !== undefined && Number.isFinite(durationSlots)) {
    return enforceBassDurationSlots(durationSlots);
  }

  switch (duration) {
    case "w":
      return 16;
    case "h":
      return 8;
    case "q":
      return 4;
    case "8":
      return 2;
    case "16":
      return 1;
    default:
      return 4;
  }
}

function durationSlotsFromTickLike(durationTicks: number, ticksPerQuarter: number): number {
  const slotTicks = Math.max(1, Math.round(ticksPerQuarter / 4));
  return enforceBassDurationSlots(Math.max(1, Math.round(durationTicks / slotTicks)));
}

function enforceBassDurationSlots(value: number): number {
  const rounded = Math.max(1, Math.round(value));
  const supported = [16, 8, 4, 2, 1];
  return supported.reduce((closest, candidate) =>
    Math.abs(candidate - rounded) < Math.abs(closest - rounded) ? candidate : closest,
  );
}

function bassDurationFromSlots(durationSlots: number): BassDuration {
  switch (enforceBassDurationSlots(durationSlots)) {
    case 16:
      return "w";
    case 8:
      return "h";
    case 4:
      return "q";
    case 2:
      return "8";
    default:
      return "16";
  }
}

function resolveBassDisplayStaffKey(staffKey: string | null, actualMidi: number): string {
  const normalized = normalizeStaffKey(staffKey);
  if (normalized) {
    return normalized;
  }

  return staffKeyFromMidi(actualMidi + 12) ?? "e/3";
}

function slashChordBassMidi(chord: string | null, anchorMidi: number | null): number | null {
  const bassToken = chord?.split("/")[1]?.trim();
  if (!bassToken) {
    return null;
  }

  const pitchClass = pitchClassFromToken(bassToken);
  if (pitchClass === null) {
    return null;
  }

  const minimumMidi = BASS_STRING_OPEN_MIDI[4];
  const maximumMidi = BASS_STRING_OPEN_MIDI[1] + BASS_FRET_MAX;
  const anchor = anchorMidi ?? minimumMidi + 7;
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let octave = 0; octave <= 8; octave += 1) {
    const midi = pitchClass + octave * 12;
    if (midi < minimumMidi || midi > maximumMidi) {
      continue;
    }
    const distance = Math.abs(midi - anchor);
    if (distance < bestDistance || (distance === bestDistance && best !== null && midi < best)) {
      best = midi;
      bestDistance = distance;
    }
  }

  return best;
}

function pitchClassFromToken(token: string): number | null {
  const normalized = token.trim().toUpperCase().replace(/[^A-G#B]/g, "");
  const note = normalized.slice(0, 2).endsWith("#") || normalized.slice(0, 2).endsWith("B")
    ? normalized.slice(0, 2)
    : normalized.slice(0, 1);

  const pitchClasses: Record<string, number> = {
    A: 9,
    "A#": 10,
    AB: 8,
    B: 11,
    BB: 10,
    C: 0,
    "C#": 1,
    CB: 11,
    D: 2,
    "D#": 3,
    DB: 1,
    E: 4,
    EB: 3,
    F: 5,
    "F#": 6,
    FB: 4,
    G: 7,
    "G#": 8,
    GB: 6,
  };

  return pitchClasses[note] ?? null;
}

function emptyBassSlots(): BassSlot[] {
  return Array.from({ length: SLOTS_PER_MEASURE }, () => ({
    lyric: null,
    lyrics: [],
    notes: [],
  }));
}

function hasAnyBassLyrics(measures: BassMeasure[]): boolean {
  return measures.some((measure) =>
    measure.slots.some((slot) => Boolean(slot.lyric?.trim()) || slot.lyrics.some((entry) => Boolean(entry.lyric.trim()))),
  );
}

function applyBassWordsFallback(measures: BassMeasure[], words: LyricWord[], bpm: number): BassMeasure[] {
  if (!words.length) {
    return measures.length ? measures : [{ notes: [], slots: emptyBassSlots() }];
  }

  const beatSeconds = 60 / Math.max(bpm || 120, 1);
  const measureSeconds = beatSeconds * 4;
  const slotSeconds = measureSeconds / SLOTS_PER_MEASURE;

  for (const word of words) {
    const measureIndex = Math.max(0, Math.floor(word.start / measureSeconds));
    const measure = ensureBassMeasure(measures, measureIndex);
    const measureStart = measureIndex * measureSeconds;
    const slotIndex = Math.min(
      SLOTS_PER_MEASURE - 1,
      Math.max(0, Math.floor((word.start - measureStart) / slotSeconds)),
    );
    const targetSlot = firstAvailableBassLyricSlot(measure.slots, slotIndex);
    if (targetSlot !== null) {
      addBassSlotLyric(measure.slots[targetSlot], word.word.trim().normalize("NFC"), 0);
    }
  }

  return measures;
}

function ensureBassMeasure(measures: BassMeasure[], measureIndex: number): BassMeasure {
  while (measures.length <= measureIndex) {
    measures.push({ notes: [], slots: emptyBassSlots() });
  }
  return measures[measureIndex];
}

function firstAvailableBassLyricSlot(slots: BassSlot[], preferredSlot: number): number | null {
  for (let slot = preferredSlot; slot < SLOTS_PER_MEASURE; slot += 1) {
    if (!slots[slot].lyric?.trim() && slots[slot].lyrics.length === 0) {
      return slot;
    }
  }
  return null;
}

function addBassSlotLyric(slot: BassSlot, next: string | null | undefined, row: number) {
  const cleanNext = next?.trim().normalize("NFC");
  if (!cleanNext) {
    return;
  }

  const cleanRow = Math.max(0, row);
  slot.lyrics.push({ lyric: cleanNext, row: cleanRow });
  slot.lyrics.sort((left, right) => left.row - right.row);
  slot.lyric = mergeLyric(slot.lyric, cleanNext);
}

function measuresFromEngraved(
  engravedMeasures: EngravedMeasure[],
  instrument: Exclude<InstrumentType, "DRUM" | "BASS">,
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
  instrument: Exclude<InstrumentType, "DRUM" | "BASS">,
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
  instrument: Exclude<InstrumentType, "DRUM" | "BASS">,
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
  instrument: Exclude<InstrumentType, "DRUM" | "BASS">,
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
  instrument: Exclude<InstrumentType, "DRUM" | "BASS">,
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

function resolveBassSpec(value: SourceTagged | null | undefined): BassSpec | null {
  return value?.bassSpec ?? value?.bass_spec ?? value?.BASS_SPEC ?? null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readBassString(value: unknown): 1 | 2 | 3 | 4 | null {
  if (value === 1 || value === 2 || value === 3 || value === 4) {
    return value;
  }
  return null;
}

function normalizeBassFret(value: unknown): number | "X" | null {
  if (value === "X" || value === "x") {
    return "X";
  }

  if (typeof value === "string" && value.trim() === "0") {
    return 0;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(BASS_FRET_MIN, Math.min(BASS_FRET_MAX, Math.round(value)));
  }

  return null;
}

function midiFromStaffKey(staffKey: string | null): number | null {
  const normalized = normalizeStaffKey(staffKey);
  if (!normalized) {
    return null;
  }

  const match = /^([a-g])([#b]?)[/](-?\d+)$/.exec(normalized);
  if (!match) {
    return null;
  }

  const noteToSemitone: Record<string, number> = {
    a: 9,
    b: 11,
    c: 0,
    d: 2,
    e: 4,
    f: 5,
    g: 7,
  };
  const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  return (Number(match[3]) + 1) * 12 + noteToSemitone[match[1]] + accidental;
}

function hasSlashChord(chord: string | null | undefined): boolean {
  return Boolean(chord && chord.includes("/"));
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
  instrument: Exclude<InstrumentType, "DRUM" | "BASS">,
  voice: VoiceNumber,
): string {
  if (instrument === "KEYBOARD") {
    return voice === 1 ? "c/5" : "c/3";
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
