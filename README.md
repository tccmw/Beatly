# Beatly

Beatly is a monorepo for turning an uploaded MP3 into a drummer-friendly sheet
with synchronized lyrics.

## Apps

- `apps/api`: FastAPI backend. Separates drums with Demucs, analyzes drum hits
  with librosa, transcribes lyrics with Whisper, and returns a merged JSON score.
- `apps/web`: Next.js frontend. Uploads MP3 files and renders drum notation with
  VexFlow plus beat-aligned lyrics.

## Quick Start

```powershell
docker compose up --build
```

Then open:

- Web: http://localhost:3000
- API docs: http://localhost:8000/docs

## API Shape

`POST /analyze` accepts `multipart/form-data` with a `file` field and returns:

```json
{
  "bpm": 112,
  "events": [
    { "time": 0.5, "note": "kick", "lyric": "Hello", "confidence": 0.82 }
  ],
  "words": [
    { "word": "Hello", "start": 0.48, "end": 0.8 }
  ],
  "ticks_per_quarter": 480,
  "midi_ticks": [
    {
      "tick": 480,
      "duration_ticks": 120,
      "measure": 1,
      "slot": 4,
      "voice": 2,
      "midi_note": 36,
      "drum": "kick",
      "staff_key": "f/4",
      "notehead": "normal",
      "articulation": "none",
      "lyric": "Hello",
      "confidence": 0.82
    }
  ],
  "engraved_measures": [
    {
      "measure": 1,
      "voice1": [
        { "slot": 0, "duration": "8", "duration_ticks": 240, "rest": false, "voice": 1, "events": [] }
      ],
      "voice2": [
        { "slot": 0, "duration": "q", "duration_ticks": 480, "rest": true, "voice": 2, "events": [] }
      ]
    }
  ]
}
```

## Project Harness

The project contract lives in `harness/PROJECT_HARNESS.md`. It captures the
ultimate goal, notation rules, hard constraints, and technical pipeline for
producing drummer-ready sheets with synchronized lyrics.

Run the executable quality harness from the repository root:

```powershell
py -3 harness\beatly_quality_harness.py
# or, if Python is installed as `python`:
python harness\beatly_quality_harness.py
```

The harness checks PAS drum mapping, voice separation, 16th-note quantization,
lyric-slot preservation, playable hand/bass constraints, and Whisper model
caching expectations.

## Notes

The backend contains the production hooks for Demucs and Whisper, but those
models are large. Korean lyric extraction defaults to Demucs stem separation
and Whisper `large-v3-turbo` to avoid the very slow CPU runtime of full
`large-v3` while keeping stronger Korean transcription than `tiny`/`base`.
Set `WHISPER_MODEL=small` or `WHISPER_MODEL=medium` for faster local tests, and
use `WHISPER_MODEL=large-v3` only when maximum lyric accuracy is worth the
extra runtime. Set `BEATLY_USE_STUBS=true` for fast development without model
downloads. Docker defaults to real processing. Whisper is loaded and cached on
the first lyric request; set `BEATLY_PRELOAD_WHISPER=true` to load it during API
startup instead.

For local frontend-only development:

```powershell
npm install
npm --workspace apps/web run dev
```

For backend-only development, create a Python 3.11 environment and run:

```powershell
pip install -r apps/api/requirements.txt
$env:BEATLY_USE_STUBS="true"
uvicorn app.main:app --app-dir apps/api --reload
```
