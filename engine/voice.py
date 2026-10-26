"""Local audio: mic capture, playback, speech-to-text, text-to-speech.

Kokoro (models/kokoro-v1.0.onnx) and the Arabic voice, Supertonic 3
(models/supertonic-3/, see arabic_tts.py), both downloaded by setup.ps1, run
on the CPU on purpose: the game owns the GPU. Whisper uses CUDA when it can
(a ~1.5 GB slice of VRAM, about 0.3 s per utterance) and falls back to CPU
int8. Whisper and Smart Turn models download themselves on first use.
"""

from __future__ import annotations

import collections
import os
import queue
import re
import sys
import threading
import time
import zlib
from pathlib import Path

import numpy as np
import sounddevice as sd

MIC_RATE = 16_000
TTS_RATE = 24_000


def log(*a) -> None:
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- devices
def _default_endpoint_ids():
    """Factory: returns a function giving the Windows default (render,
    capture) endpoint ids, via the Core Audio COM API."""
    import ctypes

    import comtypes
    from comtypes import COMMETHOD, GUID, HRESULT, IUnknown

    class IMMDevice(IUnknown):
        _iid_ = GUID("{D666063F-1587-4E43-81F1-B948E807363F}")
        _methods_ = [
            COMMETHOD([], HRESULT, "Activate"),
            COMMETHOD([], HRESULT, "OpenPropertyStore"),
            COMMETHOD([], HRESULT, "GetId",
                      (["out"], ctypes.POINTER(ctypes.c_void_p), "id")),
        ]

    class IMMDeviceEnumerator(IUnknown):
        _iid_ = GUID("{A95664D2-9614-4F35-A746-DE8DB63617E6}")
        _methods_ = [
            COMMETHOD([], HRESULT, "EnumAudioEndpoints"),
            COMMETHOD([], HRESULT, "GetDefaultAudioEndpoint",
                      (["in"], ctypes.c_uint, "flow"),
                      (["in"], ctypes.c_uint, "role"),
                      (["out"], ctypes.POINTER(ctypes.POINTER(IMMDevice)),
                       "device")),
        ]

    comtypes.CoInitialize()
    enum = comtypes.CoCreateInstance(
        GUID("{BCDE0395-E52F-467C-8E3D-C4579291692E}"), IMMDeviceEnumerator,
        comtypes.CLSCTX_ALL)
    free = ctypes.windll.ole32.CoTaskMemFree

    def one(flow: int) -> str:
        try:
            ptr = enum.GetDefaultAudioEndpoint(flow, 1).GetId()  # eMultimedia
            s = ctypes.wstring_at(ptr)
            free(ctypes.c_void_p(ptr))
            return s
        except Exception:  # noqa: BLE001 — e.g. no device at all right now
            return ""

    return lambda: (one(0), one(1))  # eRender, eCapture


class DeviceWatcher:
    """PortAudio picks the default output/input once, at startup, and never
    follows Windows after that. This polls the Windows defaults and calls
    on_change() when you switch (e.g. headset -> monitor speakers)."""

    def __init__(self, on_change) -> None:
        self._on_change = on_change
        threading.Thread(target=self._run, daemon=True,
                         name="devices").start()

    def _run(self) -> None:
        try:
            ids = _default_endpoint_ids()
        except Exception as e:  # noqa: BLE001
            log(f"device watcher unavailable: {e}")
            return
        last = ids()
        while True:
            time.sleep(1.5)
            now = ids()
            if now != last and all(now):
                last = now
                self._on_change()


def reinit_portaudio() -> None:
    """Re-scan devices so 'default' means the current Windows default.
    Every stream must be closed first."""
    sd._terminate()
    sd._initialize()


def output_name() -> str:
    try:
        return sd.query_devices(kind="output")["name"]
    except Exception:  # noqa: BLE001
        return "?"


