"use client";

import { useEffect, useMemo, useRef } from "react";
import { Articulation, Formatter, Renderer, Stave, StaveNote, Voice } from "vexflow";
import type { AnalysisResult, DrumNote, EngravedMeasure, LyricWord, MidiTickEvent, ScoreEvent } from "@/lib/types";

type Props = { score: AnalysisResult };
type VoiceNumber = 1 | 2;
type NotationEvent = Pick<
  MidiTickEvent,
  "drum" | "staff_key" | "voice" | "notehead" | "articulation" | "lyric" | "confidence"
>;
type MeasureSlot = {
  voice1: NotationEvent[];
  voice2: NotationEvent[];
  lyric?: string | null;
};
type Measure = { slots: MeasureSlot[] };
type DisplayTick = {
  slot: number;
  duration: "q" | "8" | "16";
  events: NotationEvent[];
  hiddenRest?: boolean;
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
const LINE_HEIGHT = 176;
const SLOTS_PER_MEASURE = 16;

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
    context.setFont("Arial, Malgun Gothic, sans-serif", 12);

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
      drawLyricLane(context, stave, measure, upperNotes, upperTicks, y);
    });
  }, [measures]);

  return (
    <div className="score-wrap" aria-label="Drum sheet with lyrics">
      <div className="score-canvas" ref={containerRef} />
    </div>
  );
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
  notes: StaveNote[],
  ticks: DisplayTick[],
  staveY: number,
) {
  const noteXBySlot = new Map<number, number>();
  ticks.forEach((tick, index) => {
    noteXBySlot.set(tick.slot, notes[index].getAbsoluteX());
  });

  context.save();
  context.setFont("Arial", 13);
  measure.slots.forEach((slot, slotIndex) => {
    const lyric = slot.lyric?.trim();
    if (!lyric) {
      return;
    }

    const x = noteXBySlot.get(slotIndex) ?? slotToX(stave, slotIndex);
    context.fillText(lyric, x - 10, staveY + 126);
  });
  context.restore();
}

function slotToX(stave: Stave, slot: number): number {
  const startX = stave.getNoteStartX();
  const endX = stave.getNoteEndX();
  return startX + (slot / SLOTS_PER_MEASURE) * (endX - startX);
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

  return applyWordsFallback(measures, score.words, score.bpm);
}

type EngravedDisplayMeasure = Measure & {
  displayVoice1: DisplayTick[];
  displayVoice2: DisplayTick[];
};

function isEngravedDisplayMeasure(measure: Measure): measure is EngravedDisplayMeasure {
  return "displayVoice1" in measure && "displayVoice2" in measure;
}

function measuresFromEngraved(engravedMeasures: EngravedMeasure[]): EngravedDisplayMeasure[] {
  return engravedMeasures.map((measure) => {
    const slots = emptySlots();
    for (const apiSlot of measure.slots ?? []) {
      const slot = slots[Math.min(SLOTS_PER_MEASURE - 1, Math.max(0, apiSlot.slot))];
      slot.lyric = mergeLyric(slot.lyric, apiSlot.lyric ?? null);
    }
    for (const lyricSlot of measure.lyric_slots ?? []) {
      const slot = slots[Math.min(SLOTS_PER_MEASURE - 1, Math.max(0, lyricSlot.slot))];
      slot.lyric = mergeLyric(slot.lyric, lyricSlot.lyric);
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
  slot.lyric = mergeLyric(slot.lyric, tick.lyric ?? events.find((event) => event.lyric)?.lyric ?? null);

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
      slot.lyric = mergeLyric(slot.lyric, tick.lyric ?? null);
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
      slot.lyric = mergeLyric(slot.lyric, event.lyric ?? null);
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
    measure.slots[slotIndex].lyric = mergeLyric(measure.slots[slotIndex].lyric, word.word);
  }

  return measures;
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
  }));
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
