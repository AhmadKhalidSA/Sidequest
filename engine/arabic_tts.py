"""Arabic voice: Supertonic 3 (Supertone Inc.), four small ONNX graphs, CPU.

Model:  https://huggingface.co/Supertone/supertonic-3  (weights: OpenRAIL-M;
        the inference steps below follow Supertone's MIT-licensed sample code)
Files:  <models>/supertonic-3/onnx/{duration_predictor,text_encoder,
        vector_estimator,vocoder}.onnx, tts.json, unicode_indexer.json and
        voice_styles/{F1..F5,M1..M5}.json  (setup.ps1 downloads them, ~400 MB)

It reads raw Unicode characters (no phonemizer, no espeak), 31 languages, five
female (F1-F5) and five male (M1-M5) preset voices. Arabic short vowels come
from the diacritics (tashkeel) when the text has them; without them the model
guesses, which is right for common words and shaky for rare words, names and
grammatical endings. Output is 44.1 kHz; synth() returns float32 at 24 kHz.
"""

from __future__ import annotations

import json
import re
import sys
import threading
import unicodedata
import zlib
from pathlib import Path

import numpy as np

OUT_RATE = 24_000
BASE_SPEED = 1.05          # Supertone's default pace; TTS speed multiplies it
DEFAULT_STEPS = 5          # flow-matching steps: 5 is their default, 8 = finer
MAX_CHUNK = 300            # characters per model call (longer text is split)


def log(*a) -> None:
    print(*a, file=sys.stderr, flush=True)


# Arabic tidy-ups the model's character set doesn't cover.
_AR_FIX = str.maketrans({
    "\u061b": "\u060c",    # Arabic semicolon -> Arabic comma
    "\u0671": "\u0627",    # alef wasla -> alef
    "\u0640": None,        # tatweel (kashida) is only typography
    "\u066b": ".",         # Arabic decimal separator
    "\u066c": ",",         # Arabic thousands separator
    "\u06d4": ".",         # Urdu full stop
})
_QURANIC = re.compile("[\u0610-\u061a\u06d6-\u06ed]")   # recitation marks
_EMOJI = re.compile(
    "[\U0001f300-\U0001faff\u2600-\u27bf\U0001f1e6-\U0001f1ff\ufe0f]+")
_SYMBOLS = {"\u2013": "-", "\u2011": "-", "\u2014": "-", "_": " ",
            "\u201c": '"', "\u201d": '"', "\u2018": "'", "\u2019": "'",
            "\u00b4": "'", "`": "'", "[": " ", "]": " ", "|": " ", "/": " ",
            "#": " ", "\u2192": " ", "\u2190": " ", "*": " ", "~": " ",
            "\u00ab": '"', "\u00bb": '"', "<": " ", ">": " "}
_END = re.compile(r"[.!?;:,'\")\]}\u2026\u060c\u061f]$")
_SENT = re.compile(r"(?<=[.!?\u061f])\s+")


def _rng_for(text: str, voice: str) -> np.random.Generator:
    # Same line + voice = same audio, so a repeat sounds like a repeat.
    return np.random.default_rng(zlib.crc32(f"{voice}|{text}".encode()))


