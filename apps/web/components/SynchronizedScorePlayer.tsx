"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { AnalysisResult } from "@/lib/types";

export type PlaybackSource =
  | {
      kind: "audio";
      title: string;
      url: string;
    }
  | {
      kind: "youtube";
      title: string;
      url: string;
      videoId: string;
    };

export type SynchronizedScorePlayerHandle = {
  pause: () => void;
  play: () => void;
  seekTo: (seconds: number) => void;
};

type Props = {
  currentTime: number;
  followPlayback: boolean;
  onFollowPlaybackChange: (enabled: boolean) => void;
  onPlaybackStateChange?: (playing: boolean) => void;
  onTimeChange: (time: number) => void;
  score: AnalysisResult;
  source: PlaybackSource;
};

type YouTubeEvent = { data: number; target: YouTubePlayer };
type YouTubePlayer = {
  destroy: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  pauseVideo: () => void;
  playVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setVolume: (volume: number) => void;
};
type YouTubeApi = {
  Player: new (
    element: HTMLElement,
    options: {
      events: {
        onReady: (event: { target: YouTubePlayer }) => void;
        onStateChange: (event: YouTubeEvent) => void;
      };
      height: string;
      playerVars: Record<string, number | string>;
      videoId: string;
      width: string;
    },
  ) => YouTubePlayer;
};

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YOUTUBE_PLAYING = 1;
const YOUTUBE_PAUSED = 2;
const YOUTUBE_ENDED = 0;

let youtubeApiPromise: Promise<YouTubeApi> | null = null;

