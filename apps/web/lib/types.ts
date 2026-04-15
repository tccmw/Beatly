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
  articulation: "accent" | "open" | "none";
  lyric?: string | null;
  confidence: number;
};

export type AnalysisResult = {
  bpm: number;
  events: ScoreEvent[];
  words: LyricWord[];
  ticks_per_quarter: number;
  midi_ticks: MidiTickEvent[];
};
