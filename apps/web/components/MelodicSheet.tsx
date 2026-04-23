"use client";

import { Beam, Formatter, Renderer, Stave, StaveConnector, StaveNote, Voice } from "vexflow";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { DrumSheetHandle, PrintableScoreSystem } from "@/components/DrumSheet";
import type { MelodicMeasure, MelodicNoteEvent, MelodicRenderTrack, MelodicSlot } from "@/lib/scoreTracks";

type Props = {
  audioCurrentTime?: number;
  followPlayback?: boolean;
  isPlaying?: boolean;
  onFollowPlaybackChange?: (enabled: boolean) => void;
  onSeek?: (time: number) => void;
  showLyrics?: boolean;
  track: MelodicRenderTrack;
};

type VoiceNumber = 1 | 2;

type DisplayTick = {
  duration: "q" | "8" | "16";
  events: MelodicNoteEvent[];
  hiddenRest?: boolean;
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
  measures: MelodicMeasure[];
};

type PlaybackPosition = {
  measure: number;
  slot: number;
  slotProgress: number;
};

const PAGE_HEIGHT_PX = 1123;
const PAGE_PADDING_X = 24;
const PAGE_PADDING_Y = 34;
const PAGE_WIDTH_PX = 794;
const LINE_HEIGHT_SINGLE_WITH_LYRICS = 186;
const LINE_HEIGHT_SINGLE_WITHOUT_LYRICS = 146;
const LINE_HEIGHT_GRAND_WITH_LYRICS = 268;
const LINE_HEIGHT_GRAND_WITHOUT_LYRICS = 226;
const SLOTS_PER_MEASURE = 16;
const MIN_SLOT_WIDTH_PX = 40;
const FIRST_MEASURE_RESERVE_PX = 76;
const REGULAR_MEASURE_RESERVE_PX = 24;
const LYRIC_FONT_SIZE = 12;
const LYRIC_HORIZONTAL_PADDING_PX = 5;
const AUTO_SCROLL_GUARD_MS = 1000;
const GRAND_STAFF_GAP_PX = 86;

export const MelodicSheet = forwardRef<DrumSheetHandle, Props>(function MelodicSheet(
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
  const lineHeight =
    track.notation === "grand"
      ? showLyrics
        ? LINE_HEIGHT_GRAND_WITH_LYRICS
        : LINE_HEIGHT_GRAND_WITHOUT_LYRICS
      : showLyrics
        ? LINE_HEIGHT_SINGLE_WITH_LYRICS
        : LINE_HEIGHT_SINGLE_WITHOUT_LYRICS;
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

        page.measures.forEach((measure, localIndex) => {
          const globalIndex = page.measureStart - 1 + localIndex;
          const x = PAGE_PADDING_X;
          const y = PAGE_PADDING_Y + localIndex * lineHeight;
          const staveWidth = measureWidth;

          drawMeasureNumber(context, globalIndex + 1, x, y);

          if (track.notation === "grand") {
            const upperStave = new Stave(x, y, staveWidth);
            const lowerStave = new Stave(x, y + GRAND_STAFF_GAP_PX, staveWidth);
            if (localIndex === 0) {
              upperStave.addClef("treble").addTimeSignature("4/4");
              lowerStave.addClef("bass").addTimeSignature("4/4");
            }
            upperStave.setContext(context).draw();
            lowerStave.setContext(context).draw();

            new StaveConnector(upperStave, lowerStave).setType(StaveConnector.type.SINGLE_LEFT).setContext(context).draw();
            if (localIndex === 0) {
              new StaveConnector(upperStave, lowerStave).setType(StaveConnector.type.BRACE).setContext(context).draw();
            }

            const upperTicks = simplifyVoice(measure, 1);
            const lowerTicks = simplifyVoice(measure, 2);
            const upperNotes = upperTicks.map((tick) => makeMelodicNote(tick, "treble"));
            const lowerNotes = lowerTicks.map((tick) => makeMelodicNote(tick, "bass"));
            const upperVoice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(true);
            const lowerVoice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(true);
            upperVoice.addTickables(upperNotes);
            lowerVoice.addTickables(lowerNotes);

            const formatterWidth = staveWidth - (localIndex === 0 ? FIRST_MEASURE_RESERVE_PX : REGULAR_MEASURE_RESERVE_PX);
            new Formatter().joinVoices([upperVoice]).joinVoices([lowerVoice]).format([upperVoice, lowerVoice], formatterWidth);

            upperVoice.draw(context, upperStave);
            lowerVoice.draw(context, lowerStave);
            drawBeams(context, upperNotes);
            drawBeams(context, lowerNotes);

            if (showLyrics) {
              drawLyricLane(context, lowerStave, measure);
            }

            nextLayouts[globalIndex] = measureLayoutFromGrandStaves(upperStave, lowerStave, globalIndex + 1, pageIndex, showLyrics);
            return;
          }

          const stave = new Stave(x, y, staveWidth);
          if (localIndex === 0) {
            stave.addClef(track.clef).addTimeSignature("4/4");
          }
          stave.setContext(context).draw();

          const mergedTicks = simplifyMergedVoice(measure);
          const notes = mergedTicks.map((tick) => makeMelodicNote(tick, track.clef));
          const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(true);
          voice.addTickables(notes);

          const formatterWidth = staveWidth - (localIndex === 0 ? FIRST_MEASURE_RESERVE_PX : REGULAR_MEASURE_RESERVE_PX);
          new Formatter().joinVoices([voice]).format([voice], formatterWidth);

          voice.draw(context, stave);
          drawBeams(context, notes);

          if (showLyrics) {
            drawLyricLane(context, stave, measure);
          }

          nextLayouts[globalIndex] = measureLayoutFromSingleStave(stave, globalIndex + 1, pageIndex, showLyrics);
        });
      });

      setRenderError(null);
      setMeasureLayouts(nextLayouts);
    } catch (error) {
      console.error("MelodicSheet render failed", error);
      svgLayerRefs.current.forEach((container) => {
        if (container) {
          container.innerHTML = "";
        }
      });
      setMeasureLayouts([]);
      setRenderError(error instanceof Error ? error.message : "Melodic score rendering failed.");
    }
  }, [lineHeight, measureWidth, pages, showLyrics, track.clef, track.notation]);

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
    <div className="score-wrap" aria-label={`${track.label} score with synchronized playback`}>
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
  measures: MelodicMeasure[],
  lineHeight: number,
): { measureWidth: number; measuresPerPage: number; pages: PageDescriptor[] } {
  const measuresPerLine = 1;
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

  return { measureWidth, measuresPerPage, pages };
}

