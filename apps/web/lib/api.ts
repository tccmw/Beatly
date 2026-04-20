import type { AnalysisJobStatus, AnalysisResult } from "./types";

const ANALYZE_JOBS_URL = process.env.NEXT_PUBLIC_ANALYZE_JOBS_URL ?? "/api/analyze/jobs";
const POLL_INTERVAL_MS = 2000;
const MAX_JOB_WAIT_MS = 60 * 60 * 1000;

export type AnalyzeOptions = {
  enableLyrics?: boolean;
  onStatus?: (job: AnalysisJobStatus) => void;
};

export async function analyzeAudio(file: File, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const formData = new FormData();
  formData.append("file", file);
  if (options.enableLyrics !== undefined) {
    formData.append("enable_lyrics", String(options.enableLyrics));
  }

  const response = await fetch(ANALYZE_JOBS_URL, {
    method: "POST",
    body: formData,
  });

  await throwIfNotOk(response, "Could not start analysis.");

  const job = (await response.json()) as AnalysisJobStatus;
  options.onStatus?.(job);

  return pollAnalysisJob(job.job_id, options);
}

async function pollAnalysisJob(jobId: string, options: AnalyzeOptions): Promise<AnalysisResult> {
  const deadline = Date.now() + MAX_JOB_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const response = await fetch(`${ANALYZE_JOBS_URL}/${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    });
    await throwIfNotOk(response, "Could not read analysis status.");

    const job = (await response.json()) as AnalysisJobStatus;
    options.onStatus?.(job);

    if (job.status === "succeeded" && job.result) {
      return job.result;
    }

    if (job.status === "failed") {
      throw new Error(job.detail ?? "Analysis failed.");
    }
  }

  throw new Error("Analysis is still running after 60 minutes. Try again with lyrics disabled.");
}

async function throwIfNotOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.ok) {
    return;
  }

  let message = fallbackMessage;
  try {
    const payload = (await response.json()) as { detail?: string };
    message = payload.detail ?? message;
  } catch {
    message = response.statusText || message;
  }
  throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