def resample(x: np.ndarray, src: int, dst: int) -> np.ndarray:
    """Band-limited resampling by FFT (exact low-pass, no extra package)."""
    if src == dst or len(x) == 0:
        return x.astype(np.float32)
    pad = 2048                      # keep the circular wrap away from speech
    xp = np.concatenate([x, np.zeros(pad, np.float32)])
    n_out = int(round(len(xp) * dst / src))
    spec = np.fft.rfft(xp)
    y = np.fft.irfft(spec[: n_out // 2 + 1], n_out) * (n_out / len(xp))
    return y[: int(round(len(x) * dst / src))].astype(np.float32)


# ------------------------------------------------------------ numbers
# The model reads digits in an Arabic line as English ("3" -> "three"), so
# they are spelled out first, in the form people say them in modern MSA
# (pausal, -een endings: "ألفين وستة وعشرين").
_ONES = ["صفر", "واحد", "اثنين", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة",
         "ثمانية", "تسعة", "عشرة", "أحد عشر", "اثنا عشر"]
_TENS = ["", "", "عشرين", "ثلاثين", "أربعين", "خمسين", "ستين", "سبعين",
         "ثمانين", "تسعين"]
_HUNDREDS = ["", "مئة", "مئتين", "ثلاثمئة", "أربعمئة", "خمسمئة", "ستمئة",
             "سبعمئة", "ثمانمئة", "تسعمئة"]
_SCALES = [(10 ** 9, "مليار", "مليارين", "مليارات"),
           (10 ** 6, "مليون", "مليونين", "ملايين"),
           (1000, "ألف", "ألفين", "آلاف")]


def _below_1000(n: int) -> str:
    parts = []
    if n >= 100:
        parts.append(_HUNDREDS[n // 100])
        n %= 100
    if n:
        if n <= 12:
            parts.append(_ONES[n])
        elif n < 20:
            parts.append(f"{_ONES[n - 10]} عشر")
        elif n % 10:
            parts.append(f"{_ONES[n % 10]} و{_TENS[n // 10]}")
        else:
            parts.append(_TENS[n // 10])
    return " و".join(parts)


def number_words(n: int) -> str:
    """Arabic words for a whole number (spoken MSA style)."""
    if n == 0:
        return _ONES[0]
    if n < 0:
        return "سالب " + number_words(-n)
    parts = []
    for size, one, two, few in _SCALES:
        k, n = divmod(n, size)
        if not k:
            continue
        if k == 1:
            parts.append(one)
        elif k == 2:
            parts.append(two)
        elif k <= 10:
            parts.append(f"{_below_1000(k)} {few}")
        else:
            parts.append(f"{number_words(k)} {one}")
    if n:
        parts.append(_below_1000(n))
    return " و".join(parts)


_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")


def spell_numbers(text: str) -> str:
    """Digits -> Arabic words: 2026, 3.5, 10:30, 50%."""
    text = text.translate(_DIGITS)
    text = re.sub(r"\b\d{1,3}(?:,\d{3})+\b",       # 1,000,000
                  lambda m: m[0].replace(",", ""), text)
    text = re.sub(r"(\d+):(\d\d)\b", lambda m: f"{number_words(int(m[1]))} "
                  f"و{number_words(int(m[2]))}", text)
    text = re.sub(r"(\d+)[.٫](\d+)", lambda m: f"{number_words(int(m[1]))} "
                  f"فاصلة {number_words(int(m[2]))}", text)
    text = re.sub(r"\d+", lambda m: number_words(int(m[0][:12])), text)
    return text.replace("%", " بالمئة")


class Supertonic:
    """Thread-safe enough for one TTS worker: a lock around each synth."""

    def __init__(self, folder: Path, threads: int = 4,
                 steps: int = DEFAULT_STEPS) -> None:
        import onnxruntime as ort
        folder = Path(folder)
        onnx_dir = folder / "onnx"
        names = ("duration_predictor", "text_encoder", "vector_estimator",
                 "vocoder")
        missing = [n for n in names if not (onnx_dir / f"{n}.onnx").exists()]
        if missing or not (onnx_dir / "unicode_indexer.json").exists():
            raise FileNotFoundError(
                f"Supertonic 3 not found in {folder} (missing "
                f"{', '.join(missing) or 'unicode_indexer.json'}). "
                f"Run setup.ps1 to download it.")
        cfg = json.loads((onnx_dir / "tts.json").read_text(encoding="utf-8"))
        self.sample_rate = int(cfg["ae"]["sample_rate"])
        self._chunk = int(cfg["ae"]["base_chunk_size"]) * int(
            cfg["ttl"]["chunk_compress_factor"])
        self._ldim = int(cfg["ttl"]["latent_dim"]) * int(
            cfg["ttl"]["chunk_compress_factor"])
        idx = json.loads((onnx_dir / "unicode_indexer.json")
                         .read_text(encoding="utf-8"))
        self._index = np.asarray(idx, dtype=np.int64)
        so = ort.SessionOptions()
        so.intra_op_num_threads = max(1, int(threads))
        so.inter_op_num_threads = 1
        so.log_severity_level = 3
        prov = ["CPUExecutionProvider"]
        self._dp, self._enc, self._vec, self._voc = (
            ort.InferenceSession(str(onnx_dir / f"{n}.onnx"), sess_options=so,
                                 providers=prov) for n in names)
        self.steps = int(steps)
        self._style_dir = folder / "voice_styles"
        self.voices = sorted(p.stem for p in self._style_dir.glob("*.json"))
        if not self.voices:
            raise FileNotFoundError(f"no voice styles in {self._style_dir}")
        self._styles: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------ text
    def supported(self, ch: str) -> bool:
        o = ord(ch)
        return o < len(self._index) and self._index[o] >= 0

    def clean(self, text: str) -> str:
        """Normalise like Supertone's preprocessor, plus Arabic fixes, and
        drop characters the model has never seen (they'd crash it)."""
        text = unicodedata.normalize("NFKD", text)
        text = text.translate(_AR_FIX)
        # "الـ terminal" (article + English word) -> "الterminal"
        text = re.sub(r"(?<!\S)(ال)\s+(?=[A-Za-z])", r"\1", text)
        text = _QURANIC.sub("", text)
        text = _EMOJI.sub("", text)
        for k, v in _SYMBOLS.items():
            text = text.replace(k, v)
        text = re.sub(r"[\u2665\u2606\u2661\u00a9\\]", "", text)
        text = text.replace("@", " at ").replace("&", " and ")
        text = re.sub(r" ([,.!?;:\u060c\u061f])", r"\1", text)
        text = re.sub(r"([\"'])\1+", r"\1", text)
        text = "".join(c if self.supported(c) else " " for c in text)
        return re.sub(r"\s+", " ", text).strip()

    def _tagged(self, text: str, lang: str) -> str:
        """One language tag for the whole chunk. Embedded English words in an
        Arabic line ("computer", "Python") are read fine under <ar>; several
        <ar>..</ar><en>..</en> tags in one call garble the line."""
        if lang == "ar":
            text = spell_numbers(text)
        text = self.clean(text)
        if not text:
            return ""
        if not _END.search(text):
            text += "."
        return f"<{lang}>{text}</{lang}>"

    # ----------------------------------------------------------- voices
    def style(self, name: str) -> tuple[np.ndarray, np.ndarray]:
        if name not in self._styles:
            path = self._style_dir / f"{name}.json"
            if not path.exists():
                raise KeyError(f"no Supertonic voice {name!r}; "
                               f"have {', '.join(self.voices)}")
            d = json.loads(path.read_text(encoding="utf-8"))
            ttl = np.asarray(d["style_ttl"]["data"], np.float32).reshape(
                d["style_ttl"]["dims"])
            dp = np.asarray(d["style_dp"]["data"], np.float32).reshape(
                d["style_dp"]["dims"])
            self._styles[name] = (ttl, dp)
        return self._styles[name]

    # ------------------------------------------------------------ audio
    def _infer(self, tagged: str, voice: str, speed: float) -> np.ndarray:
        ids = self._index[np.frombuffer(tagged.encode("utf-16-le"),
                                        dtype=np.uint16)][None, :]
        mask = np.ones((1, 1, ids.shape[1]), np.float32)
        ttl, dp = self.style(voice)
        dur, *_ = self._dp.run(None, {"text_ids": ids, "style_dp": dp,
                                      "text_mask": mask})
        dur = dur / (BASE_SPEED * speed)
        emb, *_ = self._enc.run(None, {"text_ids": ids, "style_ttl": ttl,
                                       "text_mask": mask})
        n_wav = int(dur[0] * self.sample_rate)
        n_lat = max(1, (n_wav + self._chunk - 1) // self._chunk)
        rng = _rng_for(tagged, voice)
        xt = rng.standard_normal((1, self._ldim, n_lat)).astype(np.float32)
        lat_mask = np.ones((1, 1, n_lat), np.float32)
        total = np.array([self.steps], np.float32)
        for step in range(self.steps):
            xt, *_ = self._vec.run(None, {
                "noisy_latent": xt, "text_emb": emb, "style_ttl": ttl,
                "text_mask": mask, "latent_mask": lat_mask,
                "current_step": np.array([step], np.float32),
                "total_step": total})
        wav, *_ = self._voc.run(None, {"latent": xt})
        return np.asarray(wav, np.float32).reshape(-1)[:n_wav]

    def synth(self, text: str, voice: str = "F1", speed: float = 1.0,
              lang: str = "ar") -> np.ndarray:
        """Speak text in one voice. Returns float32 @ 24 kHz."""
        speed = min(2.0, max(0.7, float(speed)))
        out = []
        with self._lock:
            for chunk in _chunks(text):
                tagged = self._tagged(chunk, lang)
                if not tagged:
                    continue
                if out:
                    out.append(np.zeros(int(0.25 * self.sample_rate),
                                        np.float32))
                out.append(self._infer(tagged, voice, speed))
        if not out:
            return np.zeros(int(0.1 * OUT_RATE), np.float32)
        return resample(np.concatenate(out), self.sample_rate, OUT_RATE)


def _chunks(text: str) -> list[str]:
    """Model calls of <= MAX_CHUNK characters, split at sentence ends (a
    single huge sentence is cut at a space)."""
    pieces: list[str] = []
    for s in _SENT.split(text.strip()):
        while len(s) > MAX_CHUNK:
            cut = s.rfind(" ", 0, MAX_CHUNK)
            cut = cut if cut > 0 else MAX_CHUNK
            pieces.append(s[:cut])
            s = s[cut:].strip()
        if s:
            pieces.append(s)
    out: list[str] = []
    for piece in pieces:
        if out and len(out[-1]) + 1 + len(piece) <= MAX_CHUNK:
            out[-1] += " " + piece
        else:
            out.append(piece)
    return out
