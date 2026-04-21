from __future__ import annotations

import hashlib
import html
import json
import logging
import re
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.request import Request, urlopen

from app.models import LyricWord

logger = logging.getLogger("uvicorn.error")

CAPTION_MIN_DURATION_SECONDS = 0.1
CAPTION_LAYOUT_VERSION = "youtube-whisper-alignment-v2"
CAPTION_ROLLING_OVERLAP_SECONDS = 0.75
CAPTION_DOWNLOAD_CHUNK_BYTES = 1024 * 1024
CAPTION_DOWNLOAD_TIMEOUT_SECONDS = 60
CAPTION_FORMAT_PRIORITY = ("json3", "vtt", "srv3", "srv2", "srv1", "ttml", "xml")
CAPTION_LANGUAGE_PRIORITY = ("ko", "en")
USER_AGENT = "Beatly/0.1 (+https://localhost)"
YOUTUBE_HOST_PATTERN = re.compile(r"(youtube\.com|youtu\.be|music\.youtube\.com)", re.IGNORECASE)
VTT_TIME_PATTERN = re.compile(
    r"(?P<start>(?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+"
    r"(?P<end>(?:\d+:)?\d{2}:\d{2}\.\d{3})"
)


class YouTubeSourceError(RuntimeError):
    pass


@dataclass(frozen=True)
class YouTubeSource:
    audio_path: Path
    title: str
    webpage_url: str
    caption_words: list[LyricWord] | None
    caption_source: str | None
    lyric_cache_key: str | None


@dataclass(frozen=True)
class CaptionCue:
    start: float
    end: float
    text: str


def is_youtube_url(url: str) -> bool:
    return bool(YOUTUBE_HOST_PATTERN.search(url.strip()))


def prepare_youtube_source(
    youtube_url: str,
    output_dir: Path,
    fetch_captions: bool = True,
    progress: Callable[[str], None] | None = None,
) -> YouTubeSource:
    url = youtube_url.strip()
    if not is_youtube_url(url):
        raise YouTubeSourceError("Enter a valid YouTube URL.")

    output_dir.mkdir(parents=True, exist_ok=True)
    _report(progress, "Fetching YouTube metadata.")
    info = _extract_info(url)
    title = str(info.get("title") or info.get("id") or "YouTube audio")
    webpage_url = str(info.get("webpage_url") or url)

    caption_words: list[LyricWord] | None = None
    caption_source: str | None = None
    lyric_cache_key: str | None = None
    if fetch_captions:
        _report(progress, "Checking YouTube captions.")
        caption = _fetch_best_caption(info)
        if caption is not None:
            caption_source, caption_payload, caption_ext = caption
            cues = _parse_caption_payload(caption_payload, caption_ext)
            caption_words = _caption_cues_to_words(cues)
            if caption_words:
                lyric_cache_key = _caption_cache_key(caption_source, caption_payload)
                logger.info(
                    "youtube captions selected source=%s cues=%d words=%d",
                    caption_source,
                    len(cues),
                    len(caption_words),
                )
            else:
                caption_words = None
                caption_source = None

    _report(progress, "Downloading YouTube audio.")
    audio_path = _download_audio(url, output_dir)
    return YouTubeSource(
        audio_path=audio_path,
        title=title,
        webpage_url=webpage_url,
        caption_words=caption_words,
        caption_source=caption_source,
        lyric_cache_key=lyric_cache_key,
    )


def _extract_info(url: str) -> dict[str, Any]:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError

    options: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "listsubtitles": True,
        "noplaylist": True,
        "skip_download": True,
        "retries": 3,
        "fragment_retries": 3,
    }
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
    except DownloadError as exc:
        raise YouTubeSourceError(f"Could not read YouTube metadata: {exc}") from exc

    if not isinstance(info, dict):
        raise YouTubeSourceError("Could not read YouTube metadata.")
    return info


