"use client";

import {
  Articulation,
  Beam,
  Curve,
  Formatter,
  Modifier,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  TabStave,
  Voice,
} from "vexflow";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { DrumSheetHandle, PrintableScoreSystem } from "@/components/DrumSheet";
import type { BassMeasure, BassRenderNote, BassRenderTrack, BassSlot } from "@/lib/scoreTracks";

type Props = {
  audioCurrentTime?: number;
  followPlayback?: boolean;
  isPlaying?: boolean;
  onFollowPlaybackChange?: (enabled: boolean) => void;
  onSeek?: (time: number) => void;
  showLyrics?: boolean;
  track: BassRenderTrack;
};

type BassDisplayTick = {
  duration: "w" | "h" | "q" | "8" | "16";
  durationSlots: number;
  note: BassRenderNote | null;
  slot: number;
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
  measures: BassMeasure[];
};

type PlaybackPosition = {
  measure: number;
  slot: number;
  slotProgress: number;
};

type RenderedBassNote = {
  centerX: number;
  note: BassRenderNote;
  standardNote: StaveNote | null;
  systemKey: string;
  tabStave: TabStave;
};

const PAGE_HEIGHT_PX = 1123;
const PAGE_PADDING_X = 24;
const PAGE_PADDING_Y = 34;
const PAGE_WIDTH_PX = 794;
const SLOTS_PER_MEASURE = 16;
const MEASURES_PER_LINE = 4;
const FIRST_MEASURE_RESERVE_PX = 76;
const REGULAR_MEASURE_RESERVE_PX = 24;
const LYRIC_FONT_SIZE = 12;
const LYRIC_HORIZONTAL_PADDING_PX = 5;
const AUTO_SCROLL_GUARD_MS = 1000;
const TAB_GAP_PX = 94;
const LINE_HEIGHT_STANDARD = 168;
const LINE_HEIGHT_STANDARD_LYRICS = 204;
const LINE_HEIGHT_TAB = 156;
const LINE_HEIGHT_TAB_LYRICS = 194;
const LINE_HEIGHT_BOTH = 270;
const LINE_HEIGHT_BOTH_LYRICS = 306;
const TAB_TEXT_FONT_SIZE = 14;

