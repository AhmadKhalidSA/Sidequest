"""Pronunciation scoring for English and Arabic, on the CPU.

score(audio16k, target, lang) -> {"score": 0-100,
                                  "words": [{"w", "ok", "sounds": [[ipa, ok]]}],
                                  "heard": "<the sounds the model heard, IPA>"}

How: a phoneme recogniser (facebook/wav2vec2-lv-60-espeak-cv-ft, Apache-2.0:
wav2vec2 fine-tuned on Common Voice in ~40 languages to output espeak-style
IPA; run as onnx-community's 4-bit ONNX export by onnxruntime) writes down
the sounds you made. espeak-ng (via phonemizer, the same G2P Kokoro uses)
writes the sounds the target text should have, word by word. A weighted edit
distance lines the two up, and each expected sound is marked heard (True) or
missed/replaced (False).

Lenient on purpose: notation variants (ɹ/r/ɾ), vowel length, aspiration,
schwa for any unstressed vowel, doubled consonants, the American flap and
sounds merged across a word boundary all count as right, because the
recogniser can't tell those apart reliably. What it does catch in English:
wrong or missing consonants (p/b, v/f, θ/s, tʃ/ʃ...), clearly wrong vowels,
and dropped or extra sounds. In Arabic it checks q/k and the other plain
consonants, but NOT ح/ه, ع/ء or emphatic/plain (ص/س, ط/ت, ض/د): on test
speech the recogniser didn't hear those reliably, so they are let through.

Arabic: espeak can only vowel Arabic that carries diacritics (tashkeel).
Undiacritised targets are therefore scored on their consonants only (short
vowels can't be checked); fully diacritised targets are scored on every
sound. A word-initial hamza (the article's alif, often silent in connected
speech: "في البيت" = fil-bayt) is optional.

score_words(heard_text, target) is the model-free fallback: the same shape,
word level only (sounds = []), from an STT transcript.

The model (~240 MB, q4 ONNX) is fetched from Hugging Face into the HF cache
on first use, or read from <models>/phoneme/ if setup.ps1 put it there.
Loading takes ~1 s and ~0.5-0.7 GB of RAM (unload() frees it); scoring
takes ~0.1 s per second of audio on 4 threads.
"""

from __future__ import annotations

import json
import re
import sys
import threading
import unicodedata
from pathlib import Path

import numpy as np

MODEL_REPO = "onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX"
MODEL_FILE = "onnx/model_q4.onnx"
MODEL_REV = "c69750f5043e5e1f8a71ab95dd3b98338c280c92"   # same as setup.ps1
RATE = 16_000

_lock = threading.Lock()          # the model
_g2p_lock = threading.Lock()      # espeak
_model = None            # (session, id->token) once loaded
_models_dir: Path | None = None
_backends: dict = {}


def log(*a) -> None:
    print(*a, file=sys.stderr, flush=True)


def set_models_dir(path) -> None:
    """Optional: look for <path>/phoneme/model.onnx + vocab.json first."""
    global _models_dir
    _models_dir = Path(path) if path else None


# ------------------------------------------------------------ the model
def _load():
    global _model
    if _model is not None:
        return _model
    import onnxruntime as ort
    onnx_path = vocab_path = None
    if _models_dir is not None:
        d = _models_dir / "phoneme"
        if (d / "model.onnx").exists() and (d / "vocab.json").exists():
            onnx_path, vocab_path = d / "model.onnx", d / "vocab.json"
    if onnx_path is None:
        from huggingface_hub import hf_hub_download
        onnx_path = hf_hub_download(MODEL_REPO, MODEL_FILE,
                                    revision=MODEL_REV)
        vocab_path = hf_hub_download(MODEL_REPO, "vocab.json",
                                     revision=MODEL_REV)
    vocab = json.loads(Path(vocab_path).read_text(encoding="utf-8"))
    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    so.inter_op_num_threads = 1
    so.log_severity_level = 3
    so.enable_cpu_mem_arena = False   # give activation memory back each call
    sess = ort.InferenceSession(str(onnx_path), sess_options=so,
                                providers=["CPUExecutionProvider"])
    _model = (sess, {i: t for t, i in vocab.items()})
    log(f"pron: phoneme model ready ({Path(onnx_path).name})")
    return _model


def unload() -> None:
    """Free the model's RAM (~0.5-0.7 GB); the next score() reloads it."""
    global _model
    with _lock:
        _model = None


def available() -> bool:
    """True if the phoneme model loads (downloads it the first time)."""
    try:
        with _lock:
            _load()
        return True
    except Exception as e:  # noqa: BLE001
        log(f"pron: phoneme model unavailable: {e}")
        return False