def _download_audio(url: str, output_dir: Path) -> Path:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError

    output_template = str(output_dir / "source.%(ext)s")
    options: dict[str, Any] = {
        "format": "bestaudio/best",
        "outtmpl": output_template,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
        "fragment_retries": 3,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
    }
    try:
        with YoutubeDL(options) as ydl:
            ydl.download([url])
    except DownloadError as exc:
        raise YouTubeSourceError(f"Could not download YouTube audio: {exc}") from exc

    audio_files = [
        path
        for path in output_dir.glob("source.*")
        if path.is_file() and path.suffix.lower() not in {".part", ".ytdl", ".json"}
    ]
    if not audio_files:
        raise YouTubeSourceError("YouTube audio download finished but no audio file was found.")
    return sorted(audio_files, key=lambda path: path.stat().st_mtime, reverse=True)[0]


def _fetch_best_caption(info: dict[str, Any]) -> tuple[str, str, str] | None:
    for source_kind, language, caption_format in _iter_caption_candidates(info):
        caption_url = str(caption_format.get("url") or "")
        caption_ext = str(caption_format.get("ext") or "").lower()
        if not caption_url:
            continue
        try:
            payload = _download_text(caption_url)
        except Exception:
            logger.exception(
                "Could not fetch YouTube caption source=%s language=%s format=%s; trying next format",
                source_kind,
                language,
                caption_ext,
            )
            continue
        cues = _parse_caption_payload(payload, caption_ext)
        if not cues:
            logger.warning(
                "YouTube caption source=%s language=%s format=%s had no parseable cues; trying next format",
                source_kind,
                language,
                caption_ext,
            )
            continue
        return f"{source_kind}:{language}", payload, caption_ext
    return None