export const BassSheet = forwardRef<DrumSheetHandle, Props>(function BassSheet(
  { audioCurrentTime = 0, followPlayback = true, isPlaying = false, onFollowPlaybackChange, onSeek, showLyrics = true, track }: Props,
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

  const measures = track.measures;
  const lineHeight = resolveLineHeight(track.mode, showLyrics);
  const pagination = useMemo(() => paginateMeasures(measures, lineHeight), [lineHeight, measures]);
  const pages = pagination.pages;
  const measuresPerPage = pagination.measuresPerPage;
  const measureWidth = pagination.measureWidth;
  const playbackPosition = useMemo(
    () => timeToPlaybackPosition(audioCurrentTime, track.bpm, measures.length),
    [audioCurrentTime, measures.length, track.bpm],
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
        const renderedNotes: RenderedBassNote[] = [];

        page.measures.forEach((measure, localIndex) => {
          const globalIndex = page.measureStart - 1 + localIndex;
          const measureInLine = localIndex % MEASURES_PER_LINE;
          const lineIndex = Math.floor(localIndex / MEASURES_PER_LINE);
          const x = PAGE_PADDING_X + measureInLine * measureWidth;
          const y = PAGE_PADDING_Y + lineIndex * lineHeight;
          const staveWidth = measureWidth;
          const displayTicks = buildBassDisplayTicks(measure);
          const isLineStart = measureInLine === 0;
          const systemKey = `${pageIndex}:${lineIndex}`;

          drawMeasureNumber(context, globalIndex + 1, x, y);

          const standardStave = new Stave(x, y, staveWidth);
          const tabStave = new TabStave(x, y + TAB_GAP_PX, staveWidth, { num_lines: 4, spacing_between_lines_px: 15 });

          if (track.mode !== "tab") {
            if (isLineStart) {
              standardStave.addClef("bass").addTimeSignature("4/4");
            }
            standardStave.setContext(context).draw();
          }

          if (track.mode !== "standard") {
            if (isLineStart) {
              tabStave.addClef("tab").addTimeSignature("4/4");
            }
            tabStave.setContext(context).draw();
          }

          if (track.mode === "both") {
            new StaveConnector(standardStave, tabStave).setType(StaveConnector.type.SINGLE_LEFT).setContext(context).draw();
          }

          if (track.mode !== "tab") {
            const notes = displayTicks.map((tick) => makeBassStandardNote(tick));
            const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(true);
            voice.addTickables(notes);

            const formatterWidth = staveWidth - (isLineStart ? FIRST_MEASURE_RESERVE_PX : REGULAR_MEASURE_RESERVE_PX);
            new Formatter().joinVoices([voice]).format([voice], formatterWidth);
            voice.draw(context, standardStave);
            Beam.generateBeams(notes).forEach((beam) => beam.setContext(context).draw());

            drawTabNumbers(context, displayTicks, notes, tabStave, track.mode);
            renderedNotes.push(...collectRenderedNotes(displayTicks, notes, tabStave, systemKey));

            if (showLyrics) {
              drawLyricLane(context, lyricsHostStave(track.mode, standardStave, tabStave), measure);
            }

            nextLayouts[globalIndex] = measureLayoutFromStaves(track.mode, standardStave, tabStave, globalIndex + 1, pageIndex, showLyrics);
            return;
          }

          drawTabNumbers(context, displayTicks, [], tabStave, track.mode);
          renderedNotes.push(...collectRenderedNotes(displayTicks, [], tabStave, systemKey));
          if (showLyrics) {
            drawLyricLane(context, tabStave, measure);
          }
          nextLayouts[globalIndex] = measureLayoutFromStaves(track.mode, standardStave, tabStave, globalIndex + 1, pageIndex, showLyrics);
        });

        if (renderedNotes.length > 0) {
          drawTechniqueConnections(context, renderedNotes);
        }
      });

      setRenderError(null);
      setMeasureLayouts(nextLayouts);
    } catch (error) {
      console.error("BassSheet render failed", error);
      svgLayerRefs.current.forEach((container) => {
        if (container) {
          container.innerHTML = "";
        }
      });
      setMeasureLayouts([]);
      setRenderError(error instanceof Error ? error.message : "Bass score rendering failed.");
    }
  }, [lineHeight, measureWidth, pages, showLyrics, track.mode]);

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
    const pageStride = secondPage && firstPage ? secondPage.offsetLeft - firstPage.offsetLeft : firstPage.offsetWidth;
    return Math.max(0, pageStride * pageIndex);
  }, []);

  const scrollToPage = useCallback(
    (pageIndex: number, behavior: ScrollBehavior = "smooth") => {
      if (!pageRefs.current[pageIndex]) {
        return;
      }

      autoScrollGuardUntilRef.current = performance.now() + AUTO_SCROLL_GUARD_MS;
      setVisiblePageIndex((current) => (current === pageIndex ? current : pageIndex));
      if (behavior === "auto") {
        const targetLeft = getPageScrollLeft(pageIndex);
        setPageTranslateX((current) => (Math.abs(current - targetLeft) < 1 ? current : targetLeft));
      }
    },
    [getPageScrollLeft],
  );

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
        window.scrollTo({ behavior, top: targetTop });
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

    const beatSeconds = 60 / Math.max(track.bpm || 120, 1);
    const measureSeconds = beatSeconds * 4;
    const fraction = clamp((x - layout.gridStartX) / (layout.gridEndX - layout.gridStartX), 0, 1);
    onSeek((layout.measure - 1) * measureSeconds + fraction * measureSeconds);
  }

  return (
    <div className="score-wrap" aria-label="Bass score with synchronized playback">
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
                          const beatSeconds = 60 / Math.max(track.bpm || 120, 1);
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

function resolveLineHeight(mode: BassRenderTrack["mode"], showLyrics: boolean): number {
  if (mode === "standard") {
    return showLyrics ? LINE_HEIGHT_STANDARD_LYRICS : LINE_HEIGHT_STANDARD;
  }
  if (mode === "tab") {
    return showLyrics ? LINE_HEIGHT_TAB_LYRICS : LINE_HEIGHT_TAB;
  }
  return showLyrics ? LINE_HEIGHT_BOTH_LYRICS : LINE_HEIGHT_BOTH;
}

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
  measures: BassMeasure[],
  lineHeight: number,
): { measureWidth: number; measuresPerPage: number; pages: PageDescriptor[] } {
  const innerHeight = PAGE_HEIGHT_PX - PAGE_PADDING_Y * 2;
  const linesPerPage = Math.max(1, Math.floor(innerHeight / lineHeight));
  const measuresPerPage = Math.max(1, MEASURES_PER_LINE * linesPerPage);
  const innerWidth = PAGE_WIDTH_PX - PAGE_PADDING_X * 2;
  const measureWidth = innerWidth / MEASURES_PER_LINE;
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
      measures: [{ notes: [], slots: emptySlots() }],
    });
  }

  return { measureWidth, measuresPerPage, pages };
}

