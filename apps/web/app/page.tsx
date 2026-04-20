"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DrumSheet } from "@/components/DrumSheet";
import {
  SynchronizedScorePlayer,
  type PlaybackSource,
  type SynchronizedScorePlayerHandle,
} from "@/components/SynchronizedScorePlayer";
import { analyzeAudio, analyzeYouTube } from "@/lib/api";
import type { AnalysisJobStatus, AnalysisResult } from "@/lib/types";

type SourceType = "upload" | "youtube";

export default function Home() {
  const audioObjectUrlRef = useRef<string | null>(null);
  const playerRef = useRef<SynchronizedScorePlayerHandle | null>(null);
  const [sourceType, setSourceType] = useState<SourceType>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [score, setScore] = useState<AnalysisResult | null>(null);
  const [playbackSource, setPlaybackSource] = useState<PlaybackSource | null>(null);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [enableLyrics, setEnableLyrics] = useState(true);
  const [showLyrics, setShowLyrics] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (audioObjectUrlRef.current) {
        URL.revokeObjectURL(audioObjectUrlRef.current);
      }
    };
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedSourceType = sourceType;
    const submittedFile = file;
    const submittedYoutubeUrl = youtubeUrl.trim();

    if (submittedSourceType === "upload" && !submittedFile) {
      setError("Choose an MP3, WAV, M4A, or FLAC file.");
      return;
    }
    if (submittedSourceType === "youtube" && !submittedYoutubeUrl) {
      setError("Enter a YouTube link.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setStatusText(null);
    try {
      const options = {
        enableLyrics,
        onStatus: (job: AnalysisJobStatus) => {
          setStatusText(formatJobStatus(job.status, job.detail));
        },
      };
      const result =
        submittedSourceType === "youtube"
          ? await analyzeYouTube(submittedYoutubeUrl, options)
          : await analyzeAudio(submittedFile as File, options);
      setPlaybackSourceForInput(submittedSourceType, submittedFile, submittedYoutubeUrl);
      setScore(result);
      setAudioCurrentTime(0);
      setStatusText(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Analysis failed.");
    } finally {
      setIsLoading(false);
    }
  }

  function setPlaybackSourceForInput(
    submittedSourceType: SourceType,
    submittedFile: File | null,
    submittedYoutubeUrl: string,
  ) {
    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = null;
    }

    if (submittedSourceType === "upload" && submittedFile) {
      const objectUrl = URL.createObjectURL(submittedFile);
      audioObjectUrlRef.current = objectUrl;
      setPlaybackSource({
        kind: "audio",
        title: submittedFile.name,
        url: objectUrl,
      });
      return;
    }

    if (submittedSourceType === "youtube") {
      const videoId = extractYouTubeVideoId(submittedYoutubeUrl);
      if (!videoId) {
        setPlaybackSource(null);
        throw new Error("Could not read the YouTube video id for playback.");
      }

      setPlaybackSource({
        kind: "youtube",
        title: submittedYoutubeUrl,
        url: submittedYoutubeUrl,
        videoId,
      });
    }
  }

  const handlePlayerTimeChange = useCallback((time: number) => {
    setAudioCurrentTime((current) => (Math.abs(current - time) >= 0.008 ? time : current));
  }, []);

  const handleScoreSeek = useCallback((time: number) => {
    playerRef.current?.seekTo(time);
    setAudioCurrentTime(time);
  }, []);

  return (
    <main className="page">
      <div className="shell">
        <div className="topbar">
          <div>
            <h1 className="title">Beatly Drum Sheet</h1>
            <p className="subtitle">
              Upload audio or paste a YouTube link to generate a synchronized drum score.
            </p>
          </div>
        </div>

        <form className="upload-panel" onSubmit={onSubmit}>
          <div className="source-toggle" aria-label="Audio source">
            <button
              className={sourceType === "upload" ? "source-button active" : "source-button"}
              disabled={isLoading}
              onClick={() => setSourceType("upload")}
              type="button"
            >
              MP3 upload
            </button>
            <button
              className={sourceType === "youtube" ? "source-button active" : "source-button"}
              disabled={isLoading}
              onClick={() => setSourceType("youtube")}
              type="button"
            >
              YouTube link
            </button>
          </div>
          <div className="controls">
            {sourceType === "upload" ? (
              <input
                className="file-input"
                type="file"
                accept="audio/mpeg,audio/mp3,audio/wav,audio/flac,audio/mp4"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            ) : (
              <input
                className="text-input"
                disabled={isLoading}
                onChange={(event) => setYoutubeUrl(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                type="url"
                value={youtubeUrl}
              />
            )}
            <button className="button" disabled={isLoading} type="submit">
              {isLoading ? "Analyzing..." : "Generate Score"}
            </button>
            <button
              className={showLyrics ? "source-button active" : "source-button"}
              onClick={() => setShowLyrics((current) => !current)}
              type="button"
            >
              {showLyrics ? "Hide Lyrics" : "Show Lyrics"}
            </button>
          </div>
          <label className="option-row">
            <input
              checked={enableLyrics}
              onChange={(event) => setEnableLyrics(event.target.checked)}
              type="checkbox"
            />
            <span>
              {sourceType === "youtube"
                ? "Use YouTube captions when available; otherwise use Whisper."
                : "Extract Korean lyrics with Whisper. Slower on CPU."}
            </span>
          </label>
          {statusText ? <div className="status">{statusText}</div> : null}
          {error ? <div className="error">{error}</div> : null}
        </form>

        {score ? (
          <>
            <div className="meta">
              <span className="pill">BPM {Math.round(score.bpm)}</span>
              <span className="pill">Drum events {score.events.length}</span>
              <span className="pill">Words {score.words.length}</span>
            </div>
            {playbackSource ? (
              <SynchronizedScorePlayer
                ref={playerRef}
                currentTime={audioCurrentTime}
                onTimeChange={handlePlayerTimeChange}
                score={score}
                source={playbackSource}
              />
            ) : null}
            <DrumSheet
              audioCurrentTime={audioCurrentTime}
              onSeek={handleScoreSeek}
              score={score}
              showLyrics={showLyrics}
            />
          </>
        ) : (
          <div className="empty">No score generated yet.</div>
        )}
      </div>
    </main>
  );
}

function extractYouTubeVideoId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] ?? null;
    }

    const queryId = url.searchParams.get("v");
    if (queryId) {
      return queryId;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const embedIndex = parts.findIndex((part) => part === "embed" || part === "shorts" || part === "live");
    if (embedIndex >= 0) {
      return parts[embedIndex + 1] ?? null;
    }
  } catch {
    return null;
  }

  return null;
}

function formatJobStatus(status: string, detail?: string | null): string {
  if (status === "queued") {
    return detail ?? "Queued for analysis.";
  }
  if (status === "running") {
    return detail ?? "Analyzing audio. This can take several minutes when lyrics are enabled.";
  }
  if (status === "succeeded") {
    return "Analysis finished.";
  }
  if (status === "failed") {
    return detail ?? "Analysis failed.";
  }
  return detail ?? "Working.";
}