function simplifyVoice(measure: MelodicMeasure, voice: VoiceNumber): DisplayTick[] {
  const result: DisplayTick[] = [];

  for (let beatStart = 0; beatStart < SLOTS_PER_MEASURE; beatStart += 4) {
    const slots = [0, 1, 2, 3].map((offset) => beatStart + offset);
    const occupied = slots.filter((slot) => getVoiceEvents(measure.slots[slot], voice).length > 0);

    if (occupied.length === 0) {
      result.push({ duration: "q", events: [], hiddenRest: true, slot: beatStart });
      continue;
    }

    if (occupied.length === 1 && occupied[0] === beatStart) {
      result.push({ duration: "q", events: getVoiceEvents(measure.slots[beatStart], voice), slot: beatStart });
      continue;
    }

    if (occupied.every((slot) => slot % 2 === 0)) {
      for (const slot of [beatStart, beatStart + 2]) {
        const events = getVoiceEvents(measure.slots[slot], voice);
        result.push({
          duration: "8",
          events,
          hiddenRest: events.length === 0,
          slot,
        });
      }
      continue;
    }

    for (const slot of slots) {
      const events = getVoiceEvents(measure.slots[slot], voice);
      result.push({
        duration: "16",
        events,
        hiddenRest: events.length === 0,
        slot,
      });
    }
  }

  return result;
}

function simplifyMergedVoice(measure: MelodicMeasure): DisplayTick[] {
  const result: DisplayTick[] = [];

  for (let beatStart = 0; beatStart < SLOTS_PER_MEASURE; beatStart += 4) {
    const slots = [0, 1, 2, 3].map((offset) => beatStart + offset);
    const occupied = slots.filter((slot) => mergeSlotEvents(measure.slots[slot]).length > 0);

    if (occupied.length === 0) {
      result.push({ duration: "q", events: [], hiddenRest: true, slot: beatStart });
      continue;
    }

    if (occupied.length === 1 && occupied[0] === beatStart) {
      result.push({ duration: "q", events: mergeSlotEvents(measure.slots[beatStart]), slot: beatStart });
      continue;
    }

    if (occupied.every((slot) => slot % 2 === 0)) {
      for (const slot of [beatStart, beatStart + 2]) {
        const events = mergeSlotEvents(measure.slots[slot]);
        result.push({
          duration: "8",
          events,
          hiddenRest: events.length === 0,
          slot,
        });
      }
      continue;
    }

    for (const slot of slots) {
      const events = mergeSlotEvents(measure.slots[slot]);
      result.push({
        duration: "16",
        events,
        hiddenRest: events.length === 0,
        slot,
      });
    }
  }

  return result;
}