export const SynchronizedScorePlayer = forwardRef<SynchronizedScorePlayerHandle, Props>(
  function SynchronizedScorePlayer(
    { currentTime, followPlayback, onFollowPlaybackChange, onPlaybackStateChange, onTimeChange, score, source },
    ref,
  ) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const volumeRef = useRef(0.85);
    const youtubeMountRef = useRef<HTMLDivElement | null>(null);
    const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
    const playbackLoopFrameRef = useRef<number | null>(null);
    const [duration, setDuration] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [volume, setVolume] = useState(0.85);
    const sourceKey = source.kind === "youtube" ? `youtube:${source.videoId}` : `audio:${source.url}`;
    const scoreDuration = useMemo(() => estimateScoreDuration(score), [score]);
    const playbackDuration = duration > 0 ? duration : scoreDuration;

    const publishPlaybackSnapshot = useCallback(() => {
      const nextTime = readCurrentTime(source, audioRef.current, youtubePlayerRef.current);
      if (Number.isFinite(nextTime)) {
        onTimeChange(nextTime);
      }

      const nextDuration = readDuration(source, audioRef.current, youtubePlayerRef.current);
      if (Number.isFinite(nextDuration) && nextDuration > 0) {
        setDuration((current) => (Math.abs(current - nextDuration) > 0.25 ? nextDuration : current));
      }
    }, [onTimeChange, source]);

    const stopPlaybackLoop = useCallback(() => {
      if (playbackLoopFrameRef.current !== null) {
        cancelAnimationFrame(playbackLoopFrameRef.current);
        playbackLoopFrameRef.current = null;
      }
    }, []);

    const startPlaybackLoop = useCallback(() => {
      stopPlaybackLoop();

      const tick = () => {
        publishPlaybackSnapshot();
        playbackLoopFrameRef.current = requestAnimationFrame(tick);
      };

      playbackLoopFrameRef.current = requestAnimationFrame(tick);
    }, [publishPlaybackSnapshot, stopPlaybackLoop]);

    useEffect(() => {
      volumeRef.current = volume;
    }, [volume]);

    useImperativeHandle(
      ref,
      () => ({
        pause: () => pauseSource(source, audioRef.current, youtubePlayerRef.current),
        play: () => {
          void playSource(source, audioRef.current, youtubePlayerRef.current);
        },
        seekTo: (seconds: number) => {
          seekSource(source, audioRef.current, youtubePlayerRef.current, seconds);
          onTimeChange(clampTime(seconds, playbackDuration));
        },
      }),
      [onTimeChange, playbackDuration, source],
    );

    useEffect(() => {
      setIsPlaying(false);
      setDuration(0);
      stopPlaybackLoop();
      onTimeChange(0);
    }, [onTimeChange, sourceKey, stopPlaybackLoop]);

    useEffect(() => {
      onPlaybackStateChange?.(isPlaying);
    }, [isPlaying, onPlaybackStateChange]);

    useEffect(() => {
      if (source.kind !== "audio") {
        return;
      }

      const audio = audioRef.current;
      if (!audio) {
        return;
      }

      audio.volume = volume;
    }, [source.kind, volume]);

    useEffect(() => {
      if (source.kind !== "youtube") {
        return;
      }

      youtubePlayerRef.current?.setVolume(Math.round(volume * 100));
    }, [source.kind, volume]);

    useEffect(() => {
      if (source.kind !== "youtube") {
        youtubePlayerRef.current?.destroy();
        youtubePlayerRef.current = null;
        stopPlaybackLoop();
        return;
      }

      let disposed = false;
      const mount = youtubeMountRef.current;
      if (!mount) {
        return;
      }

      mount.innerHTML = "";
      void loadYouTubeApi().then((api) => {
        if (disposed || !youtubeMountRef.current) {
          return;
        }

        const player = new api.Player(youtubeMountRef.current, {
          height: "180",
          width: "320",
          videoId: source.videoId,
          playerVars: {
            controls: 0,
            disablekb: 1,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
          },
          events: {
            onReady: (event) => {
              event.target.setVolume(Math.round(volumeRef.current * 100));
              const nextDuration = event.target.getDuration();
              if (Number.isFinite(nextDuration) && nextDuration > 0) {
                setDuration(nextDuration);
              }
              publishPlaybackSnapshot();
            },
            onStateChange: (event) => {
              if (event.data === YOUTUBE_PLAYING) {
                setIsPlaying(true);
                startPlaybackLoop();
                publishPlaybackSnapshot();
                return;
              }
              if (event.data === YOUTUBE_PAUSED || event.data === YOUTUBE_ENDED) {
                setIsPlaying(false);
                stopPlaybackLoop();
                publishPlaybackSnapshot();
              }
            },
          },
        });
        youtubePlayerRef.current = player;
      });

      return () => {
        disposed = true;
        stopPlaybackLoop();
        youtubePlayerRef.current?.destroy();
        youtubePlayerRef.current = null;
      };
    }, [publishPlaybackSnapshot, source, startPlaybackLoop, stopPlaybackLoop]);

    function togglePlayback() {
      if (isPlaying) {
        pauseSource(source, audioRef.current, youtubePlayerRef.current);
        stopPlaybackLoop();
        return;
      }

      void playSource(source, audioRef.current, youtubePlayerRef.current);
      if (source.kind === "audio") {
        startPlaybackLoop();
      }
    }

    function seekTo(seconds: number) {
      const safeTime = clampTime(seconds, playbackDuration);
      seekSource(source, audioRef.current, youtubePlayerRef.current, safeTime);
      onTimeChange(safeTime);
    }

    return (
      <section className="player-panel" aria-label="Synchronized audio player">
        <div className="player-header">
          <div>
            <div className="player-kicker">{source.kind === "youtube" ? "YouTube source" : "Uploaded audio"}</div>
            <div className="player-title">{source.title}</div>
          </div>
          <div className="player-actions">
            <button className="player-button" onClick={togglePlayback} type="button">
              {isPlaying ? "Pause" : "Play"}
            </button>
            <button
              aria-pressed={followPlayback}
              className={followPlayback ? "player-button player-follow-button active" : "player-button player-follow-button"}
              onClick={() => onFollowPlaybackChange(!followPlayback)}
              type="button"
            >
              {followPlayback ? "Follow On" : "Follow Off"}
            </button>
          </div>
        </div>

        {source.kind === "audio" ? (
          <audio
            ref={audioRef}
            onDurationChange={(event) => setDuration(safeDuration(event.currentTarget.duration))}
            onEnded={() => {
              setIsPlaying(false);
              stopPlaybackLoop();
              publishPlaybackSnapshot();
            }}
            onLoadedMetadata={(event) => setDuration(safeDuration(event.currentTarget.duration))}
            onPause={() => {
              setIsPlaying(false);
              stopPlaybackLoop();
              publishPlaybackSnapshot();
            }}
            onPlay={() => {
              setIsPlaying(true);
              startPlaybackLoop();
            }}
            onSeeked={publishPlaybackSnapshot}
            preload="metadata"
            src={source.url}
          />
        ) : (
          <div className="youtube-player-shell" aria-label="YouTube audio source">
            <div ref={youtubeMountRef} />
          </div>
        )}

        <div className="transport-row">
          <span className="time-label">{formatTime(currentTime)}</span>
          <input
            aria-label="Seek playback"
            className="seek-slider"
            max={Math.max(playbackDuration, 0.01)}
            min={0}
            onChange={(event) => seekTo(Number(event.target.value))}
            step={0.01}
            type="range"
            value={Math.min(currentTime, Math.max(playbackDuration, 0.01))}
          />
          <span className="time-label">{formatTime(playbackDuration)}</span>
        </div>

        <label className="volume-row">
          <span>Volume</span>
          <input
            aria-label="Volume"
            max={1}
            min={0}
            onChange={(event) => setVolume(Number(event.target.value))}
            step={0.01}
            type="range"
            value={volume}
          />
        </label>
      </section>
    );
  },
);

