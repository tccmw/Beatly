"use client";

import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { DrumSheet, type DrumSheetHandle, type PrintableScoreSystem } from "@/components/DrumSheet";
import { MelodicSheet } from "@/components/MelodicSheet";
import { resolveInstrumentView } from "@/lib/scoreTracks";
import type { AnalysisResult, InstrumentType } from "@/lib/types";

type Props = {
  audioCurrentTime?: number;
  followPlayback?: boolean;
  instrument: InstrumentType;
  isPlaying?: boolean;
  onFollowPlaybackChange?: (enabled: boolean) => void;
  onSeek?: (time: number) => void;
  score: AnalysisResult;
  showLyrics?: boolean;
};

export type ScoreSheetHandle = {
  getPrintableSystems: () => PrintableScoreSystem[];
};

export const ScoreSheet = forwardRef<ScoreSheetHandle, Props>(function ScoreSheet(
  { audioCurrentTime = 0, followPlayback = true, instrument, isPlaying = false, onFollowPlaybackChange, onSeek, score, showLyrics = true }: Props,
  ref,
) {
  const innerRef = useRef<DrumSheetHandle | null>(null);
  const view = useMemo(() => resolveInstrumentView(score, instrument), [instrument, score]);

  useImperativeHandle(
    ref,
    () => ({
      getPrintableSystems: () => innerRef.current?.getPrintableSystems() ?? [],
    }),
    [],
  );

  if (view.instrumentType === "DRUM") {
    return (
      <DrumSheet
        audioCurrentTime={audioCurrentTime}
        followPlayback={followPlayback}
        isPlaying={isPlaying}
        onFollowPlaybackChange={onFollowPlaybackChange}
        onSeek={onSeek}
        ref={innerRef}
        score={view.score}
        showLyrics={showLyrics}
      />
    );
  }

  return (
    <MelodicSheet
      audioCurrentTime={audioCurrentTime}
      followPlayback={followPlayback}
      isPlaying={isPlaying}
      onFollowPlaybackChange={onFollowPlaybackChange}
      onSeek={onSeek}
      ref={innerRef}
      showLyrics={showLyrics}
      track={view.track}
    />
  );
});