def recognise(audio16k: np.ndarray) -> list[str]:
    """The IPA phones heard in the clip (greedy CTC)."""
    x = np.asarray(audio16k, np.float32).reshape(-1)
    if len(x) < RATE // 10:
        return []
    x = (x - x.mean()) / (x.std() + 1e-7)        # Wav2Vec2 do_normalize
    with _lock:
        sess, id2tok = _load()
        logits = sess.run(None, {"input_values": x[None, :]})[0][0]
    ids = logits.argmax(-1)
    out, prev = [], -1
    for i in ids:
        if i != prev and i > 3:                   # 0-3: pad, <s>, </s>, unk
            out.append(id2tok[int(i)])
        prev = i
    return out


# ------------------------------------------------------- expected sounds
def _backend(lang: str):
    if lang not in _backends:
        import espeakng_loader
        from phonemizer.backend import EspeakBackend
        from phonemizer.backend.espeak.wrapper import EspeakWrapper
        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        _backends[lang] = EspeakBackend(
            lang, with_stress=False, preserve_punctuation=False,
            language_switch="remove-flags")
    return _backends[lang]


_ESPEAK = {"en": "en-us", "ar": "ar"}
_WORD = re.compile(r"[\w\u0600-\u06ff\u0750-\u077f'\u2019-]+")
_HARAKAT = re.compile("[\u064b-\u0652]")
_AR_LETTER = re.compile("[\u0621-\u064a]")


def words_of(text: str) -> list[str]:
    return [w.strip("'’-") for w in _WORD.findall(text) if w.strip("'’-")]


def expected(words: list[str], lang: str) -> list[list[str]]:
    """espeak phones for each word. The sentence is phonemised as a whole
    so function words get their connected forms ("a" = ɐ, not the letter
    name eɪ); if espeak splits the words differently (numbers, hyphens),
    each word is phonemised on its own instead."""
    from phonemizer.separator import Separator
    with _g2p_lock:
        be = _backend(_ESPEAK.get(lang, lang))
        whole = be.phonemize([" ".join(words)], separator=Separator(
            phone=" ", word="|", syllable=""), strip=True)[0]
        parts = [w.split() for w in whole.split("|")]
        if len(parts) == len(words) and all(parts):
            return parts
        out = be.phonemize(words, separator=Separator(
            phone=" ", word="", syllable=""), strip=True)
    return [o.split() for o in out]


def diacritised(text: str) -> bool:
    """Most Arabic letters carry a vowel mark (fatha, kasra, sukun...)."""
    letters = len(_AR_LETTER.findall(text))
    return letters > 0 and len(_HARAKAT.findall(text)) >= 0.5 * letters


# ------------------------------------------------------ sound classes
# Tokens the recogniser writes as one unit that espeak may split.
_SPLIT = {"ɚ": ["ə", "r"], "əl": ["ə", "l"], "aɪɚ": ["aɪ", "ə", "r"],
          "aɪə": ["aɪ", "ə"]}
_CLASS = {}
for _cls, _members in {
    "a": "a aː ä æ æː ɑ ɑː ɐ a. a.ː ää æi",
    "e": "e eː ɛ ɛː e̞ e̞e̞ ɛɪ",
    "i": "i iː ɪ ᵻ i. ɨ i̪ ɪː iːː i.ː ɨː j y yː",
    "o": "o oː ɔ ɔː ɒ o̞ ɔ̃ õ o̞o̞",
    "u": "u uː ʊ ʉ u. ʊː u.ː w ɯ",
    "ə": "ə ʌ ɜ ɜː ɐɐ əː",
    "eɪ": "eɪ ei", "oʊ": "oʊ əʊ ou", "aɪ": "aɪ ai", "aʊ": "aʊ au",
    "ɔɪ": "ɔɪ oɪ",
    "r": "r ɹ ɾ ɻ ɽ r̝ rʲ r̩ r.",
    "l": "l ɫ ɭ ʎ l̩ ɭʲ lː",
    "g": "ɡ g ɡʲ ɡː ɡʰ",
    "ɣ": "ɣ ʁ χ",          # Arabic غ (and a French r)
    "x": "x xʲ",
    "sˤ": "sˤ s̪ s^ s.",     # ص  (espeak writes s̪)
    "tˤ": "tˤ t̪ t^ t[",     # ط  (espeak writes t̪)
    "dˤ": "dˤ d̪ d^ d[ dˤdˤ",  # ض
    "ðˤ": "ðˤ z̪ z^",        # ظ
    "dʒ": "dʒ dZ dʒʲ dʒː ʒ ɟ",
    "tʃ": "tʃ tS tʃʲ tʃː tʃʰ",
    "n": "n nʲ n̩ ɲ ɳ",
    "ŋ": "ŋ ɴ",
}.items():
    for _m in _members.split():
        _CLASS[_m] = _cls