function loadYouTubeApi(): Promise<YouTubeApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube player is only available in the browser."));
  }

  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise((resolve) => {
    const previousReadyHandler = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReadyHandler?.();
      if (window.YT?.Player) {
        resolve(window.YT);
      }
    };

    const existingScript = document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]');
    if (existingScript) {
      return;
    }

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.head.appendChild(script);
  });

  return youtubeApiPromise;
}

function playSource(source: PlaybackSource, audio: HTMLAudioElement | null, youtubePlayer: YouTubePlayer | null) {
  if (source.kind === "audio") {
    return audio?.play();
  }

  youtubePlayer?.playVideo();
  return undefined;
}

function pauseSource(source: PlaybackSource, audio: HTMLAudioElement | null, youtubePlayer: YouTubePlayer | null) {
  if (source.kind === "audio") {
    audio?.pause();
    return;
  }

  youtubePlayer?.pauseVideo();
}

function seekSource(
  source: PlaybackSource,
  audio: HTMLAudioElement | null,
  youtubePlayer: YouTubePlayer | null,
  seconds: number,
) {
  if (source.kind === "audio") {
    if (audio) {
      audio.currentTime = seconds;
    }
    return;
  }

  youtubePlayer?.seekTo(seconds, true);
}

function readCurrentTime(
  source: PlaybackSource,
  audio: HTMLAudioElement | null,
  youtubePlayer: YouTubePlayer | null,
): number {
  if (source.kind === "audio") {
    return audio?.currentTime ?? 0;
  }

  return youtubePlayer?.getCurrentTime() ?? 0;
}

function readDuration(
  source: PlaybackSource,
  audio: HTMLAudioElement | null,
  youtubePlayer: YouTubePlayer | null,
): number {
  if (source.kind === "audio") {
    return safeDuration(audio?.duration ?? 0);
  }

  return safeDuration(youtubePlayer?.getDuration() ?? 0);
}

function safeDuration(duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function clampTime(seconds: number, duration: number): number {
  return Math.min(Math.max(0, seconds), Math.max(duration, 0));
}

function estimateScoreDuration(score: AnalysisResult): number {
  const beatSeconds = 60 / Math.max(score.bpm || 120, 1);
  const measureSeconds = beatSeconds * 4;
  const measureDuration = Math.max(1, score.engraved_measures.length) * measureSeconds;
  const lastWord = Math.max(...score.words.map((word) => word.end), 0);
  const lastEvent = Math.max(...score.events.map((event) => event.time), 0);
  return Math.max(measureDuration, lastWord, lastEvent);
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}