# ------------------------------------------------------------- smart turn
class SmartTurn:
    """Semantic end-of-turn (Smart Turn v3, pipecat-ai, BSD-2), the same model
    downloaded automatically on first use. It listens to HOW you said the last
    words (grammar, tone, pace) and returns P(finished). ~12 ms on CPU. A
    finished sentence ends after ~0.25 s of silence instead of the full
    timeout; a thinking pause still waits."""

    def __init__(self) -> None:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from transformers import WhisperFeatureExtractor
        path = hf_hub_download("pipecat-ai/smart-turn-v3",
                               "smart-turn-v3.2-cpu.onnx")
        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        self._session = ort.InferenceSession(
            path, sess_options=so, providers=["CPUExecutionProvider"])
        self._fx = WhisperFeatureExtractor(chunk_length=8)
        self.prob(np.zeros(MIC_RATE, dtype=np.float32))  # warm up

    def prob(self, audio: np.ndarray) -> float:
        n = 8 * MIC_RATE
        audio = audio[-n:]
        feats = self._fx(audio, sampling_rate=MIC_RATE, return_tensors="np",
                         padding="max_length", max_length=n, truncation=True,
                         do_normalize=True).input_features
        out = self._session.run(None, {"input_features":
                                       feats.astype(np.float32)})
        return float(out[0][0])


# --------------------------------------------------------------- listener
FRAME = 512                      # Silero v5 window: 32 ms @ 16 kHz
FRAME_MS = FRAME * 1000 // MIC_RATE
TURN_FIRST_CHECK = 14            # ~0.45 s of silence before the first check
TURN_RECHECK = 8                 # then every ~0.26 s
TURN_CONFIDENCE = 0.7            # P(finished) needed to end early; a "hmm…"
                                 # or trailing "so…" scores low and waits
MIN_VOICED_MS = 120              # "yes" is ~200 ms; anything shorter is a click