function buildBassDisplayTicks(measure: BassMeasure): BassDisplayTick[] {
  const notesBySlot = new Map<number, BassRenderNote>();
  for (const note of measure.notes) {
    notesBySlot.set(note.slot, note);
  }

  const ticks: BassDisplayTick[] = [];
  let slot = 0;
  while (slot < SLOTS_PER_MEASURE) {
    const note = notesBySlot.get(slot) ?? null;
    if (note) {
      const nextNoteSlot =
        measure.notes.find((entry) => entry.slot > slot)?.slot ?? SLOTS_PER_MEASURE;
      const durationSlots = Math.max(1, Math.min(note.durationSlots, nextNoteSlot - slot, SLOTS_PER_MEASURE - slot));
      ticks.push({
        duration: durationFromSlots(durationSlots),
        durationSlots,
        note,
        slot,
      });
      slot += durationSlots;
      continue;
    }

    const nextOccupiedSlot =
      measure.notes.find((entry) => entry.slot > slot)?.slot ?? SLOTS_PER_MEASURE;
    let remaining = Math.max(1, nextOccupiedSlot - slot);
    while (remaining > 0) {
      const durationSlots = largestSupportedDuration(remaining);
      ticks.push({
        duration: durationFromSlots(durationSlots),
        durationSlots,
        note: null,
        slot,
      });
      slot += durationSlots;
      remaining -= durationSlots;
    }
  }

  return ticks;
}

function largestSupportedDuration(remaining: number): 16 | 8 | 4 | 2 | 1 {
  if (remaining >= 16) {
    return 16;
  }
  if (remaining >= 8) {
    return 8;
  }
  if (remaining >= 4) {
    return 4;
  }
  if (remaining >= 2) {
    return 2;
  }
  return 1;
}

function durationFromSlots(slots: number): "w" | "h" | "q" | "8" | "16" {
  if (slots >= 16) {
    return "w";
  }
  if (slots >= 8) {
    return "h";
  }
  if (slots >= 4) {
    return "q";
  }
  if (slots >= 2) {
    return "8";
  }
  return "16";
}

function makeBassStandardNote(tick: BassDisplayTick): StaveNote {
  if (!tick.note) {
    return new StaveNote({
      clef: "bass",
      duration: `${tick.duration}r`,
      keys: ["d/3"],
    });
  }

  const note = new StaveNote({
    auto_stem: false,
    clef: "bass",
    duration: tick.duration,
    keys: [tick.note.displayStaffKey],
    stem_direction: stemDirectionForKey(tick.note.displayStaffKey),
    type: tick.note.isDead ? "x" : "n",
  });

  if (tick.note.isStaccato) {
    note.addModifier(
      new Articulation("a.").setPosition(
        tick.note.displayStaffKey && stemDirectionForKey(tick.note.displayStaffKey) === 1
          ? Modifier.Position.ABOVE
          : Modifier.Position.BELOW,
      ),
      0,
    );
  }
  return note;
}

function drawTabNumbers(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  ticks: BassDisplayTick[],
  standardNotes: StaveNote[],
  tabStave: TabStave,
  mode: BassRenderTrack["mode"],
) {
  if (mode === "standard") {
    return;
  }

  context.save();
  context.setFont("Arial, Malgun Gothic, sans-serif", TAB_TEXT_FONT_SIZE);
  context.setFillStyle("#111317");
  ticks.forEach((tick, index) => {
    if (!tick.note) {
      return;
    }

    const x = standardNotes[index] ? noteCenterX(standardNotes[index]) : slotToX(tabStave, tick.slot);
    const y = tabStave.getYForLine(tick.note.string - 1);
    const label = tick.note.fret === "X" ? "X" : String(tick.note.fret);
    const width = Math.max(12, label.length * 9);

    context.save();
    context.setFillStyle("#ffffff");
    context.fillRect(x - width / 2 - 2, y - 12, width + 4, 18);
    context.restore();

    context.fillText(label, x - width / 2, y + 5);

    if (tick.note.isStaccato) {
      context.beginPath();
      context.arc(x, y - 16, 2.2, 0, Math.PI * 2, false);
      context.fill();
    }

    if (tick.note.techniques.includes("SLAP")) {
      context.fillText("T", x - 4, tabStave.getYForLine(3) + 24);
    } else if (tick.note.techniques.includes("POP")) {
      context.fillText("P", x - 4, tabStave.getYForLine(3) + 24);
    }
  });
  context.restore();
}