_VOWELS = {"a", "e", "i", "o", "u", "ə", "eɪ", "oʊ", "aɪ", "aʊ", "ɔɪ"}
_SHORT = {"a", "e", "i", "o", "u", "ə"}


def _canon(p: str) -> str:
    """One recogniser/espeak token -> its sound class."""
    p = unicodedata.normalize("NFC", p.replace("\u0361", "").replace(
        "ˈ", "").replace("ˌ", ""))
    p = re.sub(r"[0-9]", "", p)
    if p in _CLASS:
        return _CLASS[p]
    q = p.replace("ʰ", "").replace("ʲ", "").replace("ː", "").replace(
        ":", "").replace("h", "") if len(p) > 1 else p
    if q in _CLASS:
        return _CLASS[q]
    if len(q) == 2 and q[0] == q[1]:            # geminate written twice
        return _CLASS.get(q[0], q[0])
    return q or p


def _tokens(phones: list[str]) -> list[str]:
    out: list[str] = []
    for p in phones:
        if p in _SPLIT:
            out += _SPLIT[p]
        elif len(p) > 1 and p.endswith("ɹ") and p[:-1]:   # ɑːɹ -> ɑː ɹ
            out += [p[:-1], "ɹ"]
        else:
            out.append(p)
    return out


def _is_vowel(c: str) -> bool:
    return c in _VOWELS


# ---------------------------------------------------------- alignment
# Heard-as pairs that count as right: natural variants (American flap t/d,
# "can you" -> ɲ) and, for Arabic, contrasts the recogniser does not hear
# reliably (ح/ه, ع/ء, emphatic/plain; tested on synthetic speech).
_LENIENT = {
    "en": {("t", "r"), ("d", "r"), ("j", "ɲ"), ("j", "n"), ("dʒ", "ʒ")},
    "ar": {("ħ", "h"), ("ʕ", "ʔ"), ("sˤ", "s"), ("tˤ", "t"), ("dˤ", "d"),
           ("ðˤ", "ð"), ("ðˤ", "z"), ("dˤ", "ðˤ"), ("b", "v"), ("dʒ", "g"),
           ("ɣ", "x"), ("x", "ɣ"), ("θ", "s"), ("ð", "z")},
}
_SOFT_DROP = {"ar": {"ʕ", "ʔ", "h"}}   # often unheard; missing is fine


def _sub_cost(t: str, h: str, lang: str = "") -> tuple[float, bool]:
    """(cost, counts as right) for expected class t heard as class h."""
    if t == h:
        return 0.0, True
    if (t, h) in _LENIENT.get(lang, ()):
        return 0.3, True
    tv, hv = _is_vowel(t), _is_vowel(h)
    if tv and hv:
        if "ə" in (t, h):                      # reduced vowel: fine
            return 0.2, True
        if (t, h) in {("eɪ", "e"), ("e", "eɪ"), ("oʊ", "o"), ("o", "oʊ"),
                      ("aɪ", "a"), ("aʊ", "a"), ("i", "e"), ("e", "i")}:
            return 0.4, True
        return 0.7, False
    if tv != hv:
        return 1.3, False
    return 1.0, False


def _align(exp: list[tuple[str, bool]], heard: list[str], lang: str = ""):
    """exp: [(class, optional)], heard: [class]. Returns (per-expected ok
    flags, number of extra heard sounds)."""
    n, m = len(exp), len(heard)
    INS = 0.7
    d = np.zeros((n + 1, m + 1))
    d[0, :] = np.arange(m + 1) * INS
    for i in range(1, n + 1):
        d[i, 0] = d[i - 1, 0] + (0.1 if exp[i - 1][1] else 1.0)
    for i in range(1, n + 1):
        t, opt = exp[i - 1]
        dele = 0.1 if opt else 1.0
        for j in range(1, m + 1):
            c, _ = _sub_cost(t, heard[j - 1], lang)
            d[i, j] = min(d[i - 1, j - 1] + c, d[i - 1, j] + dele,
                          d[i, j - 1] + INS)
    ok = [False] * n
    extra = 0
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            c, good = _sub_cost(exp[i - 1][0], heard[j - 1], lang)
            if np.isclose(d[i, j], d[i - 1, j - 1] + c):
                ok[i - 1] = good
                i, j = i - 1, j - 1
                continue
        if i > 0 and np.isclose(
                d[i, j], d[i - 1, j] + (0.1 if exp[i - 1][1] else 1.0)):
            ok[i - 1] = exp[i - 1][1]          # a skipped optional sound is fine
            i -= 1
            continue
        extra += 1
        j -= 1
    return ok, extra


