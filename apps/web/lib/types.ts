export type DrumNote =
  | "kick"
  | "snare"
  | "hihat_closed"
  | "hihat_open"
  | "tom"
  | "crash"
  | "ride";

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
};

export type AnalysisJobStatus = {
  job_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  detail?: string | null;
  result?: AnalysisResult | null;
};
