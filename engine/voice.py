"""Local audio: mic capture, playback, speech-to-text, text-to-speech.

Kokoro (models/kokoro-v1.0.onnx, downloaded by setup.ps1) runs on the CPU on
purpose: the game owns the GPU. Whisper uses CUDA when it can (a ~1.5 GB
slice of VRAM, about 0.3 s per utterance) and falls back to CPU int8. Whisper
and Smart Turn models download themselves on first use.
"""

from __future__ import annotations

import collections
import os
import queue
import re
import sys
import threading
import time
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
                                >= TURN_CONFIDENCE)
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


# Whisper's classic hallucinations on near-silence.
_JUNK = re.compile(r"^\W*(thank you|thanks for watching|you|bye|\.+)\W*$", re.I)


class STT:
    def __init__(self, cfg: dict) -> None:
        _register_cuda_dlls()
        from faster_whisper import WhisperModel

        want = cfg.get("device", "auto")
        order = {"cuda": [("cuda", "float16")], "cpu": [("cpu", "int8")]}.get(
            want, [("cuda", "float16"), ("cpu", "int8")])
        models = [cfg.get("model", "distil-large-v3")]
        if models[0] != "small.en":
            models.append("small.en")
        self.language = cfg.get("language") or None
        last = None
        for model in models:
            for dev, ct in order:
                try:
                    m = WhisperModel(model, device=dev, compute_type=ct)
                    list(m.transcribe(np.zeros(16000, dtype=np.float32),
                                      beam_size=1)[0])
                    self._model, self.desc = m, f"{model} on {dev}"
                    if model.endswith(".en") or model.startswith("distil"):
                        self.language = "en"
                    log(f"STT ready: {self.desc}")
                    return
                except Exception as e:  # noqa: BLE001
                    last = e
                    log(f"STT {model}/{dev} unavailable: {str(e)[:100]}")
        raise RuntimeError(f"no usable whisper model: {last}")

    def transcribe(self, audio: np.ndarray, hint: str = "") -> str:
        # No VAD trimming: the listener already marks the speech, and the
        # trimmer was eating one-word answers ("B", "eight").
        segments, _ = self._model.transcribe(
            audio, language=self.language, beam_size=1, vad_filter=False,
            condition_on_previous_text=False,
            initial_prompt=hint or None)
        segs = list(segments)
        text = "".join(s.text for s in segs).strip()
        # Whisper's own doubt: hesitation sounds ("hmm", a cough) come back
        # as confident-looking words ("Come in") but with a high no-speech
        # probability and a poor log-prob. Expose both for the engine.
        self.no_speech = max((s.no_speech_prob for s in segs), default=1.0)
        self.logprob = min((s.avg_logprob for s in segs), default=-9.0)
        return "" if _JUNK.match(text) else text


# --------------------------------------------------------------------- TTS
class TTS:
    def __init__(self, cfg: dict, models_dir: Path) -> None:
        from kokoro_onnx import Kokoro
        model = models_dir / "kokoro-v1.0.onnx"
        voices = models_dir / "voices-v1.0.bin"
        if not (model.exists() and voices.exists()):
            raise FileNotFoundError(
                f"Kokoro voice model not found in {models_dir}. Run setup.ps1 "
                f"(it downloads kokoro-v1.0.onnx and voices-v1.0.bin).")
        self._cb = None
        self._kokoro = Kokoro(str(model), str(voices))
        self._voice = cfg.get("voice", "af_heart")
        self._speed = float(cfg.get("speed", 1.0))
        self.desc = f"Kokoro {self._voice}"
        self.synth("Ready.")  # first call is slow
        log(f"TTS ready: {self.desc}")

    def synth(self, text: str) -> np.ndarray:
        if self._cb is not None:
            return self._cb.synth(text)
        pcm, sr = self._kokoro.create(text, voice=self._voice,
                                      speed=self._speed, lang="en-us")
        return np.asarray(pcm, dtype=np.float32)
