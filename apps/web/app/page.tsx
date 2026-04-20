"use client";

import { useState } from "react";
import { DrumSheet } from "@/components/DrumSheet";
import { analyzeAudio, analyzeYouTube } from "@/lib/api";
import type { AnalysisJobStatus, AnalysisResult } from "@/lib/types";

type SourceType = "upload" | "youtube";

export default function Home() {
  const [sourceType, setSourceType] = useState<SourceType>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [score, setScore] = useState<AnalysisResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [enableLyrics, setEnableLyrics] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sourceType === "upload" && !file) {
      setError("Choose an MP3, WAV, M4A, or FLAC file.");
      return;
    }
    if (sourceType === "youtube" && !youtubeUrl.trim()) {
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
        sourceType === "youtube"
          ? await analyzeYouTube(youtubeUrl.trim(), options)
          : await analyzeAudio(file as File, options);
      setScore(result);
      setStatusText(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Analysis failed.");
    } finally {
      setIsLoading(false);
    }
  }

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
            <DrumSheet score={score} />
          </>
        ) : (
          <div className="empty">No score generated yet.</div>
        )}
      </div>
    </main>
  );
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