function collectRenderedNotes(
  ticks: BassDisplayTick[],
  standardNotes: StaveNote[],
  tabStave: TabStave,
  systemKey: string,
): RenderedBassNote[] {
  return ticks.flatMap((tick, index) => {
    if (!tick.note) {
      return [];
    }
    const standardNote = standardNotes[index] ?? null;

    return [
      {
        centerX: standardNote ? noteCenterX(standardNote) : slotToX(tabStave, tick.slot),
        note: tick.note,
        standardNote,
        systemKey,
        tabStave,
      },
    ];
  });
}

function drawTechniqueConnections(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  renderedNotes: RenderedBassNote[],
) {
  for (let index = 0; index < renderedNotes.length; index += 1) {
    const current = renderedNotes[index];
    const next = renderedNotes[index + 1] ?? null;
    if (!current) {
      continue;
    }
    const connectableNext = next && canConnectRenderedNotes(current, next) ? next : null;

    if (current.note.tieToNext && connectableNext) {
      drawTieConnection(context, current, connectableNext);
    }

    if ((current.note.techniques.includes("HAMMER_ON") || current.note.techniques.includes("PULL_OFF")) && connectableNext) {
      drawSlurConnection(context, current, connectableNext, current.note.techniques.includes("HAMMER_ON") ? "H" : "P");
    } else if (current.note.slurToNext && connectableNext) {
      drawSlurConnection(context, current, connectableNext);
    }

    if (current.note.techniques.includes("SLIDE")) {
      if (connectableNext) {
        drawSlideLine(context, current, connectableNext);
      } else {
        drawSlideOutTail(context, current, current.note.slideOutDirection ?? resolveRenderedSlideDirection(current.note));
      }
    }
  }
}

function canConnectRenderedNotes(current: RenderedBassNote, next: RenderedBassNote): boolean {
  if (current.systemKey !== next.systemKey) {
    return false;
  }

  return next.note.measure === current.note.measure || next.note.measure === current.note.measure + 1;
}

function drawTieConnection(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  current: RenderedBassNote,
  next: RenderedBassNote,
) {
  if (current.standardNote && next.standardNote) {
    new StaveTie({
      first_indices: [0],
      first_note: current.standardNote,
      last_indices: [0],
      last_note: next.standardNote,
    })
      .setContext(context)
      .draw();
    return;
  }

  drawTabArc(context, current, next);
}

function drawSlurConnection(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  current: RenderedBassNote,
  next: RenderedBassNote,
  label?: "H" | "P",
) {
  if (current.standardNote && next.standardNote) {
    new Curve(current.standardNote, next.standardNote, {
      cps: [
        { x: 0, y: 8 },
        { x: 0, y: 8 },
      ],
      position: "nearHead",
      position_end: "nearHead",
      y_shift: 6,
    })
      .setContext(context)
      .draw();

    if (label) {
      const midX = (noteCenterX(current.standardNote) + noteCenterX(next.standardNote)) / 2;
      const labelY = Math.min(current.standardNote.getYs()[0], next.standardNote.getYs()[0]) - 18;
      context.save();
      context.setFont("Arial", 11);
      context.setFillStyle("#111317");
      context.fillText(label, midX - 4, labelY);
      context.restore();
    }
    return;
  }

  drawTabArc(context, current, next, label);
}

function drawSlideLine(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  current: RenderedBassNote,
  next: RenderedBassNote,
) {
  const direction = resolveRenderedSlideDirection(current.note, next.note);
  const startX = current.centerX + tabLabelHalfWidth(current.note) + 4;
  const endX = Math.max(startX + 12, next.centerX - tabLabelHalfWidth(next.note) - 4);
  const startY = tabLineY(current) + (direction === "up" ? 5 : -5);
  const endY = tabLineY(next) + (direction === "up" ? -5 : 5);
  context.save();
  context.setStrokeStyle("#111317");
  context.setLineWidth(1.6);
  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.stroke();
  context.restore();
}

function drawSlideOutTail(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  current: RenderedBassNote,
  direction: "up" | "down",
) {
  const startX = current.centerX + tabLabelHalfWidth(current.note) + 4;
  const startY = tabLineY(current) + (direction === "up" ? 4 : -4);
  const endX = startX + 20;
  const endY = startY + (direction === "up" ? -12 : 12);

  context.save();
  context.setStrokeStyle("#111317");
  context.setLineWidth(1.6);
  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.stroke();
  context.restore();
}

