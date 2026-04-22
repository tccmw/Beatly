"use client";

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function Error({ error, reset }: Props) {
  return (
    <main className="page">
      <div className="shell">
        <div className="upload-panel">
          <div className="error">Client error: {error.message || "Unknown client-side exception."}</div>
          {error.digest ? <div className="status">Digest: {error.digest}</div> : null}
          <button className="button" onClick={reset} type="button">
            Retry
          </button>
        </div>
      </div>
    </main>
  );
}
