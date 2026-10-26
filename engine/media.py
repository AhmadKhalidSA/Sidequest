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