function drawTabArc(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  current: RenderedBassNote,
  next: RenderedBassNote,
  label?: "H" | "P",
) {
  const controlY = Math.min(current.tabStave.getYForLine(0), next.tabStave.getYForLine(0)) - 18;
  const startX = current.centerX + 4;
  const endX = next.centerX - 4;
  const midX = (startX + endX) / 2;

  context.save();
  context.setStrokeStyle("#111317");
  context.setFillStyle("#111317");
  context.setLineWidth(1.3);
  context.beginPath();
  context.moveTo(startX, controlY + 8);
  context.quadraticCurveTo(midX, controlY - 8, endX, controlY + 8);
  context.stroke();
  if (label) {
    context.setFont("Arial", 11);
    context.fillText(label, midX - 4, controlY - 10);
  }
  context.restore();
}

function noteCenterX(note: StaveNote): number {
  return (note.getTieLeftX() + note.getTieRightX()) / 2;
}

function tabLineY(renderedNote: RenderedBassNote): number {
  return renderedNote.tabStave.getYForLine(renderedNote.note.string - 1);
}

function tabLabelHalfWidth(note: BassRenderNote): number {
  const label = note.fret === "X" ? "X" : String(note.fret);
  return Math.max(12, label.length * 9) / 2;
}

function resolveRenderedSlideDirection(
  current: BassRenderNote,
  next?: BassRenderNote | null,
): "up" | "down" {
  if (current.slideDirection) {
    return current.slideDirection;
  }

  if (next) {
    if (typeof current.fret === "number" && typeof next.fret === "number" && next.fret !== current.fret) {
      return next.fret > current.fret ? "up" : "down";
    }
    if (current.actualMidi !== null && next.actualMidi !== null && next.actualMidi !== current.actualMidi) {
      return next.actualMidi > current.actualMidi ? "up" : "down";
    }
    if (next.string !== current.string) {
      return next.string < current.string ? "up" : "down";
    }
  }

  if (current.slideOutDirection) {
    return current.slideOutDirection;
  }

  return typeof current.fret === "number" && current.fret > 12 ? "down" : "up";
}

function lyricsHostStave(mode: BassRenderTrack["mode"], standardStave: Stave, tabStave: TabStave): Stave {
  return mode === "tab" ? tabStave : mode === "both" ? tabStave : standardStave;
}

function stemDirectionForKey(key: string): number {
  return lineForKey(key) < 0 ? 1 : -1;
}

function lineForKey(key: string): number {
  const match = /^([a-g])[#b]?\/(-?\d+)$/.exec(key);
  if (!match) {
    return 2;
  }

  const diatonicOrder: Record<string, number> = {
    a: 5,
    b: 6,
    c: 0,
    d: 1,
    e: 2,
    f: 3,
    g: 4,
  };

  const index = Number(match[2]) * 7 + diatonicOrder[match[1]];
  const bassMiddleLine = 3 * 7 + diatonicOrder.d;
  return (index - bassMiddleLine) / 2;
}

function drawLyricLane(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  stave: Stave,
  measure: BassMeasure,
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

function measureLayoutFromStaves(
  mode: BassRenderTrack["mode"],
  standardStave: Stave,
  tabStave: TabStave,
  measure: number,
  pageIndex: number,
  showLyrics: boolean,
): MeasureLayout {
  const referenceStave = mode === "tab" ? tabStave : standardStave;
  const slotZero = slotToX(referenceStave, 0);
  const slotOne = slotToX(referenceStave, 1);
  const slotWidth = Math.max(1, slotOne - slotZero);
  const gridStartX = slotZero - slotWidth / 2;
  const gridEndX = gridStartX + slotWidth * SLOTS_PER_MEASURE;

  let top = referenceStave.getYForLine(0) - 38;
  let bottom = mode === "tab" ? tabStave.getYForLine(3) + 32 : referenceStave.getYForLine(4) + 28;

  if (mode === "both") {
    top = standardStave.getYForLine(0) - 40;
    bottom = tabStave.getYForLine(3) + 32;
  }

  if (showLyrics) {
    bottom += 40;
  }

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

function emptySlots(): BassSlot[] {
  return Array.from({ length: SLOTS_PER_MEASURE }, () => ({
    lyric: null,
    lyrics: [],
    notes: [],
  }));
}