def _collapse(seq: list) -> list:
    out = []
    for s in seq:
        if not out or out[-1] != s:
            out.append(s)
    return out


# --------------------------------------------------------------- public
def score(audio16k: np.ndarray, target: str, lang: str = "en") -> dict:
    """Pronunciation of `target` in this 16 kHz clip. lang: "en" | "ar"."""
    words = words_of(target)
    if not words:
        return {"score": 0, "words": [], "heard": ""}
    lang = (lang or "en").lower()[:2]
    heard_raw = recognise(audio16k)
    per_word = expected(words, lang)
    consonants_only = lang == "ar" and not diacritised(target)

    # Expected sounds, flattened with their word index.
    exp: list[tuple[str, bool]] = []
    shown: list[str] = []        # the IPA shown to the learner
    owner: list[int] = []
    soft = _SOFT_DROP.get(lang, set())
    for wi, phones in enumerate(per_word):
        first = True
        for p in _tokens(phones):
            c = _canon(p)
            if consonants_only and _is_vowel(c):
                continue
            if exp and c == exp[-1][0]:
                if owner[-1] == wi:             # shadda / geminate: one sound
                    continue
                optional = True                 # "let's start": one s heard
            else:
                optional = c in soft or (lang == "ar" and first
                                         and c == "ʔ")
            exp.append((c, optional))
            shown.append(p)
            owner.append(wi)
            first = False
    heard = _collapse([_canon(p) for p in _tokens(heard_raw)])
    if consonants_only:
        heard = _collapse([h for h in heard if not _is_vowel(h)])
    if not exp:
        return {"score": 0, "words": [{"w": w, "ok": False, "sounds": []}
                                      for w in words], "heard": ""}
    ok, extra = _align(exp, heard, lang)

    out_words = []
    for wi, w in enumerate(words):
        sounds = [[shown[k], bool(ok[k])] for k in range(len(exp))
                  if owner[k] == wi]
        good = sum(s[1] for s in sounds)
        w_ok = bool(sounds) and (good == len(sounds)
                                 or (len(sounds) >= 4
                                     and good >= 0.8 * len(sounds)))
        out_words.append({"w": w, "ok": w_ok, "sounds": sounds})
    right = sum(ok) / len(exp)
    penalty = 0.5 * extra / len(exp)
    return {"score": int(round(100 * max(0.0, min(1.0, right - penalty)))),
            "words": out_words, "heard": " ".join(heard_raw)}


_PLAIN = str.maketrans({"أ": "ا", "إ": "ا",
                        "آ": "ا", "ٱ": "ا",
                        "ى": "ي", "ة": "ه"})


def _norm_word(w: str) -> str:
    w = re.sub("[\u064b-\u065f\u0670\u0640]", "", w.lower())
    return w.translate(_PLAIN).strip("'’-")


def score_words(heard_text: str, target: str) -> dict:
    """Model-free fallback from an STT transcript: which target words were
    heard (in order). Same shape as score(); sounds are empty."""
    tw = words_of(target)
    hw = [_norm_word(w) for w in words_of(heard_text)]
    if not tw:
        return {"score": 0, "words": [], "heard": heard_text}
    tn = [_norm_word(w) for w in tw]
    n, m = len(tn), len(hw)
    d = np.zeros((n + 1, m + 1))
    d[:, 0] = np.arange(n + 1)
    d[0, :] = np.arange(m + 1)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d[i, j] = min(d[i - 1, j - 1] + (tn[i - 1] != hw[j - 1]),
                          d[i - 1, j] + 1, d[i, j - 1] + 1)
    ok = [False] * n
    i, j = n, m
    while i > 0 and j > 0:
        if np.isclose(d[i, j], d[i - 1, j - 1] + (tn[i - 1] != hw[j - 1])):
            ok[i - 1] = tn[i - 1] == hw[j - 1]
            i, j = i - 1, j - 1
        elif np.isclose(d[i, j], d[i - 1, j] + 1):
            i -= 1
        else:
            j -= 1
    extra = max(0, m - sum(ok) - (n - sum(ok)))
    s = sum(ok) / n - 0.5 * extra / n
    return {"score": int(round(100 * max(0.0, min(1.0, s)))),
            "words": [{"w": w, "ok": o, "sounds": []} for w, o in zip(tw, ok)],
            "heard": heard_text}
