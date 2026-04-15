"use client";

import { useEffect, useMemo, useRef } from "react";
import { Articulation, Beam, Formatter, Renderer, Stave, StaveNote, Voice } from "vexflow";
import type { AnalysisResult, DrumNote, MidiTickEvent, ScoreEvent } from "@/lib/types";

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
  tom: { key: "e/5", voice: 2, notehead: "normal", order: 5 },
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

      upperVoice.draw(context, stave);
      lowerVoice.draw(context, stave);

      drawBeams(context, upperNotes, upperTicks);
      drawBeams(context, lowerNotes, lowerTicks);

      upperTicks.forEach((tick, tickIndex) => {
        drawMixedCymbalHeads(context, upperNotes[tickIndex], tick);
        drawOpenHiHatMark(context, upperNotes[tickIndex], tick);
        drawLyricAtTick(context, upperNotes[tickIndex], measure, tick.slot, y);
      });
    });
  }, [measures]);

  return (
    <div className="score-wrap" aria-label="Drum sheet with lyrics">
      <div className="score-canvas" ref={containerRef} />
    </div>
  );
}

function simplifyVoice(measure: Measure, voice: VoiceNumber): DisplayTick[] {
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
  const keys = tick.events.length > 0 ? uniqueKeys(tick.events) : [voice === 1 ? "g/5" : "f/4"];
  const hasOnlyXHeads = tick.events.length > 0 && tick.events.every((event) => event.notehead === "x");
  const hasMixedHeads =
    tick.events.some((event) => event.notehead === "x") && tick.events.some((event) => event.notehead === "normal");
  const note = new StaveNote({
    clef: "percussion",
    keys,
    ...(hasOnlyXHeads ? { type: "x" } : {}),
    duration: tick.hiddenRest ? `${tick.duration}r` : tick.duration,
    stem_direction: voice === 1 ? 1 : -1,
  });

  if (tick.hiddenRest) {
    hideTickable(note);
  }

  if (tick.events.some((event) => event.articulation === "accent")) {
    note.addModifier(new Articulation("a>").setPosition(3), 0);
  }

  if (hasMixedHeads) {
    hideCymbalKeyHeads(note, tick.events, keys);
  }

  return note;
}

function hideCymbalKeyHeads(note: StaveNote, events: NotationEvent[], keys: string[]) {
  const cymbalKeys = new Set(events.filter((event) => event.notehead === "x").map((event) => event.staff_key));
  keys.forEach((key, index) => {
    if (cymbalKeys.has(key)) {
      note.setKeyStyle(index, { fillStyle: "transparent", strokeStyle: "transparent" });
    }
  });
}

function drawBeams(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  notes: StaveNote[],
  ticks: DisplayTick[],
) {
  let groupStart = 0;
  while (groupStart < ticks.length) {
    const beat = Math.floor(ticks[groupStart].slot / 4);
    const groupEnd = ticks.findIndex((tick, index) => index > groupStart && Math.floor(tick.slot / 4) !== beat);
    const end = groupEnd === -1 ? ticks.length : groupEnd;
    const beatTicks = ticks.slice(groupStart, end);
    const beatNotes = notes.slice(groupStart, end);
    const visibleCount = beatTicks.filter((tick) => !tick.hiddenRest).length;
    const beamable = beatTicks.some((tick) => tick.duration === "8" || tick.duration === "16");

    if (visibleCount >= 2 && beamable) {
      try {
        new Beam(beatNotes).setContext(context).draw();
      } catch {
        // Some rest-heavy beat groups are not beamable in VexFlow.
      }
    }

    groupStart = end;
  }
}

function drawOpenHiHatMark(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  note: StaveNote,
  tick: DisplayTick,
) {
  if (!tick.events.some((event) => event.articulation === "open")) {
    return;
  }

  const y = note.getYs()[0] ?? 0;
  context.save();
  context.setFont("Arial", 11);
  context.fillText("o", note.getAbsoluteX() - 4, y - 10);
  context.restore();
}

function drawMixedCymbalHeads(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  note: StaveNote,
  tick: DisplayTick,
) {
  const hasMixedHeads =
    tick.events.some((event) => event.notehead === "x") && tick.events.some((event) => event.notehead === "normal");
  if (!hasMixedHeads) {
    return;
  }

  const keys = uniqueKeys(tick.events);
  const ys = note.getYs();
  const drawn = new Set<string>();
  for (const event of tick.events) {
    if (event.notehead !== "x" || drawn.has(event.staff_key)) {
      continue;
    }

    const keyIndex = Math.max(0, keys.indexOf(event.staff_key));
    const y = ys[keyIndex] ?? ys[0] ?? 0;
    context.save();
    context.setFont("Arial", 15, "bold");
    context.fillText("x", note.getAbsoluteX() - 4, y + 5);
    context.restore();
    drawn.add(event.staff_key);
  }
}

function drawLyricAtTick(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  note: StaveNote,
  measure: Measure,
  slot: number,
  staveY: number,
) {
  const lyric = measure.slots[slot]?.lyric?.trim();
  if (!lyric) {
    return;
  }

  context.save();
  context.setFont("Arial", 13);
  context.fillText(lyric, note.getAbsoluteX() - 10, staveY + 116);
  context.restore();
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

function hideTickable(note: StaveNote) {
  note.setStyle({ fillStyle: "transparent", strokeStyle: "transparent" });
  note.setLedgerLineStyle({ strokeStyle: "transparent" });
}

function toMeasures(score: AnalysisResult): Measure[] {
  if (score.midi_ticks?.length) {
    return measuresFromMidiTicks(score.midi_ticks);
  }

  return measuresFromScoreEvents(score.events, score.bpm);
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
      slot.lyric = slot.lyric ?? tick.lyric ?? null;
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
      slot.lyric = slot.lyric ?? event.lyric ?? null;
    }
    return { slots };
  });
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
    articulation: event.note === "hihat_open" ? "open" : "none",
    lyric: event.lyric,
    confidence: event.confidence,
  };
}
