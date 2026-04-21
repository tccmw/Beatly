"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Articulation, Formatter, Renderer, Stave, StaveNote, Voice } from "vexflow";
import type { AnalysisResult, DrumNote, EngravedMeasure, LyricWord, MidiTickEvent, ScoreEvent } from "@/lib/types";

type Props = {
  audioCurrentTime?: number;
  onSeek?: (time: number) => void;
  score: AnalysisResult;
  showLyrics?: boolean;
};
type VoiceNumber = 1 | 2;
type NotationEvent = Pick<
  MidiTickEvent,
  "drum" | "staff_key" | "voice" | "notehead" | "articulation" | "lyric" | "confidence"
>;
type MeasureSlot = {
  voice1: NotationEvent[];
  voice2: NotationEvent[];
  lyric?: string | null;
  lyrics: SlotLyric[];
};
type SlotLyric = {
  lyric: string;
  row: number;
};
type Measure = { slots: MeasureSlot[] };
type DisplayTick = {
  slot: number;
  duration: "q" | "8" | "16";
  events: NotationEvent[];
  hiddenRest?: boolean;
};
type MeasureLayout = {
  bottom: number;
  gridEndX: number;
  gridStartX: number;
  measure: number;
  slotWidth: number;
  top: number;
};
type PlaybackPosition = {
  measure: number;
  slot: number;
  slotProgress: number;
};
export type PrintableScoreSystem = {
  height: number;
  measureEnd: number;
  measureStart: number;
  svgMarkup: string;
  width: number;
};
export type DrumSheetHandle = {
  getPrintableSystems: () => PrintableScoreSystem[];
};

const NOTE_MAP: Record<DrumNote, { key: string; voice: VoiceNumber; notehead: "normal" | "x"; order: number }> = {
  crash: { key: "a/5", voice: 1, notehead: "x", order: 0 },
  hihat_open: { key: "g/5", voice: 1, notehead: "x", order: 1 },
  hihat_closed: { key: "g/5", voice: 1, notehead: "x", order: 2 },
  ride: { key: "f/5", voice: 1, notehead: "x", order: 3 },
  snare: { key: "c/5", voice: 1, notehead: "normal", order: 4 },
  tom: { key: "e/5", voice: 1, notehead: "normal", order: 5 },
  kick: { key: "f/4", voice: 2, notehead: "normal", order: 6 },
};

const MEASURES_PER_LINE = 4;
const MEASURE_WIDTH = 320;
const LEFT_MARGIN = 28;
const TOP_MARGIN = 26;
const LINE_HEIGHT_WITH_LYRICS = 178;
const LINE_HEIGHT_WITHOUT_LYRICS = 142;
const SLOTS_PER_MEASURE = 16;
const LYRIC_FONT_SIZE = 12;
const LYRIC_HORIZONTAL_PADDING_PX = 5;
const LYRIC_MAX_ROWS = 2;

