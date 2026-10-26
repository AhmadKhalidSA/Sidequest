"""Turn dropped files and pasted links into text the tutor can read.

Claude reads PDFs, images, Markdown and text directly. Office files, EPUBs
and web pages get a Markdown copy next to the original; a YouTube link
becomes a timestamped transcript."""

from __future__ import annotations

import html
import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path

CONVERTIBLE = {".docx", ".pptx", ".xlsx", ".epub", ".html", ".htm"}
YOUTUBE = re.compile(r"(?:youtube\.com/(?:watch\?v=|shorts/|live/|embed/)|"
                     r"youtu\.be/)([\w-]{11})")


class _Text(HTMLParser):
    """HTML to plain text with headings and paragraphs kept apart."""
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
             "section", "article", "blockquote", "pre"}

    def __init__(self) -> None:
        super().__init__()
        self.out: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "nav", "footer", "head"):
            self.skip += 1
        elif tag in ("h1", "h2", "h3"):
            self.out.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.out.append("\n- ")
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "nav", "footer", "head"):
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)

    def text(self) -> str:
        return re.sub(r"\n{3,}", "\n\n", "".join(self.out)).strip()


def html_text(markup: str) -> str:
    p = _Text()
    p.feed(markup)
    return html.unescape(p.text())


def _docx(path: Path) -> str:
    import mammoth
    with path.open("rb") as f:
        return mammoth.convert_to_markdown(f).value


def _pptx(path: Path) -> str:
    from pptx import Presentation
    parts = []
    for i, slide in enumerate(Presentation(str(path)).slides, 1):
        title = slide.shapes.title.text if slide.shapes.title else ""
        parts.append(f"## Slide {i}: {title}".rstrip(": "))
        for shape in slide.shapes:
            if shape.has_text_frame and shape != slide.shapes.title:
                for para in shape.text_frame.paragraphs:
                    line = "".join(r.text for r in para.runs).strip()
                    if line:
                        parts.append("  " * para.level + f"- {line}")
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                parts.append(f"Notes: {notes}")
    return "\n".join(parts)


def _xlsx(path: Path) -> str:
    from openpyxl import load_workbook
    parts = []
    for ws in load_workbook(str(path), read_only=True, data_only=True):
        parts.append(f"## Sheet: {ws.title}")
        for n, row in enumerate(ws.iter_rows(values_only=True)):
            if n >= 200:
                parts.append("(more rows not shown)")
                break
            cells = ["" if v is None else str(v) for v in row]
            if any(cells):
                parts.append("| " + " | ".join(cells) + " |")
    return "\n".join(parts)


def _epub(path: Path) -> str:
    parts = []
    with zipfile.ZipFile(path) as z:
        names = sorted(n for n in z.namelist()
                       if n.lower().endswith((".xhtml", ".html", ".htm")))
        for n in names:
            text = html_text(z.read(n).decode("utf-8", "replace"))
            if text:
                parts.append(text)
    return "\n\n".join(parts)


def convert(path: Path) -> Path | None:
    """Write <name>.md beside a convertible file; returns it, or None."""
    ext = path.suffix.lower()
    if ext not in CONVERTIBLE:
        return None
    if ext == ".docx":
        text = _docx(path)
    elif ext == ".pptx":
        text = _pptx(path)
    elif ext == ".xlsx":
        text = _xlsx(path)
    elif ext == ".epub":
        text = _epub(path)
    else:
        text = html_text(path.read_text(encoding="utf-8", errors="replace"))
    out = path.with_name(path.name + ".md")
    out.write_text(f"# {path.name}\n\n{text}\n", encoding="utf-8")
    return out


def youtube_ids(text: str) -> list[str]:
    return list(dict.fromkeys(YOUTUBE.findall(text)))


def youtube_transcript(video_id: str, folder: Path) -> Path:
    """Save a video's transcript (English or Arabic, whichever exists) as
    Markdown with a timestamp per line."""
    from youtube_transcript_api import YouTubeTranscriptApi
    api = YouTubeTranscriptApi()
    try:
        fetched = api.fetch(video_id, languages=["en", "ar"])
    except Exception:  # noqa: BLE001 — any language at all, then
        listing = api.list(video_id)
        fetched = next(iter(listing)).fetch()
    title = _video_title(video_id) or video_id
    lines = [f"# {title}", "", f"YouTube video {video_id}, transcript "
             f"({fetched.language}).", ""]
    for s in fetched:
        m, sec = divmod(int(s.start), 60)
        lines.append(f"[{m}:{sec:02d}] {s.text.strip()}")
    out = folder / f"youtube-{video_id}.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out


def _video_title(video_id: str) -> str:
    import requests
    try:
        r = requests.get("https://www.youtube.com/oembed", timeout=5,
                         params={"url": f"https://www.youtube.com/watch?v="
                                        f"{video_id}", "format": "json"})
        return r.json().get("title", "") if r.ok else ""
    except Exception:  # noqa: BLE001
        return ""
