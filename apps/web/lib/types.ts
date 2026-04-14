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

export type AnalysisResult = {
  bpm: number;
  events: ScoreEvent[];
  words: LyricWord[];
};