function makeMelodicNote(tick: DisplayTick, clef: "bass" | "treble"): StaveNote {
  const keys = uniqueSortedKeys(tick.events, clef);
  const stemDirection = keys.length > 0 ? stemDirectionForKeys(keys, clef) : 1;

  return new StaveNote({
    auto_stem: false,
    clef,
    duration: tick.hiddenRest || keys.length === 0 ? `${tick.duration}r` : tick.duration,
    keys: keys.length > 0 ? keys : [restKeyForClef(clef)],
    stem_direction: stemDirection,
  });
}

function drawBeams(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  notes: StaveNote[],
) {
  Beam.generateBeams(notes).forEach((beam) => beam.setContext(context).draw());
}

function uniqueSortedKeys(events: MelodicNoteEvent[], clef: "bass" | "treble"): string[] {
  const unique = Array.from(new Set(events.map((event) => event.staffKey)));
  return unique.sort((left, right) => lineForKey(left, clef) - lineForKey(right, clef));
}

function stemDirectionForKeys(keys: string[], clef: "bass" | "treble"): number {
  const averageLine = keys.reduce((total, key) => total + lineForKey(key, clef), 0) / Math.max(keys.length, 1);
  return averageLine < 2 ? 1 : -1;
}

function restKeyForClef(clef: "bass" | "treble"): string {
  return clef === "bass" ? "d/3" : "b/4";
}

function lineForKey(key: string, clef: "bass" | "treble"): number {
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
  const base = clef === "bass" ? 2 * 7 + diatonicOrder.g : 4 * 7 + diatonicOrder.e;
  return (index - base) / 2;
}

function getVoiceEvents(slot: MelodicSlot, voice: VoiceNumber): MelodicNoteEvent[] {
  return voice === 1 ? slot.voice1 : slot.voice2;
}

function mergeSlotEvents(slot: MelodicSlot): MelodicNoteEvent[] {
  const merged = [...slot.voice1, ...slot.voice2];
  const byKey = new Map<string, MelodicNoteEvent>();
  for (const event of merged) {
    const current = byKey.get(event.staffKey);
    if (!current || event.confidence > current.confidence) {
      byKey.set(event.staffKey, event);
    }
  }
  return Array.from(byKey.values()).sort((left, right) => lineForKey(left.staffKey, "treble") - lineForKey(right.staffKey, "treble"));
}

function emptySlots(): MelodicSlot[] {
  return Array.from({ length: SLOTS_PER_MEASURE }, () => ({
    lyric: null,
    lyrics: [],
    voice1: [],
    voice2: [],
  }));
}

function drawLyricLane(
  context: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  stave: Stave,
  measure: MelodicMeasure,
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

function measureLayoutFromSingleStave(stave: Stave, measure: number, pageIndex: number, showLyrics: boolean): MeasureLayout {
  const slotZero = slotToX(stave, 0);
  const slotOne = slotToX(stave, 1);
  const slotWidth = Math.max(1, slotOne - slotZero);
  const gridStartX = slotZero - slotWidth / 2;
  const gridEndX = gridStartX + slotWidth * SLOTS_PER_MEASURE;
  const top = stave.getYForLine(0) - 40;
  const bottom = showLyrics ? stave.getYForLine(6) + 52 : stave.getYForLine(4) + 26;

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

function measureLayoutFromGrandStaves(
  upperStave: Stave,
  lowerStave: Stave,
  measure: number,
  pageIndex: number,
  showLyrics: boolean,
): MeasureLayout {
  const slotZero = slotToX(upperStave, 0);
  const slotOne = slotToX(upperStave, 1);
  const slotWidth = Math.max(1, slotOne - slotZero);
  const gridStartX = slotZero - slotWidth / 2;
  const gridEndX = gridStartX + slotWidth * SLOTS_PER_MEASURE;
  const top = upperStave.getYForLine(0) - 42;
  const bottom = showLyrics ? lowerStave.getYForLine(6) + 52 : lowerStave.getYForLine(4) + 28;

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
