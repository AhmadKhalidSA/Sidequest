"""config.json loader. Missing keys fall back to DEFAULTS, so a hand-edited
config with only a few fields still works."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COURSES = Path(os.environ.get("SIDEQUEST_COURSES") or ROOT / "courses")

# SIDEQUEST_TEST=1: silent self-test (no audio out, no hotkeys, CPU whisper)
# so the engine can be exercised while the GPU and mouse belong to a game.
TEST = os.environ.get("SIDEQUEST_TEST") == "1"

DEFAULTS = {
    # Where kokoro-v1.0.onnx and voices-v1.0.bin live ("" = <repo>/models).
    "modelsDir": "",
    "keys": {"mute": "MOUSE5", "interact": "F8", "hide": "F9", "big": "F10",
             "mode": "F7"},
    "brain": {"model": "sonnet", "thinking": False, "plannerModel": "opus",
              "directorModel": "sonnet"},
    "lesson": {"autoContinue": True, "autoContinueSeconds": 3,
               "maxAutoChunks": 0,
               # Streaming-style sync: before speaking, wait (up to N s) for
               # the first K drawings to be ready; mid-answer, pause the voice
               # (up to M s) at a drawing that isn't ready yet. 0 disables.
               "prebufferSeconds": 8, "prebufferVisuals": 3,
               "visualWaitSeconds": 6,
               # Point at each new drawing as the voice starts on it.
               "followAlong": True},
    "stt": {"model": "distil-large-v3", "device": "auto", "language": "en"},
    "tts": {"engine": "kokoro", "voice": "af_heart", "speed": 1.0},
    "audio": {"inputDevice": None, "outputDevice": None, "endSilenceMs": 1600,
              "smartTurn": True},
    "mirror": {"enabled": False, "port": 5199, "allowControl": False},
}


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load() -> dict:
    path = ROOT / "config.json"
    try:
        user = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        user = {}
    cfg = _merge(DEFAULTS, user)
    if "pushToTalk" in cfg["keys"] and "mute" not in user.get("keys", {}):
        cfg["keys"]["mute"] = cfg["keys"].pop("pushToTalk")
    cfg["keys"].pop("pushToTalk", None)
    if TEST and not os.environ.get("SIDEQUEST_TEST_REAL_STT"):
        cfg["stt"].update(model="small.en", device="cpu")
    return cfg


def models_dir(cfg: dict) -> Path:
    """The Kokoro model folder: modelsDir if set, else <repo>/models."""
    if cfg.get("modelsDir"):
        return Path(cfg["modelsDir"])
    return ROOT / "models"
