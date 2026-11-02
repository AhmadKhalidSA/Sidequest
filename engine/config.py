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
    # "busy" toggles fight mode (quick recall only); "" leaves a key unbound.
    "keys": {"mute": "MOUSE5", "interact": "F8", "hide": "F9", "big": "F10",
             "mode": "F7", "busy": "F6"},
    "brain": {"model": "sonnet", "thinking": False, "plannerModel": "opus",
              "directorModel": "sonnet"},
    "lesson": {"autoContinue": True, "autoContinueSeconds": 3,
               "maxAutoChunks": 0,
               # Streaming-style sync: before speaking, wait (up to N s) for
               # the first K drawings to be ready; mid-answer, pause the voice
               # (up to M s) at a drawing that isn't ready yet. 0 disables.
               "prebufferSeconds": 4, "prebufferVisuals": 1,
               "visualWaitSeconds": 6,
               # Point at each new drawing as the voice starts on it.
               "followAlong": True,
               # Prepare the session's opening in the background at launch,
               # so "let's start" begins instantly.
               "warmStart": True,
               # A second voice (tts.voice2) co-hosts: asks, jokes, gets
               # things wrong for the learner to fix.
               "cohost": False,
               # default | hype | dry | calm
               "persona": "default",
               "difficulty": 3, "humor": 3,           # 1-5, also set by voice
               # "auto" follows the learner's language; or "en" / "ar"
               "teachLanguage": "auto",
               # Weekdays that don't break the streak, e.g. ["Fri"]
               "restDays": [],
               # Kids mode: characters and stickers instead of text, short
               # chunks, and the whole answer (drawings included) is ready
               # before it starts talking.
               "kidsMode": False, "kidName": ""},
    # Pause the voice while a fight is on (from key-press rate and screen
    # motion; only while a full-screen game is in front).
    "lull": {"auto": True, "fightAt": 0.6, "calmAt": 0.3},
    # language: "en", "ar" or "auto" (Arabic and English). Anything but "en"
    # swaps an English-only model for multilingualModel.
    "stt": {"model": "distil-large-v3", "device": "auto", "language": "en",
            "autoLanguages": ["en", "ar"],
            # Whisper large-v3-turbo fine-tuned on 13 Arabic dialects (incl.
            # Saudi/Gulf); English still works. Apache-2.0.
            "multilingualModel": "parseh/whisper-ar-dialectal-ct2"},
    # voice2: the co-host; voice3: role-play characters. Arabic lines go to
    # Supertonic 3 (arabicVoice "" = picked to match each Kokoro voice;
    # arabicDir "" = <modelsDir>/supertonic-3).
    "tts": {"engine": "kokoro", "voice": "af_heart", "speed": 1.0,
            "voice2": "bf_emma", "voice3": "am_michael",
            # arabicEngine "saudi" = NAMAA Saudi voice on the GPU (falls back
            # to Supertonic 3 on the CPU when it can't load).
            "arabicEngine": "saudi", "saudiDir": "", "arabicExpressive": 0.5,
            "arabic": True, "arabicVoice": "", "arabicDir": "",
            "arabicThreads": 4, "arabicSteps": 5},
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
        small = "small.en" if cfg["stt"].get("language", "en") == "en" \
            else "small"
        cfg["stt"].update(model=small, device="cpu", multilingualModel="small")
    return cfg


def models_dir(cfg: dict) -> Path:
    """The Kokoro model folder: modelsDir if set, else <repo>/models."""
    if cfg.get("modelsDir"):
        return Path(cfg["modelsDir"])
    return ROOT / "models"
