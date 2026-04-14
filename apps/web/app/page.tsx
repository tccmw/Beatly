"use client";

import { useState } from "react";
import { DrumSheet } from "@/components/DrumSheet";
import { analyzeAudio } from "@/lib/api";
import type { AnalysisResult } from "@/lib/types";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [score, setScore] = useState<AnalysisResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("MP3 파일을 선택해 주세요.");
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      setScore(await analyzeAudio(file));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "분석 중 오류가 발생했습니다.");
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
              MP3를 업로드하면 드럼 파트와 가사를 분석해 연주용 5선보와 박자별 가사 위치를 만듭니다.
            </p>
          </div>
        </div>

        <form className="upload-panel" onSubmit={onSubmit}>
          <div className="controls">
            <input
              className="file-input"
              type="file"
              accept="audio/mpeg,audio/mp3,audio/wav,audio/flac,audio/mp4"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <button className="button" disabled={isLoading} type="submit">
              {isLoading ? "분석 중..." : "악보 생성"}
            </button>
          </div>
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
          <div className="empty">아직 생성된 악보가 없습니다.</div>
        )}
      </div>
    </main>
  );
}
