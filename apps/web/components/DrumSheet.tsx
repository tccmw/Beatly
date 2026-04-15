"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  Formatter,
  Renderer,
  Stave,
  StaveNote,
  Voice,
} from "vexflow";
import type { AnalysisResult, DrumNote, ScoreEvent } from "@/lib/types";

type Props = { score: AnalysisResult };
type MeasureSlot = ScoreEvent & { rest?: boolean };

const NOTE_MAP: Record<DrumNote, { key: string; stem: "up" | "down"; symbol?: "x" | "open-x"; label: string }> = {
  crash: { key: "a/5", stem: "up", symbol: "x", label: "Crash" },
  ride: { key: "g/5", stem: "up", symbol: "x", label: "Ride" },
  hihat_open: { key: "g/5", stem: "up", symbol: "open-x", label: "Open HH" },
  hihat_closed: { key: "g/5", stem: "up", symbol: "x", label: "Hi-hat" },
  snare: { key: "c/5", stem: "up", label: "Snare" },
  tom: { key: "e/5", stem: "up", label: "Tom" },
  kick: { key: "f/4", stem: "down", label: "Kick" },
};

const MEASURES_PER_LINE = 4;
const MEASURE_WIDTH = 245;
const LEFT_MARGIN = 24;
const TOP_MARGIN = 24;
const LINE_HEIGHT = 205;

export function DrumSheet({ score }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measures = useMemo(() => toMeasures(score), [score]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    container.innerHTML = "";
    const width = LEFT_MARGIN * 2 + MEASURES_PER_LINE * MEASURE_WIDTH;
    const height = Math.max(260, Math.ceil(measures.length / MEASURES_PER_LINE) * LINE_HEIGHT + TOP_MARGIN);
    const renderer = new Renderer(container, Renderer.Backends.SVG);
    renderer.resize(width, height);
    const context = renderer.getContext();
    context.setFont("Arial", 12);

    measures.forEach((measure, index) => {
      const column = index % MEASURES_PER_LINE;
      const row = Math.floor(index / MEASURES_PER_LINE);
      const x = LEFT_MARGIN + column * MEASURE_WIDTH;
      const y = TOP_MARGIN + row * LINE_HEIGHT;
      const staveWidth = MEASURE_WIDTH;

      const stave = new Stave(x, y, staveWidth);
      if (index === 0) {
        stave.addClef("percussion").addTimeSignature("4/4");
      }
      stave.setContext(context).draw();

      const vexNotes = measure.events.map((event) => makeVexNote(event));
      const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
      voice.addTickables(vexNotes);
      new Formatter().joinVoices([voice]).format([voice], staveWidth - (index === 0 ? 72 : 24));
      voice.draw(context, stave);

      measure.events.forEach((event, eventIndex) => {
        drawDrumSymbol(context, vexNotes[eventIndex], event);
        const lyric = event.lyric?.trim();
        if (!lyric) {
          return;
        }
        const note = vexNotes[eventIndex];
        const lyricX = note.getAbsoluteX() - 10;
        const lyricY = y + 112;
        context.fillText(lyric, lyricX, lyricY);
      });
    });
  }, [measures]);

  return (
    <div className="score-wrap" aria-label="Drum sheet with lyrics">
      <div className="score-canvas" ref={containerRef} />
    </div>
  );
}

function makeVexNote(event: MeasureSlot): StaveNote {
  const notation = NOTE_MAP[event.note];
  return new StaveNote({
    clef: "percussion",
    keys: [notation.key],
    duration: event.rest ? "8r" : "8",
    stem_direction: notation.stem === "up" ? 1 : -1,
  });
}

function drawDrumSymbol(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  note: StaveNote,
  event: MeasureSlot,
) {
  if (event.rest) {
    return;
  }

  const symbol = NOTE_MAP[event.note].symbol;
  if (!symbol) {
    return;
  }

  const ys = note.getYs();
  const y = ys[0] ?? 0;
  const x = note.getAbsoluteX();
  context.save();
  context.setFont("Arial", 15, "bold");
  context.fillText("x", x - 4, y + 5);
  if (symbol === "open-x") {
    context.setFont("Arial", 12);
    context.fillText("o", x - 4, y - 10);
  }
  context.restore();
}

function toMeasures(score: AnalysisResult): Array<{ start: number; events: MeasureSlot[] }> {
  const beatSeconds = 60 / Math.max(score.bpm || 120, 1);
  const measureSeconds = beatSeconds * 4;
  const sorted = [...score.events].sort((a, b) => a.time - b.time);
  const grouped = new Map<number, ScoreEvent[]>();

  for (const event of sorted) {
    const measureIndex = Math.max(0, Math.floor(event.time / measureSeconds));
    const events = grouped.get(measureIndex) ?? [];
    events.push(event);
    grouped.set(measureIndex, events);
  }

  const measureCount = Math.max(1, Math.max(...grouped.keys(), 0) + 1);
  return Array.from({ length: measureCount }, (_, index) => ({
    start: index * measureSeconds,
    events: normalizeMeasure(grouped.get(index) ?? [], index * measureSeconds, beatSeconds),
  }));
}

function normalizeMeasure(events: ScoreEvent[], measureStart: number, beatSeconds: number): MeasureSlot[] {
  const slots = new Map<number, ScoreEvent>();

  for (const event of events) {
    const slot = Math.min(7, Math.max(0, Math.round((event.time - measureStart) / (beatSeconds / 2))));
    const current = slots.get(slot);
    if (!current || event.confidence > current.confidence) {
      slots.set(slot, event);
    }
  }

  return Array.from({ length: 8 }, (_, slot) => {
    const event = slots.get(slot);
    if (event) {
      return event;
    }
    return {
      time: measureStart + slot * (beatSeconds / 2),
      note: "snare",
      lyric: null,
      confidence: 0,
      rest: true,
    };
  });
}