def _iter_caption_candidates(info: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    official_tracks = info.get("subtitles") or {}
    automatic_tracks = info.get("automatic_captions") or {}
    candidates: list[tuple[str, str, dict[str, Any]]] = []
    candidates.extend(_caption_candidates_for_tracks("official", official_tracks))
    candidates.extend(_caption_candidates_for_tracks("auto", automatic_tracks))
    return candidates


def _caption_candidates_for_tracks(
    source_kind: str,
    tracks: dict[str, list[dict[str, Any]]],
) -> list[tuple[str, str, dict[str, Any]]]:
    candidates: list[tuple[str, str, dict[str, Any]]] = []
    for language in _ordered_caption_languages(tracks):
        for caption_format in _ordered_caption_formats(tracks.get(language) or []):
            candidates.append((source_kind, language, caption_format))
    return candidates


def _ordered_caption_languages(tracks: dict[str, list[dict[str, Any]]]) -> list[str]:
    languages = [language for language in tracks if _is_supported_caption_language(language)]
    return sorted(languages, key=_caption_language_rank)


def _is_supported_caption_language(language: str) -> bool:
    normalized = language.lower()
    return any(normalized == code or normalized.startswith(f"{code}-") for code in CAPTION_LANGUAGE_PRIORITY)


def _caption_language_rank(language: str) -> tuple[int, str]:
    normalized = language.lower()
    for index, code in enumerate(CAPTION_LANGUAGE_PRIORITY):
        if normalized == code or normalized.startswith(f"{code}-"):
            return index, normalized
    return len(CAPTION_LANGUAGE_PRIORITY), normalized


def _ordered_caption_formats(formats: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: dict[str, dict[str, Any]] = {}
    for caption_format in formats:
        key = str(caption_format.get("url") or id(caption_format))
        deduped.setdefault(key, caption_format)

    def format_rank(caption_format: dict[str, Any]) -> tuple[int, str]:
        ext = str(caption_format.get("ext") or "").lower()
        try:
            index = CAPTION_FORMAT_PRIORITY.index(ext)
        except ValueError:
            index = len(CAPTION_FORMAT_PRIORITY)
        return index, ext

    return sorted(deduped.values(), key=format_rank)


def _download_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    chunks: list[bytes] = []
    with urlopen(request, timeout=CAPTION_DOWNLOAD_TIMEOUT_SECONDS) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        while True:
            chunk = response.read(CAPTION_DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks).decode(charset, errors="replace")


def _parse_caption_payload(payload: str, caption_ext: str) -> list[CaptionCue]:
    if caption_ext == "json3" or payload.lstrip().startswith("{"):
        return _parse_json3_captions(payload)
    if caption_ext in {"srv1", "srv2", "srv3"} or payload.lstrip().startswith("<transcript"):
        return _parse_srv_captions(payload)
    if caption_ext in {"ttml", "xml"} or payload.lstrip().startswith("<tt"):
        return _parse_ttml_captions(payload)
    return _parse_vtt_captions(payload)


def _parse_json3_captions(payload: str) -> list[CaptionCue]:
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return []

    cues: list[CaptionCue] = []
    for event in data.get("events", []):
        segments = event.get("segs") or []
        text = "".join(str(segment.get("utf8", "")) for segment in segments)
        if not text.strip():
            continue
        start = float(event.get("tStartMs", 0)) / 1000
        duration = float(event.get("dDurationMs", 0)) / 1000
        end = start + max(duration, CAPTION_MIN_DURATION_SECONDS)
        cues.append(CaptionCue(start=start, end=end, text=text))
    return cues


def _parse_vtt_captions(payload: str) -> list[CaptionCue]:
    cues: list[CaptionCue] = []
    lines = payload.replace("\ufeff", "").splitlines()
    index = 0
    while index < len(lines):
        match = VTT_TIME_PATTERN.search(lines[index])
        if not match:
            index += 1
            continue
        start = _parse_vtt_time(match.group("start"))
        end = _parse_vtt_time(match.group("end"))
        index += 1
        text_lines: list[str] = []
        while index < len(lines) and lines[index].strip():
            text_lines.append(lines[index])
            index += 1
        text = " ".join(text_lines)
        if text.strip():
            cues.append(CaptionCue(start=start, end=max(end, start + CAPTION_MIN_DURATION_SECONDS), text=text))
    return cues


def _parse_srv_captions(payload: str) -> list[CaptionCue]:
    try:
        root = ET.fromstring(payload)
    except ET.ParseError:
        return []

    cues: list[CaptionCue] = []
    for element in root.iter():
        if _xml_tag_name(element.tag) != "text":
            continue
        raw_text = "".join(element.itertext())
        if not raw_text.strip():
            continue
        start = _xml_time_to_seconds(element.attrib.get("start", "0"))
        duration = _xml_time_to_seconds(element.attrib.get("dur", str(CAPTION_MIN_DURATION_SECONDS)))
        cues.append(CaptionCue(start=start, end=start + max(duration, CAPTION_MIN_DURATION_SECONDS), text=raw_text))
    return cues


def _parse_ttml_captions(payload: str) -> list[CaptionCue]:
    try:
        root = ET.fromstring(payload)
    except ET.ParseError:
        return []

    cues: list[CaptionCue] = []
    for element in root.iter():
        if _xml_tag_name(element.tag) != "p":
            continue
        raw_text = " ".join(text.strip() for text in element.itertext() if text.strip())
        if not raw_text:
            continue
        begin = _xml_time_to_seconds(element.attrib.get("begin", element.attrib.get("start", "0")))
        if "end" in element.attrib:
            end = _xml_time_to_seconds(element.attrib["end"])
        else:
            end = begin + _xml_time_to_seconds(element.attrib.get("dur", str(CAPTION_MIN_DURATION_SECONDS)))
        cues.append(CaptionCue(start=begin, end=max(end, begin + CAPTION_MIN_DURATION_SECONDS), text=raw_text))
    return cues


def _xml_tag_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _xml_time_to_seconds(value: str) -> float:
    raw = value.strip()
    if not raw:
        return 0.0
    if raw.endswith("ms"):
        return float(raw[:-2]) / 1000
    if raw.endswith("s"):
        return float(raw[:-1])
    if ":" in raw:
        return _parse_vtt_time(raw.replace(",", "."))
    return float(raw)


def _parse_vtt_time(value: str) -> float:
    parts = value.split(":")
    if len(parts) == 3:
        hours = int(parts[0])
        minutes = int(parts[1])
        seconds = float(parts[2])
    else:
        hours = 0
        minutes = int(parts[0])
        seconds = float(parts[1])
    return hours * 3600 + minutes * 60 + seconds


def _caption_cues_to_words(cues: list[CaptionCue]) -> list[LyricWord]:
    words: list[LyricWord] = []
    previous_text = ""
    previous_units: list[str] = []
    previous_end = 0.0
    for cue in cues:
        text = _clean_caption_text(cue.text)
        if not text:
            continue
        raw_units = _expand_caption_units(text)
        if text == previous_text:
            previous_units = raw_units
            previous_end = max(previous_end, cue.end)
            continue
        previous_text = text
        units = raw_units
        start_base = cue.start
        if cue.start <= previous_end + CAPTION_ROLLING_OVERLAP_SECONDS:
            units = _trim_rolling_caption_units(units, previous_units)
            if len(units) < len(raw_units):
                start_base = max(cue.start, previous_end)
        if not units:
            previous_units = raw_units
            previous_end = max(previous_end, cue.end)
            continue
        for unit in units:
            words.append(_lyric_word(unit, start_base, cue.end))
        previous_units = raw_units
        previous_end = max(previous_end, cue.end)
    return words


def _clean_caption_text(text: str) -> str:
    cleaned = html.unescape(text)
    cleaned = re.sub(r"<[^>]+>", " ", cleaned)
    cleaned = re.sub(r"\[[^\]]+\]|\([^\)]*(?:음악|music|applause|박수)[^\)]*\)", " ", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.replace("♪", " ").replace("♫", " ")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return unicodedata.normalize("NFC", cleaned.strip())


def _expand_caption_units(text: str) -> list[str]:
    units: list[str] = []
    buffer: list[str] = []

    def flush_buffer() -> None:
        if not buffer:
            return
        token = _strip_token("".join(buffer))
        if token:
            units.append(token)
        buffer.clear()

    for char in unicodedata.normalize("NFC", text):
        if _is_hangul_syllable(char):
            flush_buffer()
            units.append(char)
            continue
        if char.isspace() or unicodedata.category(char).startswith("P"):
            flush_buffer()
            continue
        buffer.append(char)

    flush_buffer()
    return units


def _trim_rolling_caption_units(units: list[str], previous_units: list[str]) -> list[str]:
    if not units or not previous_units:
        return units

    for start in range(0, len(previous_units) - len(units) + 1):
        if previous_units[start : start + len(units)] == units:
            return []

    max_overlap = min(len(units), len(previous_units))
    for size in range(max_overlap, 0, -1):
        if previous_units[-size:] == units[:size]:
            return units[size:]

    return units


def _strip_token(token: str) -> str:
    return unicodedata.normalize("NFC", token.strip(".,!?;:\"'()[]{}<>“”‘’"))


def _sanitize_word_timeline(words: list[LyricWord]) -> list[LyricWord]:
    sanitized: list[LyricWord] = []
    previous_end = 0.0
    for word in sorted(words, key=lambda item: (item.start, item.end)):
        text = unicodedata.normalize("NFC", word.word.strip())
        if not text:
            continue
        start = max(0.0, float(word.start))
        end = max(start + CAPTION_MIN_DURATION_SECONDS, float(word.end))
        if sanitized and start < previous_end:
            start = previous_end
            end = max(start + CAPTION_MIN_DURATION_SECONDS, end)
        sanitized.append(_lyric_word(text, start, end))
        previous_end = sanitized[-1].end
    return sanitized


def _lyric_word(word: str, start: float, end: float) -> LyricWord:
    safe_start = round(max(0.0, start), 3)
    safe_end = round(max(safe_start + CAPTION_MIN_DURATION_SECONDS, end), 3)
    return LyricWord(word=unicodedata.normalize("NFC", word.strip()), start=safe_start, end=safe_end)


def _is_hangul_syllable(char: str) -> bool:
    return 0xAC00 <= ord(char) <= 0xD7A3


def _caption_cache_key(caption_source: str, payload: str) -> str:
    digest = hashlib.sha256()
    digest.update(CAPTION_LAYOUT_VERSION.encode("utf-8"))
    digest.update(b"\0")
    digest.update(caption_source.encode("utf-8"))
    digest.update(b"\0")
    digest.update(payload.encode("utf-8"))
    return digest.hexdigest()


def _report(progress: Callable[[str], None] | None, detail: str) -> None:
    if progress is not None:
        progress(detail)
