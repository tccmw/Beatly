export type DrumNote =
  | "kick"
  | "snare"
  | "hihat_closed"
  | "hihat_open"
  | "tom"
  | "crash"
  | "ride";

export type InstrumentType = "DRUM" | "BASS" | "GUITAR" | "KEYBOARD";
export type InstrumentNotation = "percussion" | "staff" | "grand";
export type BassRenderMode = "standard" | "tab" | "both";
export type BassDuration = "w" | "h" | "q" | "8" | "16";
export type BassTechnique =
  | "HAMMER_ON"
  | "PULL_OFF"
  | "SLIDE"
  | "DEAD"
  | "SLAP"
  | "POP";

export type ScoreEvent = {
  time: number;
  note: DrumNote;
  lyric?: string | null;
  confidence: number;
};

export type LyricWord = {
  word: string;
  start: number;
  end: number;
};

export type MidiTickEvent = {
  tick: number;
  duration_ticks: number;
  measure: number;
  slot: number;
  voice: 1 | 2;
  midi_note: number;
  drum: DrumNote;
  staff_key: string;
  notehead: "normal" | "x";
  articulation: "accent" | "open" | "closed" | "ghost" | "none";
  lyric?: string | null;
  confidence: number;
};

export type EngravedEvent = {
  drum: DrumNote;
  midi_note: number;
  staff_key: string;
  notehead: "normal" | "x";
  articulation: "accent" | "open" | "closed" | "ghost" | "none";
  lyric?: string | null;
  confidence: number;
};

export type EngravedTick = {
  slot: number;
  duration: "q" | "8" | "16";
  duration_ticks: number;
  rest: boolean;
  voice: 1 | 2;
  events: EngravedEvent[];
  lyric?: string | null;
};

export type LyricSlot = {
  slot: number;
  lyric: string;
  row?: number;
};

export type EngravedSlot = {
  slot: number;
  lyric?: string | null;
};

export type EngravedMeasure = {
  measure: number;
  voice1: EngravedTick[];
  voice2: EngravedTick[];
  slots?: EngravedSlot[];
  lyric_slots: LyricSlot[];
};

export type AnalysisResult = {
  bpm: number;
  events: ScoreEvent[];
  words: LyricWord[];
  ticks_per_quarter: number;
  midi_ticks: MidiTickEvent[];
  engraved_measures: EngravedMeasure[];
  instrumentType?: InstrumentType;
  instrument_type?: InstrumentType;
  bassSpec?: BassSpec;
  bass_spec?: BassSpec;
  BASS_SPEC?: BassSpec;
  tracks?: AnalysisTrack[];
};

export type AnalysisTrack = {
  id?: string;
  label?: string;
  name?: string;
  bpm?: number;
  notation?: InstrumentNotation;
  instrumentType?: InstrumentType;
  instrument_type?: InstrumentType;
  bassSpec?: BassSpec;
  bass_spec?: BassSpec;
  BASS_SPEC?: BassSpec;
  events?: ScoreEvent[];
  words?: LyricWord[];
  ticks_per_quarter?: number;
  midi_ticks?: MidiTickEvent[];
  engraved_measures?: EngravedMeasure[];
};

export type BassSpec = {
  mode?: BassRenderMode;
  notes: BassSpecNote[];
};

export type BassSpecNote = {
  id?: string;
  time?: number;
  measure?: number;
  slot?: number;
  duration?: BassDuration;
  duration_slots?: number;
  midi_note?: number;
  staff_key?: string | null;
  string?: 1 | 2 | 3 | 4;
  fret?: number | "X" | "x" | "0";
  lyric?: string | null;
  confidence?: number;
  chord?: string | null;
  harmony?: string | null;
  technique?: string | null;
  techniques?: string[];
  is_dead?: boolean;
  is_staccato?: boolean;
  tie_to_next?: boolean;
  tie_from_previous?: boolean;
  slur_to_next?: boolean;
  slur_from_previous?: boolean;
  prefer_string?: 1 | 2 | 3 | 4;
  slap_style?: boolean;
  is_pop?: boolean;
  is_pull_off?: boolean;
};

export type AnalysisJobStatus = {
  job_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  detail?: string | null;
  result?: AnalysisResult | null;
};
