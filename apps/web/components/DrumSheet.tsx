"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Articulation, Formatter, Renderer, Stave, StaveNote, Voice } from "vexflow";
import type { AnalysisResult, DrumNote, EngravedMeasure, LyricWord, MidiTickEvent, ScoreEvent } from "@/lib/types";

type Props = {
  audioCurrentTime?: number;
  followPlayback?: boolean;
  isPlaying?: boolean;
  onFollowPlaybackChange?: (enabled: boolean) => void;
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
type InstrumentLayer = "CYMBAL" | "DRUM";
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
  pageIndex: number;
  slotWidth: number;
  top: number;
};
type PageDescriptor = {
  measureEnd: number;
  measureStart: number;
  measures: Measure[];
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

const PAGE_HEIGHT_PX = 1123;
const PAGE_PADDING_X = 24;
const PAGE_PADDING_Y = 34;
const PAGE_WIDTH_PX = 794;
const LINE_HEIGHT_WITH_LYRICS = 178;
const LINE_HEIGHT_WITHOUT_LYRICS = 142;
const SLOTS_PER_MEASURE = 16;
const MIN_SLOT_WIDTH_PX = 40;
const FIRST_MEASURE_RESERVE_PX = 76;
const REGULAR_MEASURE_RESERVE_PX = 24;
const LYRIC_FONT_SIZE = 12;
const LYRIC_HORIZONTAL_PADDING_PX = 5;
const LYRIC_MAX_ROWS = 2;
const AUTO_SCROLL_GUARD_MS = 1000;
const BEAM_THICKNESS_PX = 4;
const BEAM_SECONDARY_GAP_PX = 6;
const MIN_BEAMED_STEM_LENGTH_PX = 28;
const CYMBAL_BEAM_CLEARANCE_PX = 34;
const DRUM_BEAM_CLEARANCE_PX = 26;
const MIXED_HEAD_X_OFFSET_PX = 10;

export const DrumSheet = forwardRef<DrumSheetHandle, Props>(function DrumSheet(
  { audioCurrentTime = 0, followPlayback = true, isPlaying = false, onFollowPlaybackChange, onSeek, score, showLyrics = true }: Props,
  ref,
) {
  const boardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const cursorRefs = useRef<Array<HTMLDivElement | null>>([]);
  const followTargetRefs = useRef<Array<HTMLDivElement | null>>([]);
  const lyricHighlightRefs = useRef<Array<HTMLDivElement | null>>([]);
  const measureHighlightRefs = useRef<Array<HTMLDivElement | null>>([]);
  const overlayLayerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const slotHighlightRefs = useRef<Array<HTMLDivElement | null>>([]);
  const svgLayerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const autoScrollGuardUntilRef = useRef(0);
  const followPlaybackRef = useRef(followPlayback);
  const isPlayingRef = useRef(isPlaying);
  const forceCenterNextAlignRef = useRef(false);
  const lastFollowTargetKeyRef = useRef<string | null>(null);
  const previousFollowPlaybackRef = useRef(followPlayback);
  const [measureLayouts, setMeasureLayouts] = useState<MeasureLayout[]>([]);
  const [pageTranslateX, setPageTranslateX] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [visiblePageIndex, setVisiblePageIndex] = useState(0);
  const measures = useMemo(() => toMeasures(score), [score]);
  const lineHeight = showLyrics ? LINE_HEIGHT_WITH_LYRICS : LINE_HEIGHT_WITHOUT_LYRICS;
  const pagination = useMemo(() => paginateMeasures(measures, score.bpm, showLyrics), [measures, score.bpm, showLyrics]);
  const pages = pagination.pages;
  const measuresPerLine = pagination.measuresPerLine;
  const measuresPerPage = pagination.measuresPerPage;
  const measureWidth = pagination.measureWidth;
  const playbackPosition = useMemo(
    () => timeToPlaybackPosition(audioCurrentTime, score.bpm, measures.length),
    [audioCurrentTime, measures.length, score.bpm],
  );
  const activeLayout = measureLayouts[playbackPosition.measure - 1] ?? null;
  const targetPageIndex = useMemo(
    () =>
      pages.length > 0
        ? clamp(Math.floor(Math.max(0, playbackPosition.measure - 1) / Math.max(1, measuresPerPage)), 0, pages.length - 1)
        : 0,
    [measuresPerPage, pages.length, playbackPosition.measure],
  );

  useEffect(() => {
    followPlaybackRef.current = followPlayback;
  }, [followPlayback]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const disableFollowPlayback = useCallback(
    (ignoreGuard: boolean) => {
      if (!followPlaybackRef.current || !isPlayingRef.current) {
        return;
      }
      if (!ignoreGuard && performance.now() <= autoScrollGuardUntilRef.current) {
        return;
      }
      onFollowPlaybackChange?.(false);
    },
    [onFollowPlaybackChange],
  );

  useImperativeHandle(
    ref,
    () => ({
      getPrintableSystems: () => collectPrintableSystems(svgLayerRefs.current, pages),
    }),
    [pages],
  );

  useEffect(() => {
    const nextLayouts: MeasureLayout[] = [];
    try {
      pages.forEach((page, pageIndex) => {
        const container = svgLayerRefs.current[pageIndex];
        if (!container) {
          return;
        }

        container.innerHTML = "";

        const renderer = new Renderer(container, Renderer.Backends.SVG);
        renderer.resize(PAGE_WIDTH_PX, PAGE_HEIGHT_PX);

        const context = renderer.getContext();
        context.setFont("Arial, Malgun Gothic, sans-serif", 12);

        page.measures.forEach((measure, localIndex) => {
          const globalIndex = page.measureStart - 1 + localIndex;
          const column = localIndex % measuresPerLine;
          const row = Math.floor(localIndex / measuresPerLine);
          const x = PAGE_PADDING_X + column * measureWidth;
          const y = PAGE_PADDING_Y + row * lineHeight;
          const staveWidth = measureWidth;

          const stave = new Stave(x, y, staveWidth);
          if (localIndex === 0) {
            stave.addClef("percussion").addTimeSignature("4/4");
          }
          stave.setContext(context).draw();
          drawMeasureNumber(context, globalIndex + 1, x, y);

          const upperTicks = simplifyVoice(measure, 1);
          const lowerTicks = simplifyVoice(measure, 2);
          const upperNotes = upperTicks.map((tick) => makeVoiceNote(tick, 1));
          const lowerNotes = lowerTicks.map((tick) => makeVoiceNote(tick, 2));
          const upperVoice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(true);
          const lowerVoice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(true);

          upperVoice.addTickables(upperNotes);
          lowerVoice.addTickables(lowerNotes);

          const formatterWidth = staveWidth - (localIndex === 0 ? FIRST_MEASURE_RESERVE_PX : REGULAR_MEASURE_RESERVE_PX);
          new Formatter().joinVoices([upperVoice, lowerVoice]).format([upperVoice, lowerVoice], formatterWidth);

          configureVoiceFlags(upperNotes, upperTicks, 1);
          configureVoiceFlags(lowerNotes, lowerTicks, 2);
          prepareStraightBeamStems(upperNotes, upperTicks, 1);

          upperVoice.draw(context, stave);
          lowerVoice.draw(context, stave);

          drawStraightBeams(context, upperNotes, upperTicks, 1);
          drawCustomXNoteheads(context, upperNotes, upperTicks);

          upperTicks.forEach((tick, tickIndex) => {
            drawHiHatStateMarks(context, upperNotes[tickIndex], tick);
            drawGhostSnareMarks(context, upperNotes[tickIndex], tick);
          });
          if (showLyrics) {
            drawLyricLane(context, stave, measure);
          }
          nextLayouts[globalIndex] = measureLayoutFromStave(stave, globalIndex + 1, pageIndex, showLyrics);
        });
      });

      setRenderError(null);
      setMeasureLayouts(nextLayouts);
    } catch (error) {
      console.error("DrumSheet render failed", error);
      svgLayerRefs.current.forEach((container) => {
        if (container) {
          container.innerHTML = "";
        }
      });
      setMeasureLayouts([]);
      setRenderError(error instanceof Error ? error.message : "Drum sheet rendering failed.");
    }
  }, [lineHeight, measureWidth, measuresPerLine, pages, showLyrics]);

  useEffect(() => {
    if (renderError) {
      return;
    }

    let frame = 0;
    frame = requestAnimationFrame(() => {
      const activePageIndex = activeLayout?.pageIndex ?? -1;

      overlayLayerRefs.current.forEach((overlayLayer, pageIndex) => {
        if (overlayLayer) {
          overlayLayer.style.opacity = pageIndex === activePageIndex ? "1" : "0";
        }
      });

      const followTarget = activePageIndex >= 0 ? followTargetRefs.current[activePageIndex] : null;
      const measureHighlight = activePageIndex >= 0 ? measureHighlightRefs.current[activePageIndex] : null;
      const overlayLayer = activePageIndex >= 0 ? overlayLayerRefs.current[activePageIndex] : null;
      const slotHighlight = activePageIndex >= 0 ? slotHighlightRefs.current[activePageIndex] : null;
      const cursor = activePageIndex >= 0 ? cursorRefs.current[activePageIndex] : null;
      const lyricHighlight = activePageIndex >= 0 ? lyricHighlightRefs.current[activePageIndex] : null;
      const board = activePageIndex >= 0 ? boardRefs.current[activePageIndex] : null;
      const layout = measureLayouts[playbackPosition.measure - 1] ?? null;
      const measure = measures[playbackPosition.measure - 1] ?? null;
      const slot = measure?.slots[playbackPosition.slot] ?? null;
      const lyric = showLyrics
        ? (slot?.lyrics[0]?.lyric?.trim().normalize("NFC") ?? slot?.lyric?.trim().normalize("NFC") ?? null)
        : null;

      if (!followTarget || !measureHighlight || !overlayLayer || !slotHighlight || !cursor || !lyricHighlight || !board) {
        return;
      }

      if (!layout) {
        overlayLayer.style.opacity = "0";
        measureHighlight.style.opacity = "0";
        lyricHighlight.style.opacity = "0";
        return;
      }

      const cursorX =
        layout.gridStartX + (playbackPosition.slotProgress / SLOTS_PER_MEASURE) * (layout.gridEndX - layout.gridStartX);
      const activeSlotLeft = layout.gridStartX + playbackPosition.slot * layout.slotWidth;
      const activeMeasureWidth = layout.gridEndX - layout.gridStartX;
      const activeSlotHeight = layout.bottom - layout.top;
      const activeMeasureCenterY = (layout.top + layout.bottom) / 2;
      const boardRect = board.getBoundingClientRect();
      const scaleX = boardRect.width / PAGE_WIDTH_PX;
      const scaleY = boardRect.height / PAGE_HEIGHT_PX;

      overlayLayer.style.opacity = "1";
      measureHighlight.style.opacity = "1";
      measureHighlight.style.height = `${activeSlotHeight * scaleY}px`;
      measureHighlight.style.width = `${activeMeasureWidth * scaleX}px`;
      measureHighlight.style.transform = `translate(${layout.gridStartX * scaleX}px, ${layout.top * scaleY}px)`;

      slotHighlight.style.height = `${activeSlotHeight * scaleY}px`;
      slotHighlight.style.width = `${layout.slotWidth * scaleX}px`;
      slotHighlight.style.transform = `translate(${activeSlotLeft * scaleX}px, ${layout.top * scaleY}px)`;

      cursor.style.height = `${activeSlotHeight * scaleY}px`;
      cursor.style.transform = `translate(${cursorX * scaleX}px, ${layout.top * scaleY}px)`;

      followTarget.style.top = `${activeMeasureCenterY * scaleY}px`;

      if (lyric) {
        lyricHighlight.textContent = lyric;
        lyricHighlight.style.opacity = "1";
        lyricHighlight.style.transform = `translate(${cursorX * scaleX}px, ${(layout.bottom - 28) * scaleY}px)`;
      } else {
        lyricHighlight.textContent = "";
        lyricHighlight.style.opacity = "0";
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [activeLayout, measureLayouts, measures, playbackPosition, renderError, showLyrics]);

  useEffect(() => {
    const handleWindowScroll = () => disableFollowPlayback(false);
    const handleUserScrollIntent = () => disableFollowPlayback(true);
    window.addEventListener("scroll", handleWindowScroll, { passive: true });
    window.addEventListener("wheel", handleUserScrollIntent, { passive: true });
    window.addEventListener("touchmove", handleUserScrollIntent, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleWindowScroll);
      window.removeEventListener("wheel", handleUserScrollIntent);
      window.removeEventListener("touchmove", handleUserScrollIntent);
    };
  }, [disableFollowPlayback]);

  useEffect(() => {
    setVisiblePageIndex((current) => Math.min(current, Math.max(0, pages.length - 1)));
    boardRefs.current = boardRefs.current.slice(0, pages.length);
    cursorRefs.current = cursorRefs.current.slice(0, pages.length);
    followTargetRefs.current = followTargetRefs.current.slice(0, pages.length);
    lyricHighlightRefs.current = lyricHighlightRefs.current.slice(0, pages.length);
    measureHighlightRefs.current = measureHighlightRefs.current.slice(0, pages.length);
    overlayLayerRefs.current = overlayLayerRefs.current.slice(0, pages.length);
    pageRefs.current = pageRefs.current.slice(0, pages.length);
    slotHighlightRefs.current = slotHighlightRefs.current.slice(0, pages.length);
    svgLayerRefs.current = svgLayerRefs.current.slice(0, pages.length);
  }, [pages.length]);

  const getPageScrollLeft = useCallback((pageIndex: number) => {
    const viewport = viewportRef.current;
    const firstPage = pageRefs.current[0];
    const targetPage = pageRefs.current[pageIndex];
    if (!viewport || !targetPage) {
      return 0;
    }
    if (pageIndex <= 0 || !firstPage) {
      return 0;
    }

    const secondPage = pageRefs.current[1];
    const pageStride =
      secondPage && firstPage ? secondPage.offsetLeft - firstPage.offsetLeft : firstPage.offsetWidth;
    return Math.max(0, pageStride * pageIndex);
  }, []);

  const scrollToPage = useCallback((pageIndex: number, behavior: ScrollBehavior = "smooth") => {
    if (!pageRefs.current[pageIndex]) {
      return;
    }

    autoScrollGuardUntilRef.current = performance.now() + AUTO_SCROLL_GUARD_MS;
    setVisiblePageIndex((current) => (current === pageIndex ? current : pageIndex));
    if (behavior === "auto") {
      const targetLeft = getPageScrollLeft(pageIndex);
      setPageTranslateX((current) => (Math.abs(current - targetLeft) < 1 ? current : targetLeft));
    }
  }, [getPageScrollLeft]);

  useEffect(() => {
    if (pages.length === 0) {
      setPageTranslateX(0);
      return;
    }

    let frame = 0;
    const syncPageTranslate = () => {
      const targetLeft = getPageScrollLeft(visiblePageIndex);
      setPageTranslateX((current) => (Math.abs(current - targetLeft) < 1 ? current : targetLeft));
    };

    frame = requestAnimationFrame(syncPageTranslate);
    window.addEventListener("resize", syncPageTranslate);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", syncPageTranslate);
    };
  }, [getPageScrollLeft, pages.length, visiblePageIndex]);

  const alignViewportToPlayback = useCallback(
    (pageIndex: number, layout: MeasureLayout, behavior: ScrollBehavior, forceCenter: boolean) => {
      const viewport = viewportRef.current;
      const board = boardRefs.current[pageIndex];
      if (!viewport || !board) {
        return;
      }

      const targetLeft = getPageScrollLeft(pageIndex);
      const scaleY = board.clientHeight / PAGE_HEIGHT_PX;
      const lineCenterY = ((layout.top + layout.bottom) / 2) * scaleY;
      const boardRect = board.getBoundingClientRect();
      const cursorDocumentY = boardRect.top + window.scrollY + lineCenterY;
      const deadZoneTop = window.innerHeight * 0.2;
      const deadZoneBottom = window.innerHeight * 0.8;
      const cursorViewportY = cursorDocumentY - window.scrollY;
      const needsHorizontal = pageIndex !== visiblePageIndex || Math.abs(pageTranslateX - targetLeft) > 2;

      let targetTop = window.scrollY;
      let needsVertical = false;

      if (forceCenter) {
        targetTop = Math.max(0, cursorDocumentY - window.innerHeight / 2);
        needsVertical = Math.abs(targetTop - window.scrollY) > 2;
      } else if (cursorViewportY < deadZoneTop) {
        targetTop = Math.max(0, cursorDocumentY - deadZoneTop);
        needsVertical = true;
      } else if (cursorViewportY > deadZoneBottom) {
        targetTop = Math.max(0, cursorDocumentY - deadZoneBottom);
        needsVertical = true;
      }

      if (!needsHorizontal && !needsVertical) {
        return;
      }

      autoScrollGuardUntilRef.current = performance.now() + AUTO_SCROLL_GUARD_MS;
      if (needsHorizontal) {
        scrollToPage(pageIndex, behavior);
      }
      if (needsVertical) {
        window.scrollTo({ top: targetTop, behavior });
      }
      setVisiblePageIndex((current) => (current === pageIndex ? current : pageIndex));
    },
    [getPageScrollLeft, pageTranslateX, scrollToPage, visiblePageIndex],
  );

  useEffect(() => {
    const followWasEnabled = previousFollowPlaybackRef.current;
    previousFollowPlaybackRef.current = followPlayback;

    if (!followPlayback || pages.length === 0 || !activeLayout) {
      if (!followPlayback) {
        forceCenterNextAlignRef.current = false;
        lastFollowTargetKeyRef.current = null;
      }
      return;
    }

    const followKey = `${activeLayout.pageIndex}:${activeLayout.top}`;
    const followJustEnabled = !followWasEnabled && followPlayback;
    const pageMismatch = visiblePageIndex !== targetPageIndex;
    const lineMismatch = lastFollowTargetKeyRef.current !== followKey;
    if (followJustEnabled || pageMismatch) {
      forceCenterNextAlignRef.current = true;
    }
    if (pageMismatch) {
      scrollToPage(targetPageIndex, followJustEnabled ? "auto" : "smooth");
      return;
    }

    if (!followJustEnabled && !lineMismatch && !forceCenterNextAlignRef.current) {
      return;
    }

    lastFollowTargetKeyRef.current = followKey;
    const forceCenter = forceCenterNextAlignRef.current;
    forceCenterNextAlignRef.current = false;
    const behavior: ScrollBehavior = followJustEnabled ? "auto" : "smooth";

    let frame = 0;
    frame = requestAnimationFrame(() => {
      alignViewportToPlayback(targetPageIndex, activeLayout, behavior, forceCenter);
    });

    return () => cancelAnimationFrame(frame);
  }, [activeLayout, alignViewportToPlayback, followPlayback, pages.length, scrollToPage, targetPageIndex, visiblePageIndex]);

  function handlePageNavigation(direction: -1 | 1) {
    const nextPageIndex = clamp(visiblePageIndex + direction, 0, Math.max(0, pages.length - 1));
    if (nextPageIndex === visiblePageIndex) {
      return;
    }

    disableFollowPlayback(true);
    scrollToPage(nextPageIndex);
  }

  function handleBoardClick(pageIndex: number, event: React.MouseEvent<HTMLDivElement>) {
    if (renderError) {
      return;
    }

    const board = boardRefs.current[pageIndex];
    if (!onSeek || !board) {
      return;
    }

    const rect = board.getBoundingClientRect();
    const scaleX = PAGE_WIDTH_PX / rect.width;
    const scaleY = PAGE_HEIGHT_PX / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    const layout = findMeasureLayoutAtPoint(
      measureLayouts.filter((entry) => entry.pageIndex === pageIndex),
      x,
      y,
    );
    if (!layout) {
      return;
    }

    const beatSeconds = 60 / Math.max(score.bpm || 120, 1);
    const measureSeconds = beatSeconds * 4;
    const fraction = clamp((x - layout.gridStartX) / (layout.gridEndX - layout.gridStartX), 0, 1);
    onSeek((layout.measure - 1) * measureSeconds + fraction * measureSeconds);
  }

  return (
    <div className="score-wrap" aria-label="Drum sheet with synchronized playback">
      {renderError ? <div className="error">Score rendering failed: {renderError}</div> : null}
      <div className="score-book-shell">
        <button
          aria-label="Previous page"
          className="score-page-nav"
          disabled={visiblePageIndex <= 0}
          onClick={() => handlePageNavigation(-1)}
          type="button"
        >
          Prev
        </button>
        <div className="score-book-viewport" ref={viewportRef}>
          <div className="score-page-strip" style={{ transform: `translate3d(-${pageTranslateX}px, 0, 0)` }}>
            {pages.map((page, pageIndex) => (
              <div
                className="score-page-shell"
                key={`page-${page.measureStart}-${page.measureEnd}`}
                ref={(node) => {
                  pageRefs.current[pageIndex] = node;
                }}
              >
                <div className="score-page-sheet">
                  <div
                    className={onSeek ? "score-board seekable score-page-board" : "score-board score-page-board"}
                    onClick={(event) => handleBoardClick(pageIndex, event)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (onSeek) {
                          const beatSeconds = 60 / Math.max(score.bpm || 120, 1);
                          onSeek((page.measureStart - 1) * beatSeconds * 4);
                        }
                      }
                    }}
                    ref={(node) => {
                      boardRefs.current[pageIndex] = node;
                    }}
                    role={onSeek ? "button" : undefined}
                    tabIndex={onSeek ? 0 : undefined}
                  >
                    <div
                      className="score-svg-layer"
                      ref={(node) => {
                        svgLayerRefs.current[pageIndex] = node;
                      }}
                    />
                    <div
                      className="score-overlay-layer"
                      aria-hidden="true"
                      ref={(node) => {
                        overlayLayerRefs.current[pageIndex] = node;
                      }}
                    >
                      <div
                        className="playback-follow-target"
                        ref={(node) => {
                          followTargetRefs.current[pageIndex] = node;
                        }}
                      />
                      <div
                        className="playback-measure-highlight"
                        ref={(node) => {
                          measureHighlightRefs.current[pageIndex] = node;
                        }}
                      />
                      <div
                        className="playback-slot-highlight"
                        ref={(node) => {
                          slotHighlightRefs.current[pageIndex] = node;
                        }}
                      />
                      <div
                        className="playback-cursor"
                        ref={(node) => {
                          cursorRefs.current[pageIndex] = node;
                        }}
                      />
                      <div
                        className="playback-lyric-highlight"
                        ref={(node) => {
                          lyricHighlightRefs.current[pageIndex] = node;
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <button
          aria-label="Next page"
          className="score-page-nav"
          disabled={visiblePageIndex >= Math.max(0, pages.length - 1)}
          onClick={() => handlePageNavigation(1)}
          type="button"
        >
          Next
        </button>
      </div>
      {pages.length > 0 ? (
        <div className="score-page-indicator">
          Page {visiblePageIndex + 1} / {pages.length}
        </div>
      ) : null}
    </div>
  );
});

function collectPrintableSystems(
  containers: Array<HTMLDivElement | null>,
  pages: PageDescriptor[],
): PrintableScoreSystem[] {
  return pages.flatMap((page, pageIndex) => {
    const sourceSvg = containers[pageIndex]?.querySelector("svg");
    if (!sourceSvg) {
      return [];
    }

    return [
      {
        height: PAGE_HEIGHT_PX,
        measureEnd: page.measureEnd,
        measureStart: page.measureStart,
        svgMarkup: sourceSvg.outerHTML,
        width: PAGE_WIDTH_PX,
      },
    ];
  });
}

function paginateMeasures(
  measures: Measure[],
  bpm: number,
  showLyrics: boolean,
): { measureWidth: number; measuresPerLine: number; measuresPerPage: number; pages: PageDescriptor[] } {
  const measuresPerLine = chooseMeasuresPerLine(measures, bpm);
  const lineHeight = showLyrics ? LINE_HEIGHT_WITH_LYRICS : LINE_HEIGHT_WITHOUT_LYRICS;
  const innerHeight = PAGE_HEIGHT_PX - PAGE_PADDING_Y * 2;
  const linesPerPage = Math.max(1, Math.floor(innerHeight / lineHeight));
  const measuresPerPage = Math.max(1, measuresPerLine * linesPerPage);
  const minimumMeasureWidth = SLOTS_PER_MEASURE * MIN_SLOT_WIDTH_PX + REGULAR_MEASURE_RESERVE_PX;
  const innerWidth = PAGE_WIDTH_PX - PAGE_PADDING_X * 2;
  const measureWidth = Math.max(minimumMeasureWidth, innerWidth / measuresPerLine);
  const pages: PageDescriptor[] = [];

  for (let startIndex = 0; startIndex < measures.length; startIndex += measuresPerPage) {
    const endIndex = Math.min(measures.length, startIndex + measuresPerPage);
    pages.push({
      measureEnd: endIndex,
      measureStart: startIndex + 1,
      measures: measures.slice(startIndex, endIndex),
    });
  }

  if (pages.length === 0) {
    pages.push({
      measureEnd: 1,
      measureStart: 1,
      measures: [{ slots: emptySlots() }],
    });
  }

  return { measureWidth, measuresPerLine, measuresPerPage, pages };
}

function chooseMeasuresPerLine(measures: Measure[], bpm: number): number {
  const innerWidth = PAGE_WIDTH_PX - PAGE_PADDING_X * 2;
  const strictMinimumMeasureWidth = SLOTS_PER_MEASURE * MIN_SLOT_WIDTH_PX + FIRST_MEASURE_RESERVE_PX;
  if (innerWidth < strictMinimumMeasureWidth * 2) {
    return 1;
  }

  if (measures.length <= 2) {
    return Math.max(1, Math.min(measures.length, Math.floor(innerWidth / strictMinimumMeasureWidth)));
  }

  const averageEventDensity =
    measures.reduce(
      (total, measure) =>
        total +
        measure.slots.reduce((slotTotal, slot) => slotTotal + slot.voice1.length + slot.voice2.length + slot.lyrics.length, 0),
      0,
    ) / Math.max(measures.length, 1);
  const preferredMeasuresPerLine = bpm >= 150 || averageEventDensity >= 18 ? 1 : 1;

  return Math.max(1, Math.min(preferredMeasuresPerLine, Math.floor(innerWidth / strictMinimumMeasureWidth)));
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
  const keys = tick.events.length > 0 ? uniqueKeys(tick.events) : [voice === 1 ? "g/5" : "f/4"];
  const note = new StaveNote({
    clef: "percussion",
    keys,
    duration: tick.hiddenRest || tick.events.length === 0 ? `${tick.duration}r` : tick.duration,
    stem_direction: voice === 1 ? 1 : -1,
  });

  if (voice === 2) {
    note.setFlagStyle({ fillStyle: "transparent", strokeStyle: "transparent" });
  }
  keys.forEach((key, index) => {
    if (tick.events.some((event) => event.staff_key === key && event.notehead === "x")) {
      note.setKeyStyle(index, { fillStyle: "transparent", strokeStyle: "transparent" });
    }
  });

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

function drawCustomXNoteheads(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  notes: StaveNote[],
  ticks: DisplayTick[],
) {
  notes.forEach((note, noteIndex) => {
    const tick = ticks[noteIndex];
    if (!tick || tick.hiddenRest) {
      return;
    }

    const keys = uniqueKeys(tick.events);
    const ys = note.getYs();
    tick.events.forEach((event) => {
      if (event.notehead !== "x") {
        return;
      }

      const keyIndex = keys.indexOf(event.staff_key);
      const y = ys[keyIndex] ?? ys[0];
      if (!Number.isFinite(y)) {
        return;
      }

      const xOffset = tickHasMixedHeadTypes(tick) ? -MIXED_HEAD_X_OFFSET_PX : 0;
      drawXNotehead(context, note.getStemX() + xOffset, y);
    });
  });
}

function drawXNotehead(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  centerX: number,
  centerY: number,
) {
  const size = 5.5;
  context.save();
  context.setStrokeStyle("#111317");
  context.setLineWidth(1.6);
  context.beginPath();
  context.moveTo(centerX - size, centerY - size);
  context.lineTo(centerX + size, centerY + size);
  context.moveTo(centerX + size, centerY - size);
  context.lineTo(centerX - size, centerY + size);
  context.stroke();
  context.restore();
}

function configureVoiceFlags(notes: StaveNote[], ticks: DisplayTick[], voice: VoiceNumber) {
  if (voice === 2) {
    notes.forEach((note) => note.setFlagStyle({ fillStyle: "transparent", strokeStyle: "transparent" }));
    return;
  }

  const beamedNotes = new Set(
    beamGroups(notes, ticks)
      .filter((group) => group.layer === "DRUM" && shouldDrawBeam(group.ticks))
      .flatMap((group) => group.notes),
  );

  notes.forEach((note, index) => {
    const tick = ticks[index];
    if (!tick || tick.hiddenRest || tick.duration === "q") {
      note.setFlagStyle({ fillStyle: "transparent", strokeStyle: "transparent" });
      return;
    }

    if (beamedNotes.has(note)) {
      note.setFlagStyle({ fillStyle: "transparent", strokeStyle: "transparent" });
      return;
    }

    note.setFlagStyle({ fillStyle: "#111317", strokeStyle: "#111317" });
  });
}

function prepareStraightBeamStems(notes: StaveNote[], ticks: DisplayTick[], voice: VoiceNumber) {
  for (const group of beamGroups(notes, ticks)) {
    if ((voice === 1 && group.layer !== "DRUM") || !shouldDrawBeam(group.ticks)) {
      continue;
    }

    const visible = visibleGroupItems(group.notes, group.ticks);
    if (visible.length < 2) {
      continue;
    }

    const beamY = unifiedBeamY(visible, voice, group.layer);
    for (const { note } of visible) {
      if (voice === 1) {
        const baseY = note.getStemExtents().baseY;
        note.setStemLength(Math.max(MIN_BEAMED_STEM_LENGTH_PX, baseY - beamY));
      } else {
        const topY = note.getStemExtents().topY;
        note.setStemLength(Math.max(MIN_BEAMED_STEM_LENGTH_PX, beamY - topY));
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
  for (const group of beamGroups(notes, ticks)) {
    if ((voice === 1 && group.layer !== "DRUM") || !shouldDrawBeam(group.ticks)) {
      continue;
    }

    const visible = visibleGroupItems(group.notes, group.ticks);
    if (visible.length < 2) {
      continue;
    }

    const first = visible[0].note;
    const last = visible[visible.length - 1].note;
    const x1 = first.getStemX();
    const x2 = last.getStemX();
    const beamY = unifiedBeamY(visible, voice, group.layer);
    const beamCount = group.ticks.some((tick) => !tick.hiddenRest && tick.duration === "16") ? 2 : 1;

    drawBeamBar(context, x1, x2, beamY, voice);
    if (beamCount === 2) {
      const offset = voice === 1 ? BEAM_THICKNESS_PX + BEAM_SECONDARY_GAP_PX : -(BEAM_THICKNESS_PX + BEAM_SECONDARY_GAP_PX);
      drawBeamBar(context, x1, x2, beamY + offset, voice);
    }
  }
}

function unifiedBeamY(
  visible: Array<{
    note: StaveNote;
    tick: DisplayTick;
  }>,
  voice: VoiceNumber,
  layer: InstrumentLayer,
): number {
  if (voice === 1) {
    const highestHeadY = Math.min(...visible.flatMap(({ note }) => note.getYs()));
    const clearance = layer === "CYMBAL" ? CYMBAL_BEAM_CLEARANCE_PX : DRUM_BEAM_CLEARANCE_PX;
    return highestHeadY - clearance;
  }

  return Math.max(...visible.map(({ note }) => note.getStemExtents().baseY));
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

function beamGroups(
  notes: StaveNote[],
  ticks: DisplayTick[],
): Array<{ layer: InstrumentLayer; notes: StaveNote[]; ticks: DisplayTick[] }> {
  const groups: Array<{ layer: InstrumentLayer; notes: StaveNote[]; ticks: DisplayTick[] }> = [];

  for (const beatGroup of beatGroups(notes, ticks)) {
    let currentNotes: StaveNote[] = [];
    let currentTicks: DisplayTick[] = [];
    let currentLayer: InstrumentLayer | null = null;

    beatGroup.ticks.forEach((tick, index) => {
      const note = beatGroup.notes[index];
      const layer = getInstrumentLayer(tick);
      if (!note || !layer) {
        if (currentNotes.length > 0) {
          groups.push({ layer: currentLayer ?? "DRUM", notes: currentNotes, ticks: currentTicks });
        }
        currentNotes = [];
        currentTicks = [];
        currentLayer = null;
        return;
      }

      if (currentLayer && layer !== currentLayer) {
        groups.push({ layer: currentLayer, notes: currentNotes, ticks: currentTicks });
        currentNotes = [];
        currentTicks = [];
      }

      currentLayer = layer;
      currentNotes.push(note);
      currentTicks.push(tick);
    });

    if (currentNotes.length > 0) {
      groups.push({ layer: currentLayer ?? "DRUM", notes: currentNotes, ticks: currentTicks });
    }
  }

  return groups;
}

function visibleGroupItems(notes: StaveNote[], ticks: DisplayTick[]) {
  return notes.map((note, index) => ({ note, tick: ticks[index] })).filter((item) => !item.tick.hiddenRest);
}

function tickHasMixedHeadTypes(tick: DisplayTick): boolean {
  const hasX = tick.events.some((event) => event.notehead === "x");
  const hasRound = tick.events.some((event) => event.notehead === "normal");
  return hasX && hasRound;
}

function getInstrumentLayer(tick: DisplayTick): InstrumentLayer | null {
  if (tick.hiddenRest || tick.events.length === 0) {
    return null;
  }

  return tick.events.some((event) => event.notehead === "x") ? "CYMBAL" : "DRUM";
}

function shouldDrawBeam(ticks: DisplayTick[]): boolean {
  const visibleCount = ticks.filter((tick) => !tick.hiddenRest).length;
  const beamable = ticks.some((tick) => tick.duration === "8" || tick.duration === "16");
  return visibleCount >= 2 && beamable;
}

function drawBeamBar(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  x1: number,
  x2: number,
  beamY: number,
  voice: VoiceNumber,
) {
  const topY = voice === 1 ? beamY : beamY - BEAM_THICKNESS_PX;
  const bottomY = voice === 1 ? beamY + BEAM_THICKNESS_PX : beamY;
  context.save();
  context.setFillStyle("#111317");
  context.beginPath();
  context.moveTo(x1, topY);
  context.lineTo(x2, topY);
  context.lineTo(x2, bottomY);
  context.lineTo(x1, bottomY);
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

function measureLayoutFromStave(stave: Stave, measure: number, pageIndex: number, showLyrics: boolean): MeasureLayout {
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
    pageIndex,
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
  const normalizedEvent = normalizeNotationEvent(event);
  if (normalizedEvent.voice === 1) {
    slot.voice1 = dedupeNotationEvents([...slot.voice1, normalizedEvent]);
  } else {
    slot.voice2 = dedupeNotationEvents([...slot.voice2, normalizedEvent]);
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
  for (const rawEvent of events) {
    const event = normalizeNotationEvent(rawEvent);
    const current = byNote.get(event.drum);
    if (!current || event.confidence > current.confidence) {
      byNote.set(event.drum, event);
    }
  }

  return Array.from(byNote.values()).sort((a, b) => NOTE_MAP[a.drum].order - NOTE_MAP[b.drum].order);
}

function normalizeNotationEvent(event: NotationEvent): NotationEvent {
  const mapping = NOTE_MAP[event.drum];
  return {
    ...event,
    staff_key: mapping.key,
    voice: mapping.voice,
    notehead: mapping.notehead,
  };
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
