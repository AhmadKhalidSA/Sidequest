"""Saudi Arabic voice: NAMAA-Saudi-TTS (MIT), a Saudi fine-tune of
Chatterbox Multilingual (Resemble AI, MIT), on the GPU.

Only its Arabic text-to-speech weights (t3) are its own; the voice encoder,
the vocoder (s3gen) and the default speaker come from Chatterbox's own
repo, byte-identical, so a machine that already has Chatterbox downloads
just the 2 GB t3 file. Needs `chatterbox-tts` and a CUDA build of torch.

About 3 GB of VRAM; a sentence takes ~0.6-0.8x its own length once warm."""

from __future__ import annotations

import sys
import threading
import types
from pathlib import Path

import numpy as np

REPO = "NAMAA-Space/NAMAA-Saudi-TTS"
BASE = "ResembleAI/chatterbox"
OUT_RATE = 24_000


def log(*a) -> None:
    print(*a, file=sys.stderr, flush=True)


def files(folder: Path) -> dict[str, str]:
    """Local paths of every file the voice needs, downloading what's
    missing (t3 and the tokenizer into folder; the rest from the shared
    Hugging Face cache)."""
    from huggingface_hub import hf_hub_download
    out = {}
    for name in ("t3_mtl23ls_v2.safetensors", "mtl_tokenizer.json"):
        path = folder / name
        out[name] = str(path) if path.exists() else hf_hub_download(
            REPO, name, local_dir=folder)
    for name in ("s3gen.safetensors", "ve.safetensors", "conds.pt"):
        out[name] = hf_hub_download(BASE, name)
    return out


class SaudiTTS:
    voices = ["saudi"]

    def __init__(self, folder: Path, exaggeration: float = 0.5) -> None:
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError("the Saudi voice needs an NVIDIA GPU")
        import perth
        if getattr(perth, "PerthImplicitWatermarker", None) is None:
            # Chatterbox stamps an inaudible watermark; this install's
            # watermarker is broken, and the voice doesn't need it.
            perth.PerthImplicitWatermarker = lambda: types.SimpleNamespace(
                apply_watermark=lambda wav, sample_rate=None: wav)
        from chatterbox import mtl_tts
        from chatterbox.models.s3gen import S3Gen
        from chatterbox.models.t3 import T3
        from chatterbox.models.t3.modules.t3_config import T3Config
        from chatterbox.models.tokenizers import MTLTokenizer
        from chatterbox.models.voice_encoder import VoiceEncoder
        from safetensors.torch import load_file

        f = files(folder)
        dev = "cuda"
        ve = VoiceEncoder()
        ve.load_state_dict(load_file(f["ve.safetensors"]))
        t3 = T3(T3Config.multilingual())
        t3.load_state_dict(load_file(f["t3_mtl23ls_v2.safetensors"]))
        s3 = S3Gen()
        s3.load_state_dict(load_file(f["s3gen.safetensors"]), strict=False)
        conds = mtl_tts.Conditionals.load(f["conds.pt"]).to(dev)
        self._tts = mtl_tts.ChatterboxMultilingualTTS(
            t3.to(dev).eval(), s3.to(dev).eval(), ve.to(dev).eval(),
            MTLTokenizer(f["mtl_tokenizer.json"]), dev, conds=conds)
        self._torch = torch
        self._lock = threading.Lock()
        self.exaggeration = exaggeration
        self.synth("هلا.")   # the first generation is slow

    def synth(self, text: str, voice: str = "saudi",
              speed: float = 1.0) -> np.ndarray:
        """float32 @ 24 kHz. (Chatterbox has no speed control; speed is
        ignored.)"""
        from arabic_tts import spell_numbers
        text = spell_numbers(text.strip())
        if not text:
            return np.zeros(int(0.15 * OUT_RATE), np.float32)
        with self._lock, self._torch.inference_mode():
            wav = self._tts.generate(text, language_id="ar",
                                     exaggeration=self.exaggeration)
        pcm = wav.squeeze(0).float().cpu().numpy().astype(np.float32)
        if self._tts.sr != OUT_RATE:
            from arabic_tts import resample
            pcm = resample(pcm, self._tts.sr, OUT_RATE)
        return pcm
