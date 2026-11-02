"""Keyless media for the board: real photos, screenshots and diagrams from
Wikipedia lead images, Wikimedia Commons and Openverse (stills only, and
only if relevant), plus logos/icons from Iconify. No account, no API key; only the search words leave the machine.

Files are cached under <repo>/cache and handed to the overlay as
"../cache/<file>", a path that works both for the Electron page (file://)
and for the phone mirror (served at /cache/).
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import config

CACHE = config.ROOT / "cache"
# Wikimedia asks every client for a descriptive User-Agent.
UA = "Sidequest/0.2 (local study overlay; personal use)"
COMMONS = "https://commons.wikimedia.org/w/api.php"
SKIP_MIME = {"image/tiff", "image/vnd.djvu", "image/x-xcf"}
ICON_SETS = ["simple-icons", "logos", "devicon", "mdi", "tabler", "ph",
             "material-symbols", "carbon"]
BUDGET_S = 5.0   # an image that takes longer than this isn't worth waiting for


def log(*a) -> None:
    print(*a, file=sys.stderr, flush=True)


def _get(url: str, timeout: float = 4.0) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")


def _save(data: bytes, ext: str) -> str:
    CACHE.mkdir(exist_ok=True)
    name = hashlib.sha1(data).hexdigest()[:16] + ext
    path = CACHE / name
    if not path.exists():
        path.write_bytes(data)
    return f"../cache/{name}"


def _ext(content_type: str, url: str) -> str:
    for mime, ext in (("png", ".png"), ("jpeg", ".jpg"), ("gif", ".gif"),
                      ("svg", ".svg"), ("webp", ".webp")):
        if mime in content_type:
            return ext
    tail = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return tail if tail in {".png", ".jpg", ".jpeg", ".gif", ".svg",
                            ".webp"} else ".img"


WIKIPEDIA = "https://en.wikipedia.org/w/api.php"
GENERIC = {"animation", "animated", "gif", "diagram", "screenshot", "photo",
           "image", "picture", "illustration", "of", "the", "a", "an", "and",
           "in", "on", "for", "with", "how", "what", "real", "example"}


def _words(text: str) -> set[str]:
    """Lower-case content words, crudely singularised, for relevance checks."""
    out = set()
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        if len(w) < 3 or w in GENERIC:
            continue
        out.add(w[:-1] if w.endswith("s") and len(w) > 4 else w)
    return out


def _relevant(title: str, query: str) -> bool:
    """A file is only shown if its name shares the query's key words: one for
    a one- or two-word query, two for longer ones. This is what stops a
    search for "pricing strategy" returning a random restaurant photo."""
    q = _words(query)
    if not q:
        return False
    hits = len(q & _words(title))
    return hits >= (1 if len(q) <= 2 else 2)


def _wikipedia(query: str) -> tuple[str, str] | None:
    """The lead image of the best-matching Wikipedia article: chosen by an
    editor to represent the subject, so almost always on-topic."""
    params = {
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": query, "gsrlimit": "3", "prop": "pageimages",
        "piprop": "thumbnail", "pithumbsize": "960", "pilicense": "any",
    }
    data, _ = _get(f"{WIKIPEDIA}?{urllib.parse.urlencode(params)}")
    pages = json.loads(data).get("query", {}).get("pages", {}).values()
    for page in sorted(pages, key=lambda p: p.get("index", 99)):
        thumb = (page.get("thumbnail") or {}).get("source")
        title = page.get("title", "")
        if not thumb or not _relevant(title, query):
            continue
        if thumb.lower().endswith(".gif") or ".gif/" in thumb.lower():
            continue  # stills only
        return thumb, f"{title} (Wikipedia)"
    return None


def _commons(query: str) -> tuple[str, str] | None:
    params = {
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": query, "gsrnamespace": "6", "gsrlimit": "10",
        "prop": "imageinfo", "iiprop": "url|mime",
        "iiurlwidth": "960",   # a standard width (others get throttled)
    }
    data, _ = _get(f"{COMMONS}?{urllib.parse.urlencode(params)}")
    pages = json.loads(data).get("query", {}).get("pages", {}).values()
    for page in sorted(pages, key=lambda p: p.get("index", 99)):
        info = (page.get("imageinfo") or [{}])[0]
        mime = info.get("mime", "")
        if (not mime.startswith("image/") or mime in SKIP_MIME
                or mime == "image/gif"):
            continue  # stills only
        title = page.get("title", "").removeprefix("File:")
        if not _relevant(title, query):
            continue
        url = info.get("thumburl") or info.get("url")
        if url:
            return url, f"{title} (Wikimedia Commons)"
    return None


def _openverse(query: str) -> tuple[str, str] | None:
    q = urllib.parse.urlencode({"q": query, "page_size": "8"})
    data, _ = _get(f"https://api.openverse.org/v1/images/?{q}")
    for r in json.loads(data).get("results", []):
        url = r.get("thumbnail") or r.get("url")
        title = r.get("title", "")
        if url and str(r.get("filetype", "")).lower() != "gif"                 and _relevant(title, query):
            return url, f"{title} ({r.get('license', 'cc')}, Openverse)"
    return None


def _relaxed(query: str) -> list[str]:
    """The query, then its first few meaningful words: a very specific
    search often misses where a plainer one hits. At most three tries, so a
    miss stays cheap (each try is a network round trip, and Wikimedia
    throttles busy clients)."""
    words = query.split()
    core = [w for w in words if w.lower() not in GENERIC]
    out = [" ".join(words[:6]), " ".join(core[:3]), " ".join(core[:2])]
    return list(dict.fromkeys(q for q in out if q))[:3]


def find_image(query: str) -> dict | None:
    """A relevant real still (photo, screenshot, diagram) -> {"src","credit"}
    or None. Wikipedia's lead image first, then Commons, then Openverse;
    anything whose title doesn't match the query is skipped. Better no
    picture than an unrelated one."""
    deadline = time.monotonic() + BUDGET_S
    for q in _relaxed(query):
        for source in (_wikipedia, _commons, _openverse):
            if time.monotonic() > deadline:
                log(f"image search for {query!r} ran out of time")
                return None
            try:
                hit = source(q)
            except Exception as e:  # noqa: BLE001 — try the next source
                log(f"image search via {source.__name__} failed for {q!r}: {e}")
                continue
            if not hit:
                continue
            url, credit = hit
            try:
                data, ctype = _get(url, timeout=8)
            except Exception as e:  # noqa: BLE001
                log(f"download failed {url}: {e}")
                continue
            return {"src": _save(data, _ext(ctype, url)), "credit": credit}
    return None


def find_icon(name: str, color: str = "#EEF1F7") -> dict | None:
    """Logo or icon by name ("wireshark", "router", or "mdi:router")."""
    try:
        if ":" in name:
            icon = name
        else:
            q = urllib.parse.urlencode({"query": name, "limit": "32"})
            data, _ = _get(f"https://api.iconify.design/search?{q}")
            icons = json.loads(data).get("icons", [])
            if not icons:
                return None
            rank = {s: i for i, s in enumerate(ICON_SETS)}
            icons.sort(key=lambda n: rank.get(n.split(":")[0], 99))
            icon = icons[0]
        prefix, _, body = icon.partition(":")
        c = urllib.parse.quote(color)
        svg, _ = _get(f"https://api.iconify.design/{prefix}/{body}.svg"
                      f"?color={c}&height=128")
        return {"src": _save(svg, ".svg"), "credit": icon}
    except Exception as e:  # noqa: BLE001
        log(f"icon lookup failed for {name!r}: {e}")
        return None


# ------------------------------------------------------------- kids stickers
# Kids-mode ops (sticker, stickers, pick, story, frame) name their pictures by
# emoji character. The board can draw the character itself (Windows' own
# emoji font, no network); when the engine resolves it here first, the
# picture becomes Microsoft's Fluent Emoji in colour (MIT licence), fetched
# once from Iconify and cached under cache/stickers.
STICKER_SET = "fluent-emoji"
STICKER_DIR = CACHE / "stickers"
_sticker_names: list[str] | None = None
# Emoji whose Unicode name is far from their everyday (CLDR) name.
STICKER_ALIASES = {"❤": "red-heart", "😀": "grinning-face",
                   "😃": "grinning-face-with-big-eyes",
                   "😄": "grinning-face-with-smiling-eyes",
                   "🌟": "glowing-star", "⭐": "star"}
KIDS_MEDIA_OPS = {"sticker", "stickers", "pick", "story", "frame"}


def _sticker_index() -> list[str]:
    """Every icon name in the set (kebab-case CLDR names: "red-apple"),
    fetched once and kept on disk."""
    global _sticker_names
    if _sticker_names is not None:
        return _sticker_names
    path = STICKER_DIR / f"{STICKER_SET}-names.json"
    try:
        _sticker_names = json.loads(path.read_text("utf-8"))
        return _sticker_names
    except (OSError, ValueError):
        pass
    data, _ = _get(f"https://api.iconify.design/collection?prefix={STICKER_SET}")
    info = json.loads(data)
    names = list(info.get("uncategorized", []))
    for group in (info.get("categories") or {}).values():
        names.extend(group)
    names.extend((info.get("aliases") or {}).keys())
    _sticker_names = sorted(set(names))
    STICKER_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_sticker_names), "utf-8")
    return _sticker_names


def _emoji_words(emoji: str) -> list[str]:
    """Unicode names of the emoji's characters as words ("LION FACE" ->
    ["lion", "face"]), skipping joiners, variation selectors and skin tones."""
    import unicodedata
    words: list[str] = []
    for ch in emoji:
        cp = ord(ch)
        if cp in (0x200D, 0xFE0F, 0xFE0E) or 0x1F3FB <= cp <= 0x1F3FF:
            continue
        name = unicodedata.name(ch, "")
        words += [w for w in re.split(r"[\s-]+", name.lower()) if w]
    return words


def sticker_name(emoji: str = "", name: str = "") -> str | None:
    """Best icon in the set for an emoji character or an English name."""
    names = _sticker_index()
    have = set(names)
    base = emoji.replace("️", "")
    if not name and base in STICKER_ALIASES:
        return STICKER_ALIASES[base]
    words = [w for w in re.split(r"[\s_-]+", name.lower()) if w] or _emoji_words(emoji)
    if not words:
        return None
    noise = {"face", "with", "symbol", "sign", "black", "white", "medium",
             "small", "large", "emoji", "of"}
    tries = ["-".join(words), "-".join(w for w in words if w not in noise),
             words[-1], words[0]]
    for t in tries:
        if t and t in have:
            return t
    # Closest by shared words ("earth globe europe-africa" ->
    # "globe-showing-europe-africa"), shorter names first on a tie.
    want = set(words) - noise or set(words)
    best, score = None, 0.0
    for n in names:
        parts = set(n.split("-"))
        hit = len(want & parts)
        if not hit:
            continue
        s = hit / len(want | parts)
        if s > score or (s == score and best and len(n) < len(best)):
            best, score = n, s
    return best if score >= 0.34 else None


def find_sticker(emoji: str = "", name: str = "") -> dict | None:
    """A colour Fluent Emoji picture for an emoji (or English name) ->
    {"src"} or None (the board then draws the emoji character itself)."""
    try:
        icon = sticker_name(emoji, name)
        if not icon:
            return None
        path = STICKER_DIR / f"{icon}.svg"
        if not path.exists():
            svg, _ = _get(f"https://api.iconify.design/{STICKER_SET}/{icon}.svg?height=256")
            STICKER_DIR.mkdir(parents=True, exist_ok=True)
            path.write_bytes(svg)
        return {"src": f"../cache/stickers/{icon}.svg"}
    except Exception as e:  # noqa: BLE001 — the emoji character still shows
        log(f"sticker lookup failed for {emoji or name!r}: {e}")
        return None


def resolve_stickers(cmd: dict) -> dict:
    """Fill in "src" for every picture in a kids-mode op, in place. Call it
    off the event loop (it may fetch). Anything not found keeps its emoji,
    which the board draws as text."""
    def one(item: dict) -> None:
        if isinstance(item, dict) and item.get("emoji") and not item.get("src"):
            hit = find_sticker(str(item["emoji"]), str(item.get("name") or ""))
            if hit:
                item["src"] = hit["src"]

    def many(c: dict) -> None:
        pics = c.get("emoji")
        if isinstance(pics, list):
            srcs = []
            for p in pics:
                hit = find_sticker(str(p)) if p else None
                srcs.append(hit["src"] if hit else "")
            c["srcs"] = srcs
        else:
            one(c)

    op = cmd.get("op")
    if op == "sticker":
        one(cmd)
    elif op in ("stickers", "pick"):
        for it in cmd.get("items") or cmd.get("choices") or []:
            one(it)
    elif op == "frame":
        many(cmd)
    elif op == "story":
        for fr in cmd.get("frames") or []:
            if isinstance(fr, dict):
                many(fr)
    return cmd