export const DrumSheet = forwardRef<DrumSheetHandle, Props>(function DrumSheet(
  { audioCurrentTime = 0, onSeek, score, showLyrics = true }: Props,
  ref,
) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const svgLayerRef = useRef<HTMLDivElement | null>(null);
  const [measureLayouts, setMeasureLayouts] = useState<MeasureLayout[]>([]);
  const measures = useMemo(() => toMeasures(score), [score]);
  const lineHeight = showLyrics ? LINE_HEIGHT_WITH_LYRICS : LINE_HEIGHT_WITHOUT_LYRICS;
  const playbackPosition = useMemo(
    () => timeToPlaybackPosition(audioCurrentTime, score.bpm, measures.length),
    [audioCurrentTime, measures.length, score.bpm],
  );
  const activeLayout = measureLayouts[playbackPosition.measure - 1] ?? null;
  const activeMeasure = measures[playbackPosition.measure - 1] ?? null;
  const activeSlot = activeMeasure?.slots[playbackPosition.slot] ?? null;
  const activeLyric = showLyrics
    ? (activeSlot?.lyrics[0]?.lyric?.trim().normalize("NFC") ??
      activeSlot?.lyric?.trim().normalize("NFC") ??
      null)
    : null;
  const cursorX = activeLayout
    ? activeLayout.gridStartX +
      (playbackPosition.slotProgress / SLOTS_PER_MEASURE) * (activeLayout.gridEndX - activeLayout.gridStartX)
    : 0;
  const activeSlotLeft = activeLayout ? activeLayout.gridStartX + playbackPosition.slot * activeLayout.slotWidth : 0;
  const activeSlotHeight = activeLayout ? activeLayout.bottom - activeLayout.top : 0;

  useImperativeHandle(
    ref,
    () => ({
      getPrintableSystems: () => collectPrintableSystems(svgLayerRef.current, measureLayouts),
    }),
    [measureLayouts],
  );

  useEffect(() => {
    const container = svgLayerRef.current;
    if (!container) {
      return;
    }

    container.innerHTML = "";

    const width = LEFT_MARGIN * 2 + MEASURES_PER_LINE * MEASURE_WIDTH;
    const height = Math.max(240, Math.ceil(measures.length / MEASURES_PER_LINE) * lineHeight + TOP_MARGIN);
    const renderer = new Renderer(container, Renderer.Backends.SVG);
    renderer.resize(width, height);

    const context = renderer.getContext();
    context.setFont("Arial, Malgun Gothic, sans-serif", 12);
    const nextLayouts: MeasureLayout[] = [];

    measures.forEach((measure, index) => {
      const column = index % MEASURES_PER_LINE;
      const row = Math.floor(index / MEASURES_PER_LINE);
      const x = LEFT_MARGIN + column * MEASURE_WIDTH;
      const y = TOP_MARGIN + row * lineHeight;
      const staveWidth = MEASURE_WIDTH;

      const stave = new Stave(x, y, staveWidth);
      if (index === 0) {
        stave.addClef("percussion").addTimeSignature("4/4");
      }
      stave.setContext(context).draw();
      drawMeasureNumber(context, index + 1, x, y);

      const upperTicks = simplifyVoice(measure, 1);
      const lowerTicks = simplifyVoice(measure, 2);
      const upperNotes = upperTicks.map((tick) => makeVoiceNote(tick, 1));
      const lowerNotes = lowerTicks.map((tick) => makeVoiceNote(tick, 2));
      const upperVoice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(true);
      const lowerVoice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(true);

      upperVoice.addTickables(upperNotes);
      lowerVoice.addTickables(lowerNotes);

      new Formatter()
        .joinVoices([upperVoice, lowerVoice])
        .format([upperVoice, lowerVoice], staveWidth - (index === 0 ? 76 : 24));

      prepareStraightBeamStems(upperNotes, upperTicks, 1);

      upperVoice.draw(context, stave);
      lowerVoice.draw(context, stave);

      drawStraightBeams(context, upperNotes, upperTicks, 1);

      upperTicks.forEach((tick, tickIndex) => {
        drawHiHatStateMarks(context, upperNotes[tickIndex], tick);
        drawGhostSnareMarks(context, upperNotes[tickIndex], tick);
      });
      if (showLyrics) {
        drawLyricLane(context, stave, measure);
      }
      nextLayouts.push(measureLayoutFromStave(stave, index + 1, showLyrics));
    });

    setMeasureLayouts(nextLayouts);
  }, [lineHeight, measures, showLyrics]);

  useEffect(() => {
    const layout = activeLayout;
    const board = boardRef.current;
    const scrollContainer = scrollRef.current;
    if (!layout || !board || !scrollContainer) {
      return;
    }

    const centerX = layout.gridStartX + (layout.gridEndX - layout.gridStartX) / 2;
    const targetLeft = Math.max(0, centerX - scrollContainer.clientWidth / 2);
    scrollContainer.scrollTo({ left: targetLeft, behavior: "smooth" });

    const boardRect = board.getBoundingClientRect();
    const centerY = boardRect.top + (layout.top + layout.bottom) / 2;
    const targetTop = Math.max(0, window.scrollY + centerY - window.innerHeight / 2);
    if (Math.abs(targetTop - window.scrollY) > 80) {
      window.scrollTo({ top: targetTop, behavior: "smooth" });
    }
  }, [activeLayout, playbackPosition.measure]);

  function handleBoardClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!onSeek || !boardRef.current) {
      return;
    }

    const rect = boardRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const layout = findMeasureLayoutAtPoint(measureLayouts, x, y);
    if (!layout) {
      return;
    }

    const beatSeconds = 60 / Math.max(score.bpm || 120, 1);
    const measureSeconds = beatSeconds * 4;
    const fraction = clamp((x - layout.gridStartX) / (layout.gridEndX - layout.gridStartX), 0, 1);
    onSeek((layout.measure - 1) * measureSeconds + fraction * measureSeconds);
  }

  return (
    <div className="score-wrap" ref={scrollRef} aria-label="Drum sheet with synchronized playback">
      <div className="score-canvas">
        <div
          className={onSeek ? "score-board seekable" : "score-board"}
          onClick={handleBoardClick}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (onSeek && activeLayout) {
                const beatSeconds = 60 / Math.max(score.bpm || 120, 1);
                onSeek((activeLayout.measure - 1) * beatSeconds * 4);
              }
            }
          }}
          ref={boardRef}
          role={onSeek ? "button" : undefined}
          tabIndex={onSeek ? 0 : undefined}
        >
          <div className="score-svg-layer" ref={svgLayerRef} />
          {activeLayout ? (
            <div className="score-overlay-layer" aria-hidden="true">
              <div
                className="playback-slot-highlight"
                style={{
                  height: activeSlotHeight,
                  transform: `translate(${activeSlotLeft}px, ${activeLayout.top}px)`,
                  width: activeLayout.slotWidth,
                }}
              />
              <div
                className="playback-cursor"
                style={{
                  height: activeSlotHeight,
                  transform: `translate(${cursorX}px, ${activeLayout.top}px)`,
                }}
              />
              {activeLyric ? (
                <div
                  className="playback-lyric-highlight"
                  style={{
                    transform: `translate(${cursorX}px, ${activeLayout.bottom - 28}px)`,
                  }}
                >
                  {activeLyric}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

function collectPrintableSystems(
  container: HTMLDivElement | null,
  layouts: MeasureLayout[],
): PrintableScoreSystem[] {
  const sourceSvg = container?.querySelector("svg");
  if (!sourceSvg || !layouts.length) {
    return [];
  }

  const parsedViewBox = parseSvgViewBox(sourceSvg.getAttribute("viewBox"));
  const fullWidth = parsedViewBox?.width ?? svgDimension(sourceSvg, "width");
  const fullHeight = parsedViewBox?.height ?? svgDimension(sourceSvg, "height");
  const viewBoxX = parsedViewBox?.x ?? 0;
  const viewBoxY = parsedViewBox?.y ?? 0;
  if (fullWidth <= 0 || fullHeight <= 0) {
    return [];
  }

  return groupLayoutsBySystem(layouts).map((group) => {
    const top = Math.max(viewBoxY, Math.floor(Math.min(...group.map((layout) => layout.top)) - 8));
    const bottom = Math.min(viewBoxY + fullHeight, Math.ceil(Math.max(...group.map((layout) => layout.bottom)) + 8));
    const height = Math.max(1, bottom - top);
    const clonedSvg = sourceSvg.cloneNode(true) as SVGSVGElement;
    clonedSvg.setAttribute("width", String(fullWidth));
    clonedSvg.setAttribute("height", String(height));
    clonedSvg.setAttribute("viewBox", `${viewBoxX} ${top} ${fullWidth} ${height}`);

    return {
      height,
      measureEnd: group[group.length - 1].measure,
      measureStart: group[0].measure,
      svgMarkup: clonedSvg.outerHTML,
      width: fullWidth,
    };
  });
}

function groupLayoutsBySystem(layouts: MeasureLayout[]): MeasureLayout[][] {
  const groups: MeasureLayout[][] = [];
  layouts.forEach((layout) => {
    const index = Math.max(0, Math.floor((layout.measure - 1) / MEASURES_PER_LINE));
    if (!groups[index]) {
      groups[index] = [];
    }
    groups[index].push(layout);
  });
  return groups.filter((group): group is MeasureLayout[] => Boolean(group?.length));
}

function svgDimension(svg: SVGSVGElement, attribute: "width" | "height"): number {
  const raw = Number.parseFloat(svg.getAttribute(attribute) ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }

  const parsedViewBox = parseSvgViewBox(svg.getAttribute("viewBox"));
  if (parsedViewBox) {
    return attribute === "width" ? parsedViewBox.width : parsedViewBox.height;
  }

  return 0;
}

function parseSvgViewBox(value: string | null): { height: number; width: number; x: number; y: number } | null {
  if (!value) {
    return null;
  }

  const [x, y, width, height] = value
    .trim()
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part));
  if (![x, y, width, height].every((part) => Number.isFinite(part))) {
    return null;
  }

  return { x, y, width, height };
}

function simplifyVoice(measure: Measure, voice: VoiceNumber): DisplayTick[] {
  if (isEngravedDisplayMeasure(measure)) {
    return voice === 1 ? measure.displayVoice1 : measure.displayVoice2;
  }

  const result: DisplayTick[] = [];

  for (let beatStart = 0; beatStart < SLOTS_PER_MEASURE; beatStart += 4) {
    const slots = [0, 1, 2, 3].map((offset) => beatStart + offset);
    const occupied = slots.filter((slot) => getVoiceEvents(measure.slots[slot], voice).length > 0);

    if (occupied.length === 0) {
      result.push({ slot: beatStart, duration: "q", events: [], hiddenRest: true });
      continue;
    }

    if (occupied.length === 1 && occupied[0] === beatStart) {
      result.push({ slot: beatStart, duration: "q", events: getVoiceEvents(measure.slots[beatStart], voice) });
      continue;
    }

    if (occupied.every((slot) => slot % 2 === 0)) {
      for (const slot of [beatStart, beatStart + 2]) {
        result.push({
          slot,
          duration: "8",
          events: getVoiceEvents(measure.slots[slot], voice),
          hiddenRest: getVoiceEvents(measure.slots[slot], voice).length === 0,
        });
      }
      continue;
    }

    for (const slot of slots) {
      result.push({
        slot,
        duration: "16",
        events: getVoiceEvents(measure.slots[slot], voice),
        hiddenRest: getVoiceEvents(measure.slots[slot], voice).length === 0,
      });
    }
  }

  return result;
}

function makeVoiceNote(tick: DisplayTick, voice: VoiceNumber): StaveNote {
  const renderEvents = renderableEvents(tick.events);
  const keys = renderEvents.length > 0 ? uniqueKeys(renderEvents) : [voice === 1 ? "g/5" : "f/4"];
  const hasOnlyXHeads = renderEvents.length > 0 && renderEvents.every((event) => event.notehead === "x");
  const note = new StaveNote({
    clef: "percussion",
    keys,
    ...(hasOnlyXHeads ? { type: "x" } : {}),
    duration: tick.hiddenRest || renderEvents.length === 0 ? `${tick.duration}r` : tick.duration,
    stem_direction: voice === 1 ? 1 : -1,
  });

  note.setFlagStyle({ fillStyle: "transparent", strokeStyle: "transparent" });

  if (tick.events.some((event) => event.articulation === "accent")) {
    note.addModifier(new Articulation("a>").setPosition(3), 0);
  }

  return note;
}

function renderableEvents(events: NotationEvent[]): NotationEvent[] {
  const hasNormalHead = events.some((event) => event.notehead === "normal");
  if (!hasNormalHead) {
    return events;
  }

  return events.filter((event) => event.notehead === "normal");
}

function prepareStraightBeamStems(notes: StaveNote[], ticks: DisplayTick[], voice: VoiceNumber) {
  for (const group of beatGroups(notes, ticks)) {
    if (!shouldDrawBeam(group.ticks)) {
      continue;
    }

    const visible = visibleGroupItems(group.notes, group.ticks);
    if (visible.length < 2) {
      continue;
    }

    if (voice === 1) {
      const beamY = Math.min(...visible.map(({ note }) => note.getStemExtents().baseY)) - 34;
      for (const { note } of visible) {
        const baseY = note.getStemExtents().baseY;
        note.setStemLength(Math.max(24, baseY - beamY));
      }
    } else {
      const beamY = Math.max(...visible.map(({ note }) => note.getStemExtents().topY)) + 34;
      for (const { note } of visible) {
        const topY = note.getStemExtents().topY;
        note.setStemLength(Math.max(24, beamY - topY));
      }
    }
  }
}

function drawStraightBeams(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  notes: StaveNote[],
  ticks: DisplayTick[],
  voice: VoiceNumber,
) {
  for (const group of beatGroups(notes, ticks)) {
    if (!shouldDrawBeam(group.ticks)) {
      continue;
    }

    const visible = visibleGroupItems(group.notes, group.ticks);
    if (visible.length < 2) {
      continue;
    }

    const first = visible[0].note;
    const last = visible[visible.length - 1].note;
    const firstExtents = first.getStemExtents();
    const lastExtents = last.getStemExtents();
    const x1 = first.getStemX();
    const x2 = last.getStemX();
    const y1 = voice === 1 ? firstExtents.topY : firstExtents.baseY;
    const y2 = voice === 1 ? lastExtents.topY : lastExtents.baseY;
    const beamCount = group.ticks.some((tick) => tick.duration === "16") ? 2 : 1;

    drawBeamBar(context, x1, y1, x2, y2);
    if (beamCount === 2) {
      const offset = voice === 1 ? 8 : -8;
      drawBeamBar(context, x1, y1 + offset, x2, y2 + offset);
    }
  }
}

function beatGroups(notes: StaveNote[], ticks: DisplayTick[]): Array<{ notes: StaveNote[]; ticks: DisplayTick[] }> {
  const groups: Array<{ notes: StaveNote[]; ticks: DisplayTick[] }> = [];
  let groupStart = 0;
  while (groupStart < ticks.length) {
    const beat = Math.floor(ticks[groupStart].slot / 4);
    const groupEnd = ticks.findIndex((tick, index) => index > groupStart && Math.floor(tick.slot / 4) !== beat);
    const end = groupEnd === -1 ? ticks.length : groupEnd;
    groups.push({ notes: notes.slice(groupStart, end), ticks: ticks.slice(groupStart, end) });
    groupStart = end;
  }
  return groups;
}

function visibleGroupItems(notes: StaveNote[], ticks: DisplayTick[]) {
  return notes.map((note, index) => ({ note, tick: ticks[index] })).filter((item) => !item.tick.hiddenRest);
}

function shouldDrawBeam(ticks: DisplayTick[]): boolean {
  const visibleCount = ticks.filter((tick) => !tick.hiddenRest).length;
  const beamable = ticks.some((tick) => tick.duration === "8" || tick.duration === "16");
  return visibleCount >= 2 && beamable;
}

function drawBeamBar(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const thickness = 5;
  context.save();
  context.setFillStyle("#111317");
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.lineTo(x2, y2 + thickness);
  context.lineTo(x1, y1 + thickness);
  context.closePath();
  context.fill();
  context.restore();
}

function drawHiHatStateMarks(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  note: StaveNote,
  tick: DisplayTick,
) {
  const renderEvents = renderableEvents(tick.events);
  const hatEvents = renderEvents.filter((event) => event.drum === "hihat_open" || event.drum === "hihat_closed");
  if (!hatEvents.length) {
    return;
  }

  const keys = uniqueKeys(tick.events);
  const ys = note.getYs();
  const drawn = new Set<string>();
  for (const event of hatEvents) {
    if (drawn.has(event.staff_key)) {
      continue;
    }

    const keyIndex = Math.max(0, keys.indexOf(event.staff_key));
    const y = ys[keyIndex] ?? ys[0] ?? 0;
    const mark = event.articulation === "open" ? "o" : "+";
    context.save();
    context.setFont("Arial", 11);
    context.fillText(mark, note.getAbsoluteX() - 4, y - 10);
    context.restore();
    drawn.add(event.staff_key);
  }
}

function drawGhostSnareMarks(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  note: StaveNote,
  tick: DisplayTick,
) {
  const renderEvents = renderableEvents(tick.events);
  const ghostSnare = renderEvents.find((event) => event.drum === "snare" && event.articulation === "ghost");
  if (!ghostSnare) {
    return;
  }

  const keys = uniqueKeys(renderEvents);
  const keyIndex = Math.max(0, keys.indexOf(ghostSnare.staff_key));
  const y = note.getYs()[keyIndex] ?? note.getYs()[0] ?? 0;
  const x = note.getAbsoluteX();
  context.save();
  context.setFont("Arial, Malgun Gothic, sans-serif", 13);
  context.fillText("(", x - 12, y + 4);
  context.fillText(")", x + 8, y + 4);
  context.restore();
}

function drawLyricLane(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  stave: Stave,
  measure: Measure,
) {
  context.save();
  context.setFont("Arial, Malgun Gothic, sans-serif", LYRIC_FONT_SIZE);
  let lastRight = Number.NEGATIVE_INFINITY;
  const lyricY = stave.getYForLine(6) + 28;
  measure.slots.forEach((slot, slotIndex) => {
    const lyrics = slot.lyrics.length
      ? slot.lyrics
      : slot.lyric?.trim()
        ? [{ lyric: slot.lyric, row: 0 }]
        : [];
    for (const slotLyric of lyrics) {
      const lyric = slotLyric.lyric.trim().normalize("NFC");
      if (!lyric) {
        continue;
      }

      const x = slotToX(stave, slotIndex);
      const width = lyricVisualWidth(lyric);
      const desiredLeft = x - width / 2;
      const left = Math.max(desiredLeft, lastRight + LYRIC_HORIZONTAL_PADDING_PX);
      const right = left + width;

      context.fillText(lyric, left, lyricY);
      lastRight = right;
    }
  });
  context.restore();
}

function lyricVisualWidth(text: string): number {
  return Array.from(text).reduce((width, char) => {
    if (isHangulSyllable(char)) {
      return width + LYRIC_FONT_SIZE;
    }
    return width + 7;
  }, 0);
}

function isHangulSyllable(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3;
}

function slotToX(stave: Stave, slot: number): number {
  const startX = stave.getNoteStartX();
  const endX = stave.getNoteEndX();
  return startX + ((slot + 0.5) / SLOTS_PER_MEASURE) * (endX - startX);
}

function measureLayoutFromStave(stave: Stave, measure: number, showLyrics: boolean): MeasureLayout {
  const slotZero = slotToX(stave, 0);
  const slotOne = slotToX(stave, 1);
  const slotWidth = Math.max(1, slotOne - slotZero);
  const gridStartX = slotZero - slotWidth / 2;
  const gridEndX = gridStartX + slotWidth * SLOTS_PER_MEASURE;
  const top = stave.getYForLine(0) - 46;
  const bottom = showLyrics ? stave.getYForLine(6) + 52 : stave.getYForLine(5) + 24;

  return {
    bottom,
    gridEndX,
    gridStartX,
    measure,
    slotWidth,
    top,
  };
}

function timeToPlaybackPosition(currentTime: number, bpm: number, measureCount: number): PlaybackPosition {
  const beatSeconds = 60 / Math.max(bpm || 120, 1);
  const measureSeconds = beatSeconds * 4;
  const slotSeconds = measureSeconds / SLOTS_PER_MEASURE;
  const maxMeasureIndex = Math.max(0, measureCount - 1);
  const measureIndex = Math.min(maxMeasureIndex, Math.max(0, Math.floor(currentTime / measureSeconds)));
  const measureStart = measureIndex * measureSeconds;
  const slotProgress = clamp((currentTime - measureStart) / slotSeconds, 0, SLOTS_PER_MEASURE);
  const slot = Math.min(SLOTS_PER_MEASURE - 1, Math.max(0, Math.floor(slotProgress)));

  return {
    measure: measureIndex + 1,
    slot,
    slotProgress,
  };
}

function findMeasureLayoutAtPoint(layouts: MeasureLayout[], x: number, y: number): MeasureLayout | null {
  return (
    layouts.find(
      (layout) =>
        y >= layout.top - 28 &&
        y <= layout.bottom + 28 &&
        x >= layout.gridStartX - 36 &&
        x <= layout.gridEndX + 36,
    ) ?? null
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function drawMeasureNumber(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  measureNumber: number,
  x: number,
  y: number,
) {
  context.save();
  context.setFont("Arial", 10);
  context.fillText(String(measureNumber), x + 4, y - 3);
  context.restore();
}

function toMeasures(score: AnalysisResult): Measure[] {
  let measures: Measure[];
  if (score.engraved_measures?.length) {
    measures = measuresFromEngraved(score.engraved_measures);
  } else if (score.midi_ticks?.length) {
    measures = measuresFromMidiTicks(score.midi_ticks);
  } else {
    measures = measuresFromScoreEvents(score.events, score.bpm);
  }

  return hasAnyLyrics(measures) ? measures : applyWordsFallback(measures, score.words, score.bpm);
}

type EngravedDisplayMeasure = Measure & {
  displayVoice1: DisplayTick[];
  displayVoice2: DisplayTick[];
};

function isEngravedDisplayMeasure(measure: Measure): measure is EngravedDisplayMeasure {
  return "displayVoice1" in measure && "displayVoice2" in measure;
}

function hasAnyLyrics(measures: Measure[]): boolean {
  return measures.some((measure) =>
    measure.slots.some((slot) => Boolean(slot.lyric?.trim()) || slot.lyrics.some((lyric) => Boolean(lyric.lyric.trim()))),
  );
}

function measuresFromEngraved(engravedMeasures: EngravedMeasure[]): EngravedDisplayMeasure[] {
  return engravedMeasures.map((measure) => {
    const slots = emptySlots();
    const hasLyricSlots = (measure.lyric_slots?.length ?? 0) > 0;
    if (!hasLyricSlots) {
      for (const apiSlot of measure.slots ?? []) {
        const slot = slots[Math.min(SLOTS_PER_MEASURE - 1, Math.max(0, apiSlot.slot))];
        addSlotLyric(slot, apiSlot.lyric ?? null, 0);
      }
    }
    for (const lyricSlot of measure.lyric_slots ?? []) {
      const slot = slots[Math.min(SLOTS_PER_MEASURE - 1, Math.max(0, lyricSlot.slot))];
      addSlotLyric(slot, lyricSlot.lyric, lyricSlot.row ?? 0);
    }
    const displayVoice1 = measure.voice1.map((tick) => engravedTickToDisplayTick(tick, slots));
    const displayVoice2 = measure.voice2.map((tick) => engravedTickToDisplayTick(tick, slots));
    return { slots, displayVoice1, displayVoice2 };
  });
}

function engravedTickToDisplayTick(
  tick: EngravedMeasure["voice1"][number],
  slots: MeasureSlot[],
): DisplayTick {
  const events = tick.events.map((event) => ({
    drum: event.drum,
    staff_key: event.staff_key,
    voice: tick.voice,
    notehead: event.notehead,
    articulation: event.articulation,
    lyric: event.lyric,
    confidence: event.confidence,
  }));

  const slot = slots[Math.min(SLOTS_PER_MEASURE - 1, Math.max(0, tick.slot))];
  if (tick.voice === 1) {
    slot.voice1 = dedupeNotationEvents([...slot.voice1, ...events]);
  } else {
    slot.voice2 = dedupeNotationEvents([...slot.voice2, ...events]);
  }
  addSlotLyric(slot, tick.lyric ?? events.find((event) => event.lyric)?.lyric ?? null, 0);

  return {
    slot: tick.slot,
    duration: tick.duration,
    events,
    hiddenRest: tick.rest,
  };
}

function measuresFromMidiTicks(ticks: MidiTickEvent[]): Measure[] {
  const grouped = new Map<number, MidiTickEvent[]>();
  for (const event of ticks) {
    const measureIndex = Math.max(0, event.measure - 1);
    const events = grouped.get(measureIndex) ?? [];
    events.push(event);
    grouped.set(measureIndex, events);
  }

  const measureCount = Math.max(1, Math.max(...grouped.keys(), 0) + 1);
  return Array.from({ length: measureCount }, (_, measureIndex) => {
    const slots = emptySlots();
    for (const tick of grouped.get(measureIndex) ?? []) {
      const slotIndex = Math.min(SLOTS_PER_MEASURE - 1, Math.max(0, tick.slot));
      const slot = slots[slotIndex];
      const event: NotationEvent = {
        drum: tick.drum,
        staff_key: tick.staff_key,
        voice: tick.voice,
        notehead: tick.notehead,
        articulation: tick.articulation,
        lyric: tick.lyric,
        confidence: tick.confidence,
      };
      addNotationEvent(slot, event);
      addSlotLyric(slot, tick.lyric ?? null, 0);
    }
    return { slots };
  });
}

function measuresFromScoreEvents(events: ScoreEvent[], bpm: number): Measure[] {
  const beatSeconds = 60 / Math.max(bpm || 120, 1);
  const measureSeconds = beatSeconds * 4;
  const grouped = new Map<number, ScoreEvent[]>();

  for (const event of [...events].sort((a, b) => a.time - b.time)) {
    const measureIndex = Math.max(0, Math.floor(event.time / measureSeconds));
    const measureEvents = grouped.get(measureIndex) ?? [];
    measureEvents.push(event);
    grouped.set(measureIndex, measureEvents);
  }

  const measureCount = Math.max(1, Math.max(...grouped.keys(), 0) + 1);
  return Array.from({ length: measureCount }, (_, measureIndex) => {
    const slots = emptySlots();
    for (const event of grouped.get(measureIndex) ?? []) {
      const slotIndex = Math.min(
        SLOTS_PER_MEASURE - 1,
        Math.max(0, Math.round((event.time - measureIndex * measureSeconds) / (beatSeconds / 4))),
      );
      const slot = slots[slotIndex];
      addNotationEvent(slot, scoreEventToNotationEvent(event));
      addSlotLyric(slot, event.lyric ?? null, 0);
    }
    return { slots };
  });
}

function applyWordsFallback(measures: Measure[], words: LyricWord[], bpm: number): Measure[] {
  if (!words?.length) {
    return measures;
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

function firstAvailableLyricSlot(slots: MeasureSlot[], preferredSlot: number): number | null {
  for (let slot = preferredSlot; slot < SLOTS_PER_MEASURE; slot += 1) {
    if (!slots[slot].lyric?.trim() && slots[slot].lyrics.length === 0) {
      return slot;
    }
  }
  return null;
}

function ensureMeasure(measures: Measure[], measureIndex: number): Measure {
  while (measures.length <= measureIndex) {
    measures.push({ slots: emptySlots() });
  }
  return measures[measureIndex];
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

function emptySlots(): MeasureSlot[] {
  return Array.from({ length: SLOTS_PER_MEASURE }, () => ({
    voice1: [],
    voice2: [],
    lyric: null,
    lyrics: [],
  }));
}

function addSlotLyric(slot: MeasureSlot, next: string | null | undefined, row: number) {
  const cleanNext = next?.trim().normalize("NFC");
  if (!cleanNext) {
    return;
  }

  const cleanRow = Math.min(LYRIC_MAX_ROWS - 1, Math.max(0, row));
  slot.lyrics.push({ lyric: cleanNext, row: cleanRow });
  slot.lyrics.sort((a, b) => a.row - b.row);
  slot.lyric = mergeLyric(slot.lyric, cleanNext);
}

function addNotationEvent(slot: MeasureSlot, event: NotationEvent) {
  if (event.voice === 1) {
    slot.voice1 = dedupeNotationEvents([...slot.voice1, event]);
  } else {
    slot.voice2 = dedupeNotationEvents([...slot.voice2, event]);
  }
}

function getVoiceEvents(slot: MeasureSlot, voice: VoiceNumber): NotationEvent[] {
  return voice === 1 ? slot.voice1 : slot.voice2;
}

function uniqueKeys(events: NotationEvent[]): string[] {
  const keys = new Set<string>();
  for (const event of dedupeNotationEvents(events)) {
    keys.add(event.staff_key);
  }
  return Array.from(keys);
}

function dedupeNotationEvents(events: NotationEvent[]): NotationEvent[] {
  const byNote = new Map<DrumNote, NotationEvent>();
  for (const event of events) {
    const current = byNote.get(event.drum);
    if (!current || event.confidence > current.confidence) {
      byNote.set(event.drum, event);
    }
  }

  return Array.from(byNote.values()).sort((a, b) => NOTE_MAP[a.drum].order - NOTE_MAP[b.drum].order);
}

function scoreEventToNotationEvent(event: ScoreEvent): NotationEvent {
  const mapping = NOTE_MAP[event.note];
  return {
    drum: event.note,
    staff_key: mapping.key,
    voice: mapping.voice,
    notehead: mapping.notehead,
    articulation: event.note === "hihat_open" ? "open" : event.note === "hihat_closed" ? "closed" : "none",
    lyric: event.lyric,
    confidence: event.confidence,
  };
}