class Listener:
    """Hands-free, always-on listening with Silero VAD (thresholds from
    a headset; see README). Calls, from its own thread:
        on_start()          speech confirmed (the engine pauses the tutor)
        on_cancel()         it was only a noise burst / cough
        on_utterance(pcm)   a finished sentence, float32 @ 16 kHz
    While the tutor is speaking (self.tutor_speaking) it needs a little more
    confidence to cut in, so its own voice leaking into the mic can't."""

    def __init__(self, device=None, end_silence_ms: int = 700,
                 on_start=None, on_cancel=None, on_utterance=None,
                 turn: SmartTurn | None = None) -> None:
        from pysilero_vad import SileroVoiceActivityDetector
        self._vad = SileroVoiceActivityDetector()
        self._turn = turn
        self.on_start, self.on_cancel = on_start, on_cancel
        self.on_utterance = on_utterance
        self.enabled = True
        self.tutor_speaking = False
        self.level = 0.0
        # P(finished) Smart Turn needs to end a turn early. Set it above 1.0
        # to always wait the full end silence (e.g. while speaking Arabic,
        # where Smart Turn tested less reliable on trailing-off phrases).
        self.turn_confidence = TURN_CONFIDENCE
        self._end_frames = max(8, end_silence_ms // FRAME_MS)
        self._q: "queue.Queue[np.ndarray]" = queue.Queue()
        self._device = device
        self.open()
        threading.Thread(target=self._run, daemon=True,
                         name="listener").start()

    def open(self) -> None:
        self._stream = sd.InputStream(
            samplerate=MIC_RATE, channels=1, dtype="float32",
            blocksize=FRAME, device=self._device, callback=self._cb)
        self._stream.start()

    def close(self) -> None:
        self._stream.stop()
        self._stream.close()

    def _cb(self, indata, frames, t, status) -> None:
        self._q.put(indata[:, 0].copy())

    def _prob(self, frame: np.ndarray) -> float:
        pcm16 = (np.clip(frame, -1, 1) * 32767).astype(np.int16)
        return float(self._vad(pcm16.tobytes()))

    def _run(self) -> None:
        preroll = collections.deque(maxlen=16)   # ~0.5 s before the onset
        collected: list[np.ndarray] = []
        state = "idle"                           # idle | maybe | speech
        run = silence = voiced = 0
        while True:
            frame = self._q.get()
            if len(frame) != FRAME:
                continue
            self.level = min(1.0, float(np.sqrt(np.mean(frame * frame))) * 12)
            if not self.enabled:
                if state != "idle" and self.on_cancel:
                    self.on_cancel()
                state, collected, run = "idle", [], 0
                preroll.clear()
                continue
            p = self._prob(frame)
            if state == "idle":
                preroll.append(frame)
                start_p = 0.55 if self.tutor_speaking else 0.50
                run = run + 1 if p >= start_p else 0
                if run >= 3:                      # ~100 ms of voice
                    state, collected = "speech", list(preroll)
                    silence, voiced = 0, run
                    preroll.clear()
                    if self.on_start:
                        self.on_start()
                continue
            collected.append(frame)
            if p >= 0.35:
                voiced += 1
                silence = 0
            else:
                silence += 1
            too_long = len(collected) * FRAME_MS > 30_000
            finished = False
            if (self._turn is not None and silence >= TURN_FIRST_CHECK
                    and (silence - TURN_FIRST_CHECK) % TURN_RECHECK == 0
                    and voiced * FRAME_MS >= MIN_VOICED_MS):
                try:
                    finished = (self._turn.prob(np.concatenate(collected))
                                >= self.turn_confidence)
                except Exception:  # noqa: BLE001 — fall back to the timeout
                    self._turn = None
            if finished or silence >= self._end_frames or too_long:
                audio = np.concatenate(collected)
                state, collected, run = "idle", [], 0
                self._vad.reset()
                if voiced * FRAME_MS < MIN_VOICED_MS:   # a click or a cough
                    if self.on_cancel:
                        self.on_cancel()
                elif self.on_utterance:
                    self.on_utterance(audio)


# ------------------------------------------------------------------ player
class Player:
    """One OutputStream for the whole session. play() feeds one clip and
    resolves when it ends; stop() cuts it within one 20 ms block. Earcons mix
    on top without disturbing the clip queue."""

    def __init__(self, device=None) -> None:
        self._lock = threading.Lock()
        self._clip: np.ndarray | None = None
        self._pos = 0
        self.paused = False  # held mid-word while you talk over it
        self._fx: np.ndarray | None = None
        self._fx_pos = 0
        self.done = threading.Event()
        self.done.set()
        self.gain = 0.0 if os.environ.get("SIDEQUEST_TEST") == "1" else 1.0
        self._device = device
        self.open()

    def open(self) -> None:
        # Clip and position live on self, so a reopen mid-sentence carries on
        # from the same word on the new device.
        self._stream = sd.OutputStream(
            samplerate=TTS_RATE, channels=1, dtype="float32",
            blocksize=480, device=self._device, callback=self._cb)
        self._stream.start()

    def close(self) -> None:
        self._stream.stop()
        self._stream.close()

    def _cb(self, outdata, frames, t, status) -> None:
        out = np.zeros(frames, dtype=np.float32)
        with self._lock:
            if self._clip is not None and not self.paused:
                n = min(frames, len(self._clip) - self._pos)
                out[:n] = self._clip[self._pos:self._pos + n]
                self._pos += n
                if self._pos >= len(self._clip):
                    self._clip = None
                    self.done.set()
            if self._fx is not None:
                n = min(frames, len(self._fx) - self._fx_pos)
                out[:n] += self._fx[self._fx_pos:self._fx_pos + n]
                self._fx_pos += n
                if self._fx_pos >= len(self._fx):
                    self._fx = None
        outdata[:, 0] = np.clip(out * self.gain, -1.0, 1.0)

    def start_clip(self, pcm: np.ndarray) -> None:
        with self._lock:
            self._clip = np.asarray(pcm, dtype=np.float32)
            self._pos = 0
            self.done.clear()

    def stop(self) -> None:
        with self._lock:
            self._clip = None
            self.paused = False
            self.done.set()

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def blip(self, pcm: np.ndarray) -> None:
        with self._lock:
            self._fx = pcm
            self._fx_pos = 0


def tone(freqs: list[float], ms: int = 70, vol: float = 0.12) -> np.ndarray:
    """Soft two-note earcon (press = rising, release = falling)."""
    parts = []
    for f in freqs:
        t = np.arange(int(TTS_RATE * ms / 1000)) / TTS_RATE
        env = np.minimum(1, np.minimum(t, t[::-1]) * 200)
        parts.append(np.sin(2 * np.pi * f * t) * env * vol)
    return np.concatenate(parts).astype(np.float32)


# --------------------------------------------------------------------- STT
def _register_cuda_dlls() -> None:
    """The pip nvidia-*-cu12 wheels put their DLLs under site-packages/nvidia/
    <lib>/bin, which isn't on the DLL search path."""
    try:
        import importlib.util
        spec = importlib.util.find_spec("nvidia")
        base = spec.submodule_search_locations[0]
    except Exception:  # noqa: BLE001
        return
    for sub in ("cublas", "cudnn", "cuda_nvrtc", "cuda_runtime"):
        d = os.path.join(base, sub, "bin")
        if os.path.isdir(d):
            try:
                os.add_dll_directory(d)
            except Exception:  # noqa: BLE001
                pass
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


# Whisper's classic hallucinations on near-silence. Both patterns must match
# the WHOLE utterance, so a real sentence containing these words survives.
_JUNK = re.compile(r"^\W*(thank you|thanks for watching|you|bye|\.+)\W*$", re.I)
# Arabic ones (matched on the undiacritised text): subtitle credits
# ("translated by Nancy Qanqar"), "subscribe to the channel", "thanks for
# watching", "[music]". A plain "شكرا" (thanks) is a real answer and is kept.
_JUNK_AR = re.compile(
    r"^\W*(?:(?:ترجمه|ترجمة)\W+)?(?:نانسي\W+قنقر"
    r"|اشتركوا?\W+(?:في\W+)?(?:ال)?قناه?ة?"
    r"|شكرا\W+(?:لكم\W+)?(?:على|علي|ل)\W*(?:ال)?مشاهده?ة?"
    r"|موسيقى|موسيقي)\W*$")
_HARAKAT = re.compile("[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]")
_AR_SCRIPT = re.compile("[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff"
                        "\ufb50-\ufdff\ufe70-\ufeff]")
MULTILINGUAL_MODEL = "large-v3-turbo"


def _english_only(model: str) -> bool:
    """distil-whisper and *.en checkpoints were trained on English only."""
    name = model.replace("\\", "/").rstrip("/").split("/")[-1].lower()
    return (name.endswith(".en") or name.startswith("distil")
            or "distil-whisper" in name)


def _plain_ar(text: str) -> str:
    return _HARAKAT.sub("", text)


# Short Arabic replies as Whisper spells them when it decodes them as
# English ("نعم" -> "Naam."). Used only to settle an unsure one-word clip.
_ROMAN = {"naam", "na'am", "naem", "la", "laa", "tamam", "tammam", "tayeb",
          "tayyib", "taib", "sah", "sahh", "saheh", "shukran", "shokran",
          "yalla", "yallah", "khalas", "khalaas", "aywa", "aiwa", "ewa",
          "inshallah", "mashallah", "wallah", "wallahi", "zain", "zein",
          "akeed", "mumkin", "kammil", "kammal", "kamel", "madri",
          "ma adri", "afwan", "ahlan", "marhaba", "habibi"}


def _roman_ar(text: str) -> bool:
    words = re.sub(r"[^a-z' ]", " ", text.lower()).split()
    return 0 < len(words) <= 3 and (" ".join(words) in _ROMAN
                                    or all(w in _ROMAN for w in words))


class STT:
    """faster-whisper. stt.language picks what you speak:
        "en"    English only (the default; distil-large-v3 is fine)
        "ar"    Arabic only
        "auto"  per utterance, between stt.autoLanguages (default en + ar)
    Any non-English setting needs a multilingual model, so an English-only
    stt.model (distil-*, *.en) is swapped for stt.multilingualModel
    (default large-v3-turbo). transcribe() leaves the language it used in
    self.lang and the en/ar probabilities in self.lang_probs."""

    def __init__(self, cfg: dict) -> None:
        _register_cuda_dlls()
        from faster_whisper import WhisperModel

        mode = str(cfg.get("language") or "en").strip().lower()
        self.auto_langs = [str(x).lower() for x in
                           (cfg.get("autoLanguages") or ["en", "ar"])]
        want = cfg.get("device", "auto")
        order = {"cuda": [("cuda", "float16")], "cpu": [("cpu", "int8")]}.get(
            want, [("cuda", "float16"), ("cpu", "int8")])
        model = cfg.get("model", "distil-large-v3")
        if mode != "en" and _english_only(model):
            multi = cfg.get("multilingualModel") or MULTILINGUAL_MODEL
            log(f"STT: {model} only knows English; language={mode} "
                f"uses {multi} instead")
            model = multi
        models = [model]
        small = "small.en" if mode == "en" else "small"
        if model != small:
            models.append(small)
        self.no_speech, self.logprob = 0.0, 0.0
        self.lang_probs: dict[str, float] = {}
        last = None
        for model in models:
            for dev, ct in order:
                try:
                    m = WhisperModel(model, device=dev, compute_type=ct)
                    list(m.transcribe(np.zeros(16000, dtype=np.float32),
                                      language="en", beam_size=1)[0])
                except Exception as e:  # noqa: BLE001
                    last = e
                    log(f"STT {model}/{dev} unavailable: {str(e)[:100]}")
                    continue
                self._model = m
                self.mode = mode
                if mode != "en" and (_english_only(model)
                                     or not m.model.is_multilingual):
                    log(f"STT: {model} is English-only; language={mode} "
                        f"falls back to English")
                    self.mode = "en"
                self.lang = (self.auto_langs[0] if self.mode == "auto"
                             else self.mode)
                self.desc = f"{model} on {dev}" + (
                    "" if self.mode == "en" else f" ({self.mode})")
                self._cache_encoder()
                log(f"STT ready: {self.desc}")
                return
        raise RuntimeError(f"no usable whisper model: {last}")

    def _cache_encoder(self) -> None:
        """faster-whisper encodes the first 30 s window twice when it has to
        detect the language (once to detect, once to decode). _detect()
        encodes it once and this hands the same result to the decoder."""
        m = self._model
        orig = m.encode
        self._enc = None

        def encode(features):
            hit = self._enc
            if (hit is not None and features.shape == hit[0].shape
                    and np.array_equal(features, hit[0])):
                return hit[1]
            return orig(features)

        m.encode = encode

    def _detect(self, audio: np.ndarray) -> tuple[str, bool]:
        """Pick the language among self.auto_langs only -> (lang, sure).
        Whisper's own guess over 99 languages wanders on short clips (a
        one-word "na'am" comes back as German, "la" as French); restricted
        to Arabic vs English it is reliable for anything longer than a word
        or two. Unsure = neither candidate got half the probability."""
        from faster_whisper.audio import pad_or_trim
        m = self._model
        feats = m.feature_extractor(audio)
        n = min(m.feature_extractor.nb_max_frames, feats.shape[-1] - 1)
        seg = pad_or_trim(feats[:, :n])
        out = m.encode(seg)
        self._enc = (seg, out)
        probs = {tok[2:-2]: p for tok, p in m.model.detect_language(out)[0]}
        cand = {x: float(probs.get(x, 0.0)) for x in self.auto_langs}
        self.lang_probs = cand
        best = max(cand, key=cand.get)
        return best, cand[best] >= 0.5

    def _decode(self, audio: np.ndarray, lang: str, hint: str):
        prompt = hint or None
        if prompt and lang != "en" and not (
                lang == "ar" and _AR_SCRIPT.search(prompt)):
            # An English prompt under Arabic speech makes Whisper translate
            # or romanise it ("Kelima Komni Hasub") instead of transcribing.
            prompt = None
        segments, _ = self._model.transcribe(
            audio, language=lang, beam_size=1, vad_filter=False,
            condition_on_previous_text=False, initial_prompt=prompt)
        segs = list(segments)
        text = "".join(s.text for s in segs).strip()
        n = sum(len(s.tokens) for s in segs)
        lp = (sum(s.avg_logprob * len(s.tokens) for s in segs) / n
              if n else -9.0)
        return text, segs, lp

    def _pick(self, tries: dict) -> str:
        """An unsure clip, decoded in each candidate language: the better
        log-prob wins, except that Whisper's stock hallucinations always
        lose, a romanised Arabic reply ("Naam.", "Tamam.") counts as Arabic,
        and leaving the previous utterance's language needs a margin."""
        en = tries.get("en")
        if "ar" in tries and en and _roman_ar(en[0]):
            return "ar"

        def score(lang: str) -> float:
            text, _, lp = tries[lang]
            if not text or _JUNK.match(text) or _JUNK_AR.match(
                    _plain_ar(text)):
                return -99.0
            return lp + (0.1 if lang == self.lang else 0.0)
        return max(tries, key=score)

    def transcribe(self, audio: np.ndarray, hint: str = "") -> str:
        # No VAD trimming: the listener already marks the speech, and the
        # trimmer was eating one-word answers ("B", "eight").
        lang = self.mode
        try:
            if lang != "auto":
                self.lang_probs = {}
                text, segs, _ = self._decode(audio, lang, hint)
            else:
                lang, sure = self._detect(audio)
                if sure:
                    text, segs, _ = self._decode(audio, lang, hint)
                else:   # the encoder output is reused: decoder cost only
                    tries = {x: self._decode(audio, x, hint)
                             for x in self.auto_langs}
                    lang = self._pick(tries)
                    text, segs, _ = tries[lang]
        finally:
            self._enc = None
        self.lang = lang
        # Whisper's own doubt: hesitation sounds ("hmm", a cough) come back
        # as confident-looking words ("Come in") but with a high no-speech
        # probability and a poor log-prob. Expose both for the engine.
        self.no_speech = max((s.no_speech_prob for s in segs), default=1.0)
        self.logprob = min((s.avg_logprob for s in segs), default=-9.0)
        if _JUNK.match(text) or _JUNK_AR.match(_plain_ar(text)):
            return ""
        return text


# --------------------------------------------------------------------- TTS
_LATIN = re.compile(r"[A-Za-z\u00c0-\u024f]")
# The Arabic voice used for the main voice when tts.arabicVoice is empty,
# by the main Kokoro voice's gender (second letter of its name: af_, bm_...).
ARABIC_DEFAULT = {"f": "F1", "m": "M1"}


def script_runs(text: str) -> list[tuple[str, str]]:
    """Split a line into ("ar" | "en", text) runs by script. Digits,
    punctuation and spaces stay with the run before them."""
    runs: list[list[str]] = []
    lead = ""
    for tok in re.findall(r"\S+\s*", text):
        a = len(_AR_SCRIPT.findall(_plain_ar(tok)))
        e = len(_LATIN.findall(tok))
        s = "ar" if a and a >= e else ("en" if e else "")
        if not s:                       # no letters: "2026", "?", "-"
            if runs:
                runs[-1][1] += tok
            else:
                lead += tok
        elif runs and runs[-1][0] == s:
            runs[-1][1] += tok
        else:
            runs.append([s, lead + tok])
            lead = ""
    if lead:
        runs.append(["en", lead])
    return [(s, t.strip()) for s, t in runs if t.strip()]


def is_arabic(text: str) -> bool:
    """True when the line is mostly Arabic words (so Supertonic speaks it)."""
    ar = en = 0
    for s, t in script_runs(text):
        n = len(t.split())
        ar, en = (ar + n, en) if s == "ar" else (ar, en + n)
    return ar > 0 and ar >= en


def _gender(voice: str) -> str:
    """Kokoro 'af_heart' -> 'f', 'bm_george' -> 'm'; Supertonic 'M3' -> 'm'."""
    v = voice.lower()
    if len(v) == 2 and v[0] in "fm" and v[1].isdigit():
        return v[0]
    return v[1] if len(v) > 1 and v[1] in "fm" else "f"


def _trim(pcm: np.ndarray, floor: float = 0.012, keep: int = 480) -> np.ndarray:
    """Cut leading/trailing silence (for splicing runs into one line)."""
    loud = np.flatnonzero(np.abs(pcm) > floor)
    if not len(loud):
        return pcm[:0]
    return pcm[max(0, loud[0] - keep):loud[-1] + keep]


class TTS:
    """Kokoro-82M (English) plus, when its files are there, Supertonic 3 for
    Arabic (see arabic_tts.py). Both run on the CPU.

    synth(text, voice) routes by script: a line that is mostly Arabic words
    goes to Supertonic whole (it reads the odd English word in it, e.g.
    "computer" or "Python", in the same voice); a line that is mostly English
    goes to Kokoro, with any Arabic words in it spliced in from Supertonic.
    Each Kokoro voice has a fixed Arabic stand-in of the same gender, and
    only the main voice gets tts.arabicVoice, so the co-host and characters
    stay distinct in Arabic too."""

    def __init__(self, cfg: dict, models_dir: Path) -> None:
        from kokoro_onnx import Kokoro
        model = models_dir / "kokoro-v1.0.onnx"
        voices = models_dir / "voices-v1.0.bin"
        if not (model.exists() and voices.exists()):
            raise FileNotFoundError(
                f"Kokoro voice model not found in {models_dir}. Run setup.ps1 "
                f"(it downloads kokoro-v1.0.onnx and voices-v1.0.bin).")
        self._kokoro = Kokoro(str(model), str(voices))
        self._kokoro_voices = set(self._kokoro.get_voices())
        self._en_lock = threading.Lock()   # espeak/phonemizer isn't reentrant
        self._voice = cfg.get("voice", "af_heart")
        self._speed = float(cfg.get("speed", 1.0))
        self._ar_main = str(cfg.get("arabicVoice") or "")
        self._ar = None
        self._ar_warned = False
        if cfg.get("arabic", True):
            folder = Path(cfg.get("arabicDir") or models_dir / "supertonic-3")
            try:
                from arabic_tts import Supertonic
                self._ar = Supertonic(folder,
                                      threads=int(cfg.get("arabicThreads", 4)),
                                      steps=int(cfg.get("arabicSteps", 5)))
            except Exception as e:  # noqa: BLE001 — English still works
                log(f"Arabic voice unavailable (English only): {e}")
        self._update_desc()
        self.synth("Ready.")  # first call is slow
        if self._ar is not None:
            self.synth("جاهز.")
        log(f"TTS ready: {self.desc}")

    # ---------------------------------------------------------- settings
    @property
    def has_arabic(self) -> bool:
        return self._ar is not None

    def voice_list(self) -> list[str]:
        """Kokoro voices, for the Settings dropdown."""
        return sorted(self._kokoro_voices)

    def arabic_voice_list(self) -> list[str]:
        """Supertonic voices (F1-F5, M1-M5) for tts.arabicVoice; [] if none."""
        return list(self._ar.voices) if self._ar is not None else []

    def set_voice(self, name: str) -> None:
        if name in self._kokoro_voices:
            self._voice = name
            self._update_desc()
        else:
            log(f"unknown Kokoro voice {name!r}; keeping {self._voice}")

    def set_speed(self, x: float) -> None:
        self._speed = min(2.0, max(0.5, float(x)))

    def set_arabic_voice(self, name: str) -> None:
        """'' = follow the main voice's gender; else F1-F5 / M1-M5."""
        self._ar_main = name or ""
        self._update_desc()

    def _update_desc(self) -> None:
        self.desc = f"Kokoro {self._voice}" + (
            f" + Arabic Supertonic-3 {self.arabic_voice()}"
            if self._ar is not None else "")

    def arabic_voice(self, voice: str | None = None) -> str:
        """The Supertonic voice that speaks Arabic for a Kokoro voice."""
        if self._ar is None:
            return ""
        have = self._ar.voices
        name = voice or self._voice
        if name in have:
            return name
        if self._ar_main in have:
            main = self._ar_main
        else:
            main = ARABIC_DEFAULT.get(_gender(self._voice), have[0])
            main = main if main in have else have[0]
        if name == self._voice:
            return main
        g = _gender(name)
        pool = ([v for v in have if _gender(v) == g and v != main]
                or [v for v in have if v != main] or have)
        return pool[zlib.crc32(name.encode()) % len(pool)]

    # ------------------------------------------------------------- audio
    def _english(self, text: str, voice: str, speed: float) -> np.ndarray:
        if not re.search(r"\w", text):
            return np.zeros(int(0.15 * TTS_RATE), np.float32)
        lang = "en-gb" if voice.startswith("b") else "en-us"
        with self._en_lock:
            pcm, _ = self._kokoro.create(text, voice=voice, speed=speed,
                                         lang=lang)
        return np.asarray(pcm, dtype=np.float32)

    def synth(self, text: str, voice: str | None = None) -> np.ndarray:
        """float32 @ 24 kHz. voice=None is the main voice; a Kokoro name
        (e.g. "bf_emma") picks that voice and its Arabic stand-in."""
        kv = voice if voice in self._kokoro_voices else self._voice
        speed = self._speed
        runs = script_runs(text)
        if not any(s == "ar" for s, _ in runs):
            return self._english(text, kv, speed)
        if self._ar is None:
            if not self._ar_warned:
                log("no Arabic voice installed: Arabic text is skipped "
                    "(run setup.ps1)")
                self._ar_warned = True
            rest = " ".join(t for s, t in runs if s != "ar")
            return self._english(rest, kv, speed)
        av = self.arabic_voice(voice)
        if is_arabic(text):
            return self._ar.synth(text, av, speed)
        # Mostly English with a few Arabic words: splice the two engines.
        gap = np.zeros(int(0.06 * TTS_RATE), np.float32)
        parts: list[np.ndarray] = []
        for s, t in runs:
            pcm = (self._ar.synth(t, av, speed) if s == "ar"
                   else self._english(t, kv, speed))
            pcm = _trim(pcm)
            if len(pcm):
                parts += [pcm, gap]
        if not parts:
            return np.zeros(int(0.15 * TTS_RATE), np.float32)
        lead = np.zeros(int(0.05 * TTS_RATE), np.float32)
        return np.concatenate([lead, *parts, gap, gap])
