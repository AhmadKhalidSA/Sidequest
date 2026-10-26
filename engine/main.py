"""Sidequest engine — the conductor.

Spawned by the Electron overlay. Talks to it over stdio: JSON lines OUT
(stdout) are events for the overlay, JSON lines IN (stdin) are commands from
its buttons. stderr is the log (overlay writes it to logs/engine.log).

Conversation, not walkie-talkie:
  - Always listening (Silero VAD). The moment you start talking, the tutor
    pauses mid-word. When you finish (~0.7 s of silence) Whisper transcribes.
  - "yeah" / "okay" / a cough -> it carries on from where it paused.
    A real question -> it drops what it was saying and answers.
    "pause" / "wait" -> it stops; "continue" -> it picks the lesson back up.
  - It says a quick "okay" / "mm-hm" the instant it has your words, and
    "still working on it" if Claude takes more than a few seconds.
  - Mouse 5 mutes / unmutes its ears (for team voice chat).

Turn pipeline: Tutor.reply() stream -> say items go to a one-thread TTS
executor immediately (synthesis runs ahead of playback), board items wait in
order -> player walks the queue: fires board commands when the voice reaches
them, plays each sentence, shows it as a subtitle.
"""

from __future__ import annotations

import asyncio
import collections
import copy
import json
import os
import random
import re
import shutil
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import config  # noqa: E402
from keys import KeyWatcher, pretty  # noqa: E402
from prompts import (BUTTONS, CONTINUE, KICKOFF, NO_MATERIAL_KICKOFF,  # noqa: E402
                     PLAN_READY, PLANNING_KICKOFF)

# Instant acknowledgements. Real words only: the voice mangles "Mm-hm".
ACKS = ["Okay.", "Sure.", "Got it.", "Right.", "Okay, one sec.",
        "Good question.", "Let me think."]
NUDGES = ["One sec, getting it ready.", "Almost there."]
NUDGE_AFTER = 7.0
# Board ops that don't draw anything (they don't count as buffered visuals).
NON_VISUAL = {"clear", "section", "result", "quiz", "erase", "unfocus",
              "unzoom", "spot"}
# Ops where the tutor is already pointing at something itself; the
# follow-along pointer stays out of the way after these.
POINTING = {"highlight", "focus", "callout", "zoom", "annotate", "pulse", "fx",
            "cursor", "move", "anim"}
# Said while the tutor is talking: just listening noises, keep going.
# (Short, no question, starts with one of these: "yeah", "yes sir", "ok cool".)
BACKCHANNEL = re.compile(
    r"^(yeah|yes|yep|yup|okay|ok|mm+-?hm+|uh-huh|right|sure|cool|nice|"
    r"got it|i see|alright|all right|makes sense|true|go on)\b", re.I)
PAUSE = re.compile(r"^((can|could|would) you |please |just )?(pause|stop|wait|"
                   r"hold on|hang on|one sec(ond)?|shut up|be quiet|quiet|"
                   r"not now)\b", re.I)
# "see my screen" / "look at this": screenshot the monitor under the cursor.
SEE_SCREEN = re.compile(
    r"(see|look at|check|read|watch|describe|what'?s on|what is on)\s+"
    r"(my|the|this)\s+(screen|monitor|display)|see what i'?m (seeing|looking"
    r" at)|what am i (seeing|looking at)|\blook at this\b|on my screen", re.I)
# Hesitation sounds on their own: not a message, keep listening.
HESITATION = re.compile(r"^(h+m+|m+h*m*|u+h+|u+m+|e+r+m*|a+h+|o+h+)$", re.I)
# A sentence ending in one of these is almost certainly unfinished: hold it
# and merge with what comes next instead of answering half a thought.
UNFINISHED_END = {"and", "but", "so", "like", "because", "the", "a", "an",
                  "to", "of", "or", "then", "is", "are", "was", "what", "how",
                  "why", "if", "when", "that", "this", "with", "in", "on",
                  "for", "my", "i", "it's", "its", "um", "uh", "hmm", "mm",
                  "er", "which", "about", "from", "by", "as", "at", "into"}
HOLD_SECONDS = 2.5


def hesitation_only(text: str) -> bool:
    words = re.findall(r"[a-z']+", text.lower())
    return not words or all(HESITATION.match(w) for w in words)


def unfinished(text: str) -> bool:
    t = text.strip()
    if t.endswith(("...", "…", ",", "-")):
        return True
    words = re.findall(r"[a-z']+", t.lower())
    return bool(words) and words[-1] in UNFINISHED_END and not t.endswith(
        ("?", "!"))
RESUME = re.compile(r"^(continue|go on|resume|keep going|carry on|go ahead|"
                    r"unpause|let's go|next)\b", re.I)
START = re.compile(r"^(ok(ay)?[,.!]?\s*)?(so\s+)?(let'?s |lets |can we |shall we )?"
                   r"(start|begin|get started|kick off)\b", re.I)
# "let's learn about X" / "teach me X" / "new topic: X" -> a course for X, made
# on the spot, planned from knowledge (and the web, if it's new).
LEARN_NEW = re.compile(
    r"^(ok(ay)?[,.!]?\s*)?(so\s+)?(?:"
    r"(?:let'?s |lets |i want to |i'?d like to |i wanna |can we |could we )"
    r"(?:learn|study)(?: about| something about| more about)?"
    r"|teach me(?: about)?|new (?:topic|course|subject)[:,]?(?: about)?"
    r")\s+(?P<topic>.{3,120})$", re.I)
MERGE_WINDOW = 15.0   # s: a sentence spoken before the tutor starts answering
                      # belongs to the same question
STOP_LISTENING = re.compile(r"^(stop listening|mute( yourself| the mic| mic)?|"
                            r"mic off|turn off (the |your )?mic)\b", re.I)
DOCK_CMD = re.compile(r"^(dock( it| the panel| yourself)?|exit full ?screen|"
                      r"(go )?back to (the )?corner|small(er)? (screen|panel))\b",
                      re.I)
FULL_CMD = re.compile(r"^((go |make it )?full ?screen|make it (big|bigger))\b",
                      re.I)
LECTURE_MODE = re.compile(r"^(lecture mode|auto mode|keep teaching|keep talking"
                          r"|talk on your own)\b", re.I)
WAIT_MODE = re.compile(r"^(wait mode|question mode|q and a mode|wait for me|"
                       r"don't continue|only answer)\b", re.I)


def quiz_speech(cmd: dict) -> str:
    """The quiz card, read aloud by the app so it's never silently skipped."""
    q = str(cmd.get("q", "")).strip()
    choices = [str(c) for c in cmd.get("choices") or []]
    if not choices:
        return q
    opts = ", or ".join(f"{chr(65 + i)}: {c}" for i, c in enumerate(choices))
    return f"{q} Is it {opts}?"
PALETTE = {"ink": "#EEF1F7", "blue": "#6CB6FF", "green": "#5BE49B",
           "red": "#FF6B6B", "amber": "#FFC857", "purple": "#C79BFF",
           "muted": "#8B93A7"}
_out_lock = threading.Lock()


def emit(ev: str, **data) -> None:
    line = json.dumps({"ev": ev, **data}, ensure_ascii=False)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(*a) -> None:
    print(*a, file=sys.stderr, flush=True)


def list_courses() -> list[str]:
    config.COURSES.mkdir(exist_ok=True)
    return sorted(p.name for p in config.COURSES.iterdir()
                  if p.is_dir() and not p.name.startswith("."))


def safe_name(name: str) -> str:
    name = re.sub(r"[^\w\- ]+", "", name).strip().replace(" ", "-")
    return name[:60] or "course"


def short(text: str, words: int = 4) -> bool:
    return len(text.split()) <= words


class TurnBuffer:
    """The items of one answer, in order, readable AHEAD of the play head,
    which an asyncio.Queue can't do. That lookahead is what lets the voice
    wait until the next drawings are really ready (streaming-video style)."""

    def __init__(self) -> None:
        self.items: list[tuple] = []
        self.closed = False
        self.changed = asyncio.Event()
        self.first_content_at: float | None = None
        self.asked = False                       # ends on a quiz question
        self.flags = {"media": False, "motion": False}

    def put(self, item: tuple) -> None:
        if item[0] != "tool" and self.first_content_at is None:
            self.first_content_at = time.monotonic()
        self.items.append(item)
        self.changed.set()

    def close(self) -> None:
        self.closed = True
        self.changed.set()


def item_ready(item: tuple) -> bool | None:
    """True/False for a visual item (is it ready to show?), None if the item
    doesn't draw anything."""
    kind, value, fut = item
    if kind == "board":
        return None if value.get("op") in NON_VISUAL else True
    if kind == "media":
        return fut.done()
    if kind == "scene":
        return bool(fut.ops) or fut.done
    return None


class SceneJob:
    """One illustrator build in flight: the reserved rectangle, the pieces
    so far, and whether the voice has reached it (then pieces go live)."""

    def __init__(self, cmd: dict) -> None:
        self.id = cmd["id"]
        self.brief = str(cmd.get("brief", ""))
        self.rect = {"x": int(cmd.get("x", 40)), "y": int(cmd.get("y", 95)),
                     "w": int(cmd.get("w", 920)), "h": int(cmd.get("h", 460))}
        self.ops: list[dict] = []
        self.played = False
        self.done = False

    def add(self, op: dict) -> None:
        self.ops.append(op)
        if self.played:
            emit("board", cmd={"op": "scene", "id": self.id, "ops": [op],
                               "append": True})


class Engine:
    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.loop = asyncio.get_running_loop()
        self.ears = self.player = self.stt = self.tts = None
        self.tutor = None
        self.course: str | None = None
        self.turn = 0                 # bumping this makes old turns stale
        self.turn_task: asyncio.Task | None = None
        self.state = "loading"
        self.paused = False           # lesson paused ("pause" / Pause button)
        self.waiting_answer = False   # last turn asked a quiz question
        self.auto_chunks = 0          # auto-continues since learner spoke
        self.auto_handle: asyncio.TimerHandle | None = None
        self.user_talking = False
        self.cut_in = False           # started talking over an active turn
        self.state_before_talk = "idle"
        self.last_voice_at = 0.0
        self.spoke_end = 0.0
        self.measure = None   # latency marks for the current answer
        self.pending_text = ""          # an unfinished sentence being held
        self.hold_handle: asyncio.TimerHandle | None = None
        self.hold_cycles = 0
        self.last_user_text = ""        # for merging a quick continuation
        self.last_user_at = 0.0
        self.turn_spoke = False         # has the current turn said anything
        self.last_said = ""             # the tutor's latest sentence
        self.cut_off = ""               # last sentence heard before a cut-in
        # What recent answers contained, so the tutor can be reminded when
        # it goes dry: media = image/icon/scene, motion = anything moving.
        self.history: collections.deque = collections.deque(maxlen=4)
        self.tts_pool = ThreadPoolExecutor(1, thread_name_prefix="tts")
        self.pending_tts: list[asyncio.Future] = []
        self.plan_mtime = 0.0
        self.planning = False
        self.plan_pending = False   # a finished plan waiting to be presented
        self.prev_foreground = 0    # the window to give focus back to
        self.tutor_lock = asyncio.Lock()
        self.tutor_used = False
        self.director = None
        self.director_lock = asyncio.Lock()
        self.scene_n = 0

    # ---------------------------------------------------------- lifecycle
    async def boot(self) -> None:
        from voice import STT, TTS, Listener, Player
        self.set_state("loading", "Loading speech recognition...")
        self.stt = await asyncio.to_thread(STT, self.cfg["stt"])
        self.set_state("loading", "Loading voice...")
        self.tts = await asyncio.to_thread(TTS, self.cfg["tts"],
                                           config.models_dir(self.cfg))
        self.player = Player(self.cfg["audio"].get("outputDevice"))
        # Instant spoken acknowledgements, ready before anyone speaks.
        self.acks = await asyncio.to_thread(
            lambda: [self.tts.synth(t) for t in ACKS])
        self.nudge_clips = await asyncio.to_thread(
            lambda: [self.tts.synth(t) for t in NUDGES])

        turn = None
        if self.cfg["audio"].get("smartTurn", True):
            self.set_state("loading", "Loading turn detection...")
            try:
                from voice import SmartTurn
                turn = await asyncio.to_thread(SmartTurn)
                log("smart turn ready")
            except Exception as e:  # noqa: BLE001
                log(f"smart turn unavailable, fixed timeout: {e!r}")
        call = self.loop.call_soon_threadsafe
        self.ears = Listener(
            self.cfg["audio"].get("inputDevice"),
            int(self.cfg["audio"].get("endSilenceMs", 1000)),
            on_start=lambda: call(self.on_speech_start),
            on_cancel=lambda: call(self.on_speech_cancel),
            on_utterance=lambda pcm: call(self.on_utterance, pcm),
            turn=turn)
        if config.TEST:
            self.ears._stream.stop()  # self-tests must never hear the room
        elif not (self.cfg["audio"].get("inputDevice")
                  or self.cfg["audio"].get("outputDevice")):
            from voice import DeviceWatcher
            DeviceWatcher(lambda: call(self.on_devices_changed))

        self.keywatcher = None
        self.start_keys()
        emit("ears", on=True)
        emit("mode", auto=bool(self.cfg["lesson"].get("autoContinue")))
        courses = list_courses()
        if not courses:
            # Nothing to pick: a blank course, so "let's learn about X" or
            # a dropped file has somewhere to land.
            (config.COURSES / "general" / "materials").mkdir(parents=True,
                                                             exist_ok=True)
            courses = list_courses()
        self.send_courses()
        last = config.ROOT / "logs" / "last_course.txt"
        pick = last.read_text().strip() if last.exists() else ""
        pick = os.environ.get("SIDEQUEST_COURSE") or pick   # tests pin one
        if pick not in courses and courses:
            pick = courses[0]  # never start with nothing selected
        if pick:
            await self.select_course(pick, announce=False)
        self.set_state("idle")
        asyncio.create_task(self.meter())
        asyncio.create_task(self.start_director())  # pre-connect the illustrator
        auto = os.environ.get("SIDEQUEST_AUTOTEXT")
        if auto and courses:
            self.start_turn(auto)
        if config.TEST and os.environ.get("SIDEQUEST_FEED"):
            asyncio.create_task(self.feed(os.environ["SIDEQUEST_FEED"]))

    async def feed(self, spec: str) -> None:
        """Self-test: "a.wav@0,b.wav@12" plays 16 kHz wavs into the listener
        at those seconds, in real time, as if spoken into the mic."""
        import wave

        import numpy as np
        t0 = time.monotonic()
        for part in spec.split(","):
            path, _, at = part.partition("@")
            await asyncio.sleep(max(0.0, float(at or 0) - (time.monotonic()
                                                            - t0)))
            log(f"[feed] {Path(path).name} at {time.monotonic() - t0:.1f}s")
            with wave.open(path) as w:
                pcm = np.frombuffer(w.readframes(w.getnframes()),
                                    np.int16).astype(np.float32) / 32768
            pcm = np.concatenate([pcm, np.zeros(16000, np.float32)])
            for i in range(0, len(pcm) - 511, 512):
                self.ears._q.put(pcm[i:i + 512])
                await asyncio.sleep(0.032)

    def start_keys(self) -> None:
        if self.keywatcher:
            self.keywatcher.stop()
        self.keys = dict(self.cfg["keys"])
        if not config.TEST:
            call = self.loop.call_soon_threadsafe
            self.keywatcher = KeyWatcher(
                self.keys, lambda a, d: call(self.on_key, a, d))
            self.keywatcher.start()
        emit("ready", keys={k: pretty(v) for k, v in self.keys.items()},
             stt=self.stt.desc, tts=self.tts.desc,
             model=self.cfg["brain"]["model"])

    # ----------------------------------------------------------- settings
    def save_user_config(self, patch: dict) -> None:
        """Merge a patch into config.json (keeping anything hand-edited)."""
        path = config.ROOT / "config.json"
        try:
            user = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            user = {}
        path.write_text(json.dumps(config._merge(user, patch), indent=2),
                        encoding="utf-8")
        self.cfg = config._merge(self.cfg, patch)

    def send_settings(self) -> None:
        try:
            voices = sorted(self.tts._kokoro.get_voices())
        except Exception:  # noqa: BLE001
            voices = [self.cfg["tts"].get("voice", "af_heart")]
        emit("settings", voices=voices, cfg={
            k: self.cfg.get(k) for k in ("keys", "brain", "lesson", "stt",
                                         "tts", "audio", "mirror")})

    async def apply_settings(self, patch: dict) -> None:
        from keys import vk
        for name in (patch.get("keys") or {}).values():
            try:
                vk(name)
            except ValueError as e:
                emit("error", text=str(e))
                return
        old = copy.deepcopy(self.cfg)
        self.save_user_config(patch)
        if "tts" in patch and hasattr(self.tts, "_voice"):
            self.tts._voice = self.cfg["tts"].get("voice", self.tts._voice)
            self.tts._speed = float(self.cfg["tts"].get("speed", 1.0))
            self.tts.desc = f"Kokoro {self.tts._voice}"
            self.acks = await asyncio.to_thread(
                lambda: [self.tts.synth(t) for t in ACKS])
            self.nudge_clips = await asyncio.to_thread(
                lambda: [self.tts.synth(t) for t in NUDGES])
        if "endSilenceMs" in patch.get("audio", {}):
            from voice import FRAME_MS
            self.ears._end_frames = max(
                8, int(self.cfg["audio"]["endSilenceMs"]) // FRAME_MS)
        if "keys" in patch or "tts" in patch:
            self.start_keys()  # also re-sends "ready" with the new names
        if self.tutor and any(old["brain"].get(k) != self.cfg["brain"].get(k)
                              for k in ("model", "thinking")):
            # Reconnect on the new model at the next turn; the conversation
            # itself resumes from the saved session.
            self.interrupt()
            await self.tutor.stop()
            self.tutor = None
        if (self.director and old["brain"].get("directorModel")
                != self.cfg["brain"].get("directorModel")):
            stale, self.director = self.director, None
            asyncio.create_task(stale.stop())
            asyncio.create_task(self.start_director())
        if "lesson" in patch:
            self.set_mode(bool(self.cfg["lesson"].get("autoContinue")),
                          announce=False)
        restart = (any(old["stt"].get(k) != self.cfg["stt"].get(k)
                       for k in ("model", "device"))
                   or old.get("mirror") != self.cfg.get("mirror"))
        emit("toast", text="Settings saved" + (
            ". Restart the engine to apply speech-recognition changes."
            if restart else ""))
        emit("settings_saved", restart=restart)

    def set_mode(self, auto: bool, announce: bool = True) -> None:
        """Lecture (keeps going while you're quiet) or Wait (answers, then
        waits until you talk)."""
        if self.cfg["lesson"].get("autoContinue") != auto:
            self.save_user_config({"lesson": {"autoContinue": auto}})
        emit("mode", auto=auto)
        if announce:
            emit("toast", text="Lecture mode: I'll keep going while you're "
                 "quiet" if auto else "Wait mode: I'll answer, then wait "
                 "for you")
        if auto:
            self.auto_chunks = 0
            if self.state == "idle":
                self.schedule_auto()
        else:
            self.cancel_auto()

    def set_state(self, state: str, detail: str = "") -> None:
        self.state = state
        emit("status", state=state, detail=detail, paused=self.paused)

    def send_courses(self) -> None:
        emit("courses", list=list_courses(), current=self.course)

    async def meter(self) -> None:
        """Mic level for the header meter, plus a muted-mic warning: a live
        mic always has a little noise, a muted one sends exact zeros."""
        silent_for, warned = 0.0, False
        while True:
            level = self.ears.level
            if self.user_talking:
                emit("level", v=round(level, 3))
            if self.ears.enabled and level < 0.0005 and not config.TEST:
                silent_for += 0.1
                if silent_for > 8 and not warned:
                    warned = True  # once per session: it's a hint, not a nag
                    emit("toast", text="Mic is sending pure silence. Headset "
                         "muted?")
            elif level > 0.002:
                silent_for = 0.0
            await asyncio.sleep(0.1)

    # -------------------------------------------------------------- input
    def on_key(self, action: str, down: bool) -> None:
        if not down:
            return
        if action == "mute":
            self.toggle_ears()
        elif action == "mode":
            self.set_mode(not self.cfg["lesson"].get("autoContinue"))
        else:
            emit("key", name=action)

    # ------------------------------------------------------------- focus
    # Windows won't let a background app take the foreground (the game
    # keeps it, and keeps the mouse). Attaching to the foreground thread's
    # input queue is the standard, sanctioned way around that for an app the
    # user explicitly asked to bring up (F8).
    def focus_panel(self) -> None:
        import ctypes
        u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32
        hwnd = u32.FindWindowW(None, "Sidequest")
        if not hwnd:
            return
        prev = u32.GetForegroundWindow()
        if prev and prev != hwnd:
            self.prev_foreground = prev
        fg_thread = u32.GetWindowThreadProcessId(prev, None)
        me = k32.GetCurrentThreadId()
        attached = bool(fg_thread and fg_thread != me
                        and u32.AttachThreadInput(me, fg_thread, True))
        try:
            u32.ShowWindow(hwnd, 5)            # SW_SHOW
            u32.BringWindowToTop(hwnd)
            u32.SetForegroundWindow(hwnd)
        finally:
            if attached:
                u32.AttachThreadInput(me, fg_thread, False)
        log(f"focus panel: {'ok' if u32.GetForegroundWindow() == hwnd else 'refused'}")

    def restore_focus(self) -> None:
        """Back to whatever had focus before (the game), after F8 closes."""
        import ctypes
        u32 = ctypes.windll.user32
        if self.prev_foreground and u32.IsWindow(self.prev_foreground):
            u32.SetForegroundWindow(self.prev_foreground)
        self.prev_foreground = 0

    def on_devices_changed(self) -> None:
        """You switched the Windows default device: follow it, mid-sentence."""
        from voice import output_name, reinit_portaudio
        try:
            self.player.close()
            self.ears.close()
            reinit_portaudio()
            self.player.open()
            self.ears.open()
        except Exception as e:  # noqa: BLE001
            log(f"device switch failed: {e!r}")
            emit("error", text=f"Couldn't switch audio device: {e}")
            return
        name = output_name()
        log(f"audio devices changed -> output now {name}")
        emit("toast", text=f"Sound now on: {name}")

    def toggle_ears(self) -> None:
        self.set_ears(not self.ears.enabled)

    def set_ears(self, on: bool) -> None:
        """Mic only. The lesson itself keeps going."""
        self.ears.enabled = on
        emit("ears", on=on)
        emit("toast", text="Mic on: just talk" if on else
             f"Mic off. Click the mic or press {pretty(self.keys['mute'])} "
             "to turn it back on")
        if not on and self.user_talking:
            self.on_speech_cancel()

    def turn_active(self) -> bool:
        return bool(self.turn_task and not self.turn_task.done()) \
            or not self.player.done.is_set()

    def on_speech_start(self) -> None:
        """You started talking: hold the tutor mid-word and listen."""
        if self.hold_handle:            # you continued the held sentence
            self.hold_handle.cancel()
            self.hold_handle = None
        self.user_talking = True
        self.cut_in = self.turn_active() if not self.pending_text else self.cut_in
        self.state_before_talk = self.state
        self.cancel_auto()
        self.player.pause()
        self.set_state("listening")

    def on_speech_cancel(self) -> None:
        """Only a noise: carry on as if nothing happened."""
        self.user_talking = False
        self.player.resume()
        self.set_state(self.state_before_talk)
        if self.state == "idle":
            self.schedule_auto()

    def on_utterance(self, audio) -> None:
        self.user_talking = False
        self.spoke_end = time.monotonic()
        asyncio.create_task(self.hear(audio))

    def since_spoke(self) -> int:
        return int((time.monotonic() - self.spoke_end) * 1000)

    async def hear(self, audio) -> None:
        self.set_state("transcribing")
        text = await asyncio.to_thread(self.stt.transcribe, audio,
                                       self.whisper_hint())
        log(f"you said: {text!r} ({len(audio) / 16000:.1f}s) "
            f"[transcribed {self.since_spoke()} ms after you stopped]")
        if self.pending_text:
            text = f"{self.pending_text} {text}".strip()
            self.pending_text = ""
        if self.user_talking:
            self.pending_text = text    # you kept going: merge with the rest
            return
        doubtful = (len(audio) < 16000 * 2.0 and short(text, 3) and
                    (getattr(self.stt, "no_speech", 0) > 0.6
                     or getattr(self.stt, "logprob", 0) < -1.1))
        if doubtful:
            log(f"  (ignored as a hesitation: no_speech="
                f"{self.stt.no_speech:.2f} logprob={self.stt.logprob:.2f})")
        if not text or hesitation_only(text) or doubtful:
            # "hmmm…" is thinking, not talking. Keep listening quietly.
            if self.cut_in:
                self.set_state("listening", "go on...")
            else:
                self.on_speech_cancel()
            return
        await self.handle_text(text)

    def flush_hold(self) -> None:
        self.hold_handle = None
        text, self.pending_text = self.pending_text, ""
        if text and not self.user_talking:
            asyncio.create_task(self.handle_text(text, allow_hold=False))

    async def handle_text(self, text: str, allow_hold: bool = True) -> None:
        if allow_hold and unfinished(text) and self.hold_cycles < 3:
            # Sounds unfinished: give them a moment to complete the thought.
            self.hold_cycles += 1
            self.pending_text = text
            emit("heard", text=f"{text} …")
            self.set_state("listening", "go on...")
            self.hold_handle = self.loop.call_later(HOLD_SECONDS,
                                                    self.flush_hold)
            return
        self.hold_cycles = 0
        if SEE_SCREEN.search(text):
            await self.look_at_screen(text)
            return
        if (DOCK_CMD.match(text) or FULL_CMD.match(text)) and short(text, 6):
            emit("heard", text=text)
            self.on_speech_cancel()
            emit("key", name="dock" if DOCK_CMD.match(text) else "full")
            return
        if (LECTURE_MODE.match(text) or WAIT_MODE.match(text)) \
                and short(text, 6):
            emit("heard", text=text)
            self.on_speech_cancel()
            self.set_mode(bool(LECTURE_MODE.match(text)))
            return
        if STOP_LISTENING.match(text) and short(text, 5):
            emit("heard", text=text)
            self.on_speech_cancel()  # the lesson carries on; only the mic stops
            self.set_ears(False)
            return
        if PAUSE.match(text) and short(text):
            emit("heard", text=text)
            self.interrupt()
            self.paused = True
            await self.speak("Okay, paused. Say continue when you're ready.")
            self.set_state("paused")
            return
        if RESUME.match(text) and short(text) and (self.paused or not
                                                   self.cut_in):
            emit("heard", text=text)
            self.paused = False
            self.auto_chunks = 0
            self.start_turn(CONTINUE, auto=True)
            self.player.start_clip(random.choice(self.acks))
            return
        if (self.cut_in and BACKCHANNEL.match(text) and short(text, 3)
                and "?" not in text and not self.last_said.rstrip().endswith("?")):
            # A listening noise while the tutor explains: carry on. (But if
            # the tutor just asked a question, "yeah" is the ANSWER.)
            emit("heard", text=text)
            self.player.resume()
            self.set_state(self.state_before_talk)
            return
        m = LEARN_NEW.match(text)
        if m:
            await self.new_topic(m.group("topic"), text)
            return
        if (self.cut_in and not self.turn_spoke and self.last_user_text
                and time.monotonic() - self.last_user_at < MERGE_WINDOW):
            # They kept talking before the tutor answered: same question.
            log("merged with the previous message (tutor hadn't answered yet)")
            text = f"{self.last_user_text} {text}"
        self.last_user_text, self.last_user_at = text, time.monotonic()
        emit("heard", text=text, turn=True)
        self.paused = False
        if START.match(text) and short(text, 6):
            text = KICKOFF   # "okay let's start" = the Start button
        self.start_turn(text)
        self.player.start_clip(random.choice(self.acks))
        self.measure = {"turn": self.turn, "ack": self.since_spoke()}

    # -------------------------------------------------------- new topics
    async def new_topic(self, topic: str, utterance: str) -> None:
        """A course made from a sentence: folder, a one-line brief as its
        only material, planner in the background, tutor starts at once."""
        topic = topic.strip().rstrip(".!?,")
        name = safe_name(topic).lower()
        if len(name) > 40:   # cut at a word, not mid-word
            name = name[:40].rsplit("-", 1)[0]
        name = name.strip("-") or "topic"
        folder = config.COURSES / name
        (folder / "materials").mkdir(parents=True, exist_ok=True)
        brief = folder / "materials" / "topic.md"
        if not self.has_materials(folder):
            brief.write_text(
                f"# {topic}\n\nThe learner asked: \"{utterance}\"\n\n"
                f"No material was provided. Plan this from knowledge, and "
                f"research it first if the topic is recent, niche or "
                f"uncertain.\n", encoding="utf-8")
        emit("heard", text=utterance, turn=True)
        self.player.start_clip(random.choice(self.acks))
        await self.select_course(name, announce=False)
        emit("toast", text=f"New course: {name}")
        self.paused = False
        self.last_user_text, self.last_user_at = "", 0.0
        if self.plan_exists():
            self.start_turn(KICKOFF)
        else:
            self.start_turn(f"{KICKOFF}\n[sidequest] The learner just asked to "
                            f"learn about: {topic}. Don't wait for the plan: "
                            f"begin right away with a first taste (a hook and "
                            f"the first idea, with a board), and research it "
                            f"first if it's recent or you're unsure.")

    # ------------------------------------------------------------- screen
    async def look_at_screen(self, text: str) -> None:
        """Screenshot the monitor under the cursor (panel hidden for the
        shot) and hand it to the tutor as an image file to Read."""
        emit("heard", text=text, turn=True)
        self.interrupt()
        self.paused = False
        self.player.start_clip(random.choice(self.acks))
        try:
            path = await self.capture_screen()
        except Exception as e:  # noqa: BLE001
            log(f"screenshot failed: {e!r}")
            emit("error", text=f"Couldn't take a screenshot: {e}")
            return
        self.start_turn(
            f"[sidequest] Screenshot of the learner's screen (the monitor "
            f"under their cursor) is saved at {path}. Read that image file "
            f"FIRST, then respond to what they said: \"{text}\". Talk about "
            f"what you actually see; point at the relevant part on the board "
            f"(redraw or describe its location). If what they mean is "
            f"unclear, ask.")

    async def capture_screen(self) -> str:
        import ctypes
        from ctypes import wintypes

        import mss
        from PIL import Image

        pt = wintypes.POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))

        def grab() -> Image.Image:
            with mss.mss() as sct:
                mons = sct.monitors[1:] or sct.monitors
                mon = next((m for m in mons
                            if m["left"] <= pt.x < m["left"] + m["width"]
                            and m["top"] <= pt.y < m["top"] + m["height"]),
                           mons[0])
                shot = sct.grab(mon)
                return Image.frombytes("RGB", shot.size, shot.rgb)

        emit("capture", on=True)        # the panel hides for the shot
        try:
            await asyncio.sleep(0.3)
            img = await asyncio.to_thread(grab)
        finally:
            emit("capture", on=False)
        if img.width > 1600:
            img = img.resize((1600, round(img.height * 1600 / img.width)),
                             Image.LANCZOS)
        folder = config.ROOT / "cache"
        folder.mkdir(exist_ok=True)
        path = folder / f"screen-{time.strftime('%H%M%S')}.jpg"
        await asyncio.to_thread(img.save, path, "JPEG", quality=82)
        log(f"screenshot {img.width}x{img.height} -> {path.name}")
        return str(path)

    async def speak(self, text: str) -> None:
        """One-off spoken line outside a lesson turn (errors, notices)."""
        pcm = await self.loop.run_in_executor(self.tts_pool, self.tts.synth,
                                              text)
        emit("say", text=text)
        self.player.start_clip(pcm)

    def whisper_hint(self) -> str:
        """Bias Whisper toward this course's vocabulary."""
        plan = self.load_plan()
        if not plan:
            return ""
        titles = ", ".join(s.get("title", "") for s in plan.get("sections", []))
        return f"{plan.get('title', '')}: {titles}"[:400]

    async def on_command(self, msg: dict) -> None:
        cmd = msg.get("cmd")
        if cmd == "text" and msg.get("text", "").strip():
            emit("heard", text=msg["text"].strip())
            self.paused = False
            self.start_turn(msg["text"].strip())
        elif cmd == "button":
            name = msg.get("name")
            if name == "pause":
                if self.paused:
                    self.paused = False
                    self.auto_chunks = 0
                    self.start_turn(CONTINUE, auto=True)
                else:
                    self.interrupt()
                    self.paused = True
                    self.set_state("paused")
            elif name == "screen":
                await self.look_at_screen(
                    "[the learner pressed 'Look at my screen': describe what's "
                    "relevant and ask what they want to know about it]")
            elif name in BUTTONS:
                self.paused = False
                self.start_turn(BUTTONS[name])
        elif cmd == "mute":
            self.toggle_ears()
        elif cmd == "focus_panel":
            self.focus_panel()
        elif cmd == "restore_focus":
            self.restore_focus()
        elif cmd == "mode":
            self.set_mode(bool(msg.get("auto")))
        elif cmd == "get_settings":
            self.send_settings()
        elif cmd == "save_settings":
            await self.apply_settings(msg.get("patch") or {})
        elif cmd == "goto":
            plan = self.load_plan() or {}
            idx = int(msg.get("index", 0) or 0)
            secs = plan.get("sections", [])
            if 1 <= idx <= len(secs):
                self.paused = False
                self.start_turn(
                    f"[sidequest] The learner picked section {idx} "
                    f"(\"{secs[idx - 1].get('title', '')}\") from the index. "
                    f"Jump there now: @section, @clear, and start teaching it.")
        elif cmd == "outline" and self.course:
            path = config.COURSES / self.course / "materials" / "outline.md"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(msg.get("text", "").strip() + "\n",
                            encoding="utf-8")
            emit("outline", text=msg.get("text", ""))
            self.replan("The learner just gave the course outline "
                        "(materials/outline.md).")
        elif cmd == "replan":
            self.replan("The learner asked for the course to be re-planned.")
        elif cmd == "course":
            await self.select_course(msg.get("name", ""))
        elif cmd == "new_course":
            name = safe_name(msg.get("name", ""))
            (config.COURSES / name / "materials").mkdir(parents=True,
                                                        exist_ok=True)
            await self.select_course(name)
        elif cmd == "add_files":
            self.add_files(msg.get("paths", []))

    def add_files(self, paths: list[str]) -> None:
        if not self.course:
            emit("toast", text="Pick or create a course first")
            return
        dest = config.COURSES / self.course / "materials"
        dest.mkdir(parents=True, exist_ok=True)
        added = []
        for p in paths:
            src = Path(p)
            if src.is_file():
                shutil.copy2(src, dest / src.name)
                added.append(src.name)
            elif src.is_dir():
                shutil.copytree(src, dest / src.name, dirs_exist_ok=True)
                added.append(src.name + "/")
        if not added:
            return
        emit("toast", text=f"Added {', '.join(added)} to {self.course}")
        if self.tutor and (config.COURSES / self.course / "plan.json").exists():
            self.start_turn(
                f"[sidequest] New material was added to materials/: "
                f"{', '.join(added)}. Skim it, fold it into plan.json where "
                f"it fits, and tell the learner in one sentence.")

    # ------------------------------------------------------------- course
    async def select_course(self, name: str, announce: bool = True) -> None:
        if not name or name not in list_courses():
            return
        if name == self.course and self.tutor:
            return
        self.interrupt()
        if self.tutor:
            await self.tutor.stop()
            self.tutor = None
        self.course = name
        if not config.TEST:
            (config.ROOT / "logs").mkdir(exist_ok=True)
            (config.ROOT / "logs" / "last_course.txt").write_text(name)
        self.plan_mtime = 0.0
        self.send_courses()
        emit("board", cmd={"op": "clear", "title": name})
        self.push_plan()
        self.send_outline()
        asyncio.create_task(self.ensure_tutor(quiet=True))  # pre-connect
        if announce:
            emit("toast", text=f"Course: {name}. Press Start, or just say "
                 "let's start.")

    async def ensure_tutor(self, quiet: bool = False) -> bool:
        """Connect the tutor once. quiet=True is the background pre-connect
        at startup / course switch, so your first question doesn't pay the
        ~1.5 s Claude Code spawn."""
        if self.tutor:
            return True
        async with self.tutor_lock:
            if self.tutor:
                return True
            return await self._connect_tutor(quiet)

    async def _connect_tutor(self, quiet: bool) -> bool:
        if not self.course:
            if quiet:
                return False
            emit("error", text="No course yet: press F8 and create one")
            await self.speak("There's no course yet. Press F8 and create one, "
                             "then drop your material on the panel.")
            self.set_state("idle")
            return False
        from brain import Tutor
        if not quiet:
            self.set_state("thinking", "Connecting to Claude...")
        course = self.course
        tutor = Tutor(config.COURSES / course, self.cfg)
        try:
            await tutor.start()
        except Exception as e:  # noqa: BLE001
            log(f"Claude connect failed: {e!r}")
            if not quiet:
                emit("error", text=f"Couldn't start Claude Code: {e}")
                await self.speak("I couldn't reach Claude. Check the engine log.")
                self.set_state("idle")
            return False
        if course != self.course:   # switched course while connecting
            await tutor.stop()
            return False
        self.tutor = tutor
        self.tutor_used = False
        log(f"tutor connected ({'resumed' if tutor.resumed else 'new'} "
            f"conversation){' in the background' if quiet else ''}")
        return True

    # ------------------------------------------------------------ planner
    def plan_exists(self) -> bool:
        return bool(self.course) and (config.COURSES / self.course /
                                      "plan.json").exists()

    def has_materials(self, course_dir: Path | None = None) -> bool:
        if course_dir is None:
            if not self.course:
                return False
            course_dir = config.COURSES / self.course
        folder = course_dir / "materials"
        return folder.is_dir() and any(p.is_file() for p in folder.rglob("*"))

    def start_planner(self) -> None:
        """Kick off the deep-thinking planner in the background. The tutor
        keeps talking meanwhile; when the plan lands, it presents it."""
        if self.planning or not self.course:
            return
        self.planning = True
        emit("planning", on=True, detail="Planning the course...")
        asyncio.create_task(self._plan(self.course))

    def replan(self, why: str) -> None:
        self.start_planner()
        if self.tutor:
            self.paused = False
            self.start_turn(f"[sidequest] {why} The planner is redesigning "
                            "the course in the background. Tell the learner "
                            "in one sentence, and invite questions meanwhile.")

    async def _plan(self, course: str) -> None:
        from brain import Planner
        folder = config.COURSES / course
        t0 = time.monotonic()
        primary = self.cfg["brain"].get("plannerModel", "opus")
        # If the primary planner model refuses (a topic safeguard) or dies,
        # try once more on the tutor's model, which usually goes through.
        fallback = self.cfg["brain"].get("model", "sonnet")
        models = [primary] + ([fallback] if fallback != primary else [])
        try:
            for i, model in enumerate(models):
                try:
                    summary = await Planner(folder, self.cfg, model).run(
                        on_tool=lambda label: emit(
                            "planning", on=True, detail=f"Planner: {label}"))
                    if (folder / "plan.json").exists():
                        log(f"planner ({model}) done in "
                            f"{time.monotonic() - t0:.0f}s: {summary[:200]}")
                        break
                    raise RuntimeError("finished without writing plan.json")
                except Exception as e:  # noqa: BLE001
                    if (folder / "plan.json").exists():
                        log(f"planner ({model}) reported {e!r} but plan.json "
                            f"was written; carrying on")
                        break
                    log(f"planner ({model}) failed: {e!r}")
                    if i + 1 < len(models):
                        emit("toast", text=f"Planner on {model} was blocked "
                             f"or failed; retrying with {models[i + 1]}")
                    else:
                        emit("error", text=f"Planning failed: {str(e)[:160]}")
                        return
        finally:
            self.planning = False
            emit("planning", on=False)
        if course != self.course:
            return
        self.push_plan()
        emit("toast", text="Course plan ready. Open the index to see it.")
        # Hand over when the tutor is free (not mid-sentence, not hearing
        # you). plan_pending stops a lecture queueing more chunks meanwhile.
        self.plan_pending = True
        try:
            while (self.user_talking or not self.player.done.is_set()
                   or (self.turn_task and not self.turn_task.done())):
                await asyncio.sleep(0.3)
        finally:
            self.plan_pending = False
        if course == self.course:
            self.paused = False
            self.start_turn(PLAN_READY)

    def context_brief(self) -> str:
        plan = self.load_plan()
        if not plan:
            return ("[sidequest] Context: no course plan yet (it gets built "
                    "when the learner says start).")
        cur = self.load_progress().get("section", 0)
        lines = [f"[sidequest] Context: course \"{plan.get('title', '')}\". "
                 f"{plan.get('bigPicture', '')}"]
        if plan.get("teachingStyle"):
            lines.append(f"Teaching style for this subject: "
                         f"{plan['teachingStyle']}")
        lines.append("Sections:")
        for i, s in enumerate(plan.get("sections", []), 1):
            mark = " <- current" if i == cur else ""
            lines.append(f"  {i}. {s.get('title', '')}{mark}")
        return "\n".join(lines)

    def resume_brief(self) -> str:
        """Plan, progress and notes in one message, so "start" can begin
        teaching immediately instead of reading three files first."""
        p = self.load_progress()
        notes = ""
        path = config.COURSES / self.course / "notes.md"
        if path.exists():
            notes = path.read_text(encoding="utf-8", errors="replace")[:1500]
        return (f"{self.context_brief()}\n"
                f"Progress: current section {p.get('section', 0) or 1}, done "
                f"{p.get('done', [])}, checkpoints right {p.get('correct', 0)}"
                f"/{p.get('asked', 0)}.\n"
                f"notes.md:\n{notes or '(empty)'}\n"
                f"[sidequest] That's everything; don't read files now. Start "
                f"teaching right away.")

    def teaching_style(self) -> str:
        plan = self.load_plan() or {}
        return str(plan.get("teachingStyle", "")).strip()

    def send_outline(self) -> None:
        path = config.COURSES / self.course / "materials" / "outline.md"
        emit("outline", text=path.read_text(encoding="utf-8")
             if path.exists() else "")

    # ------------------------------------------------------- plan/progress
    def load_plan(self) -> dict | None:
        if not self.course:
            return None
        try:
            return json.loads((config.COURSES / self.course / "plan.json")
                              .read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return None

    def progress_path(self) -> Path:
        return config.COURSES / self.course / "progress.json"

    def load_progress(self) -> dict:
        try:
            return json.loads(self.progress_path().read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {"section": 0, "done": [], "asked": 0, "correct": 0}

    def save_progress(self, p: dict) -> None:
        p["updated"] = time.strftime("%Y-%m-%d %H:%M")
        self.progress_path().write_text(json.dumps(p, indent=2))

    def push_plan(self) -> None:
        path = config.COURSES / self.course / "plan.json"
        mtime = path.stat().st_mtime if path.exists() else 0.0
        if mtime != self.plan_mtime:
            self.plan_mtime = mtime
            emit("plan", plan=self.load_plan(), progress=self.load_progress())

    def track(self, cmd: dict) -> None:
        """The app owns progress.json; the tutor reports through board ops."""
        op = cmd.get("op")
        if op not in ("section", "quiz", "result"):
            return
        p = self.load_progress()
        p.setdefault("done", [])
        if op == "section":
            new = int(cmd.get("index", 0) or 0)
            if p.get("section") and p["section"] != new \
                    and p["section"] not in p["done"]:
                p["done"].append(p["section"])
            p["section"] = new
        elif op == "quiz":
            p["asked"] = p.get("asked", 0) + 1
        elif op == "result" and cmd.get("correct"):
            p["correct"] = p.get("correct", 0) + 1
        self.save_progress(p)
        emit("progress", progress=p)

    # --------------------------------------------------------------- turns
    def interrupt(self) -> None:
        """Make the current turn stale and silence it. The turn task is NOT
        cancelled: it keeps draining the aborted stream (dropping items), so
        the SDK session stays in sync for the next question."""
        self.cancel_auto()
        busy = self.turn_task and not self.turn_task.done()
        if busy and self.turn_spoke and self.last_said:
            self.cut_off = self.last_said   # where the learner stopped hearing
        self.turn += 1
        self.turn_spoke = False
        if self.player:
            self.player.stop()
        for fut in self.pending_tts:
            fut.cancel()
        self.pending_tts.clear()
        if busy:
            if self.tutor:
                asyncio.create_task(self.tutor.interrupt())
            emit("interrupted")
            emit("board", cmd={"op": "spot", "clear": True})

    def cancel_auto(self) -> None:
        if self.auto_handle:
            self.auto_handle.cancel()
            self.auto_handle = None

    def start_turn(self, text: str, auto: bool = False) -> None:
        self.interrupt()
        if not auto:
            self.auto_chunks = 0
        self.turn_task = asyncio.create_task(self.run_turn(self.turn, text))

    async def run_turn(self, turn: int, text: str) -> None:
        if not await self.ensure_tutor() or turn != self.turn:
            return
        fresh = not self.tutor_used   # first message of this conversation
        self.tutor_used = True
        if (fresh and not self.tutor.resumed
                and not text.startswith("[sidequest]")):
            # First words to a brand-new conversation: hand it the course
            # context inline, so it answers at once instead of reading
            # plan/progress/notes first (that cost ~8 s).
            text = (f"{self.context_brief()}\nThe learner just said: "
                    f"\"{text}\"\nAnswer them now. Don't read files first.")
        elif fresh and not self.tutor.resumed:
            text = KICKOFF
        if KICKOFF in text and self.plan_exists():
            # Everything "start" needs, inline: no reading plan, progress and
            # notes first (that cost ~8 s before the first word).
            text = text.replace(KICKOFF, f"{KICKOFF}\n{self.resume_brief()}")
        elif KICKOFF in text:
            if self.has_materials():
                self.start_planner()
                text = text.replace(KICKOFF, PLANNING_KICKOFF)
            else:
                text = text.replace(KICKOFF, NO_MATERIAL_KICKOFF)
        elif (not self.plan_exists() and not self.planning
              and self.has_materials() and text != CONTINUE):
            # First contact with material but no plan: plan in the background
            # while answering whatever they asked.
            self.start_planner()
            text += ("\n[sidequest] There was no course plan; the planner has "
                     "just started building one in the background. After "
                     "answering, say so in one short sentence.")
        if self.cut_off and KICKOFF not in text:
            heard = self.cut_off.replace('"', "'")
            if text == CONTINUE:
                text = (f"[sidequest] Continue from where you were cut off. The "
                        f"learner last heard: \"{heard}\". Redraw the board for "
                        f"that point first, then carry on.")
            else:
                text = (f"[sidequest] Your previous answer was cut off; the "
                        f"learner heard up to: \"{heard}\". Answer what they "
                        f"say now. If the rest still matters, come back to it "
                        f"afterwards.\n{text}")
            self.cut_off = ""
        text += self.visual_nudges(text)
        self.set_state("thinking")
        self.last_voice_at = time.monotonic()
        asyncio.create_task(self.nudge(turn))
        buf = TurnBuffer()
        producer = asyncio.create_task(self.produce(turn, buf, text))
        # Lecture mode plays chunk after chunk. The next chunk is generated
        # (words, drawings, images, scenes) while the current one is still
        # playing, so it starts the instant this one ends: no gap, no
        # waiting for the board.
        while True:
            player = asyncio.create_task(self.play_queue(turn, buf))
            await producer
            nxt = None
            if turn == self.turn and self.lecturing() and not buf.asked:
                nbuf = TurnBuffer()
                nxt = (nbuf, asyncio.create_task(
                    self.produce(turn, nbuf, CONTINUE)))
                log("prefetching the next chunk while this one plays")
            try:
                await player
            except asyncio.CancelledError:
                return
            if turn != self.turn:
                return
            emit("board", cmd={"op": "spot", "clear": True})   # undim
            self.history.append(dict(buf.flags))
            self.push_plan()
            if (not self.plan_exists() and self.has_materials()
                    and not self.planning):
                self.start_planner()   # the tutor just wrote topic.md
            self.waiting_answer = buf.asked
            if nxt and self.lecturing() and not self.user_talking:
                self.auto_chunks += 1
                buf, producer = nxt
                continue
            if nxt:
                # Switched to Wait (or paused) mid-chunk: the prefetched part
                # was never heard. Tell the tutor next time.
                self.cut_off = self.last_said
            break
        if not self.user_talking:
            self.set_state("paused" if self.paused else "idle",
                           "Your answer?" if buf.asked else "")
        self.schedule_auto()

    def lecturing(self) -> bool:
        lesson = self.cfg["lesson"]
        cap = int(lesson.get("maxAutoChunks", 0) or 0)
        return (bool(lesson.get("autoContinue")) and not self.paused
                and not self.planning and not self.plan_pending
                and bool(self.tutor) and not (cap and self.auto_chunks >= cap))

    async def produce(self, turn: int, queue: "TurnBuffer", text: str) -> None:
        """Stream one tutor reply into a buffer: speech to the TTS pool,
        images and scenes fetched/built at once, all ahead of the voice."""
        flags = queue.flags
        try:
            # The producer is never cancelled mid-stream (that would desync
            # the SDK). A stale turn keeps draining silently instead.
            async for kind, value in self.tutor.reply(text):
                if turn != self.turn:
                    continue
                if kind == "say":
                    fut = self.loop.run_in_executor(self.tts_pool,
                                                    self.tts.synth, value)
                    self.pending_tts.append(fut)
                    queue.put(("say", value, fut))
                elif kind == "board":
                    self.note_visual(value, flags)
                    if value.get("op") == "scene":
                        # Hand the brief to the background illustrator now;
                        # the voice keeps going while it builds.
                        self.scene_n += 1
                        value.setdefault("id", f"scene{self.turn}_{self.scene_n}")
                        queue.put(("scene", value, self.start_scene(value)))
                        continue
                    if value.get("op") in ("image", "icon"):
                        # Fetch NOW, while the voice is still sentences
                        # behind; by the time it gets here it's usually ready.
                        value.pop("src", None)  # only media we fetched
                        task = asyncio.create_task(self.resolve_media(value))
                        queue.put(("media", value, task))
                        continue
                    queue.put(("board", value, None))
                    if value.get("op") == "quiz":
                        queue.asked = True
                        line = quiz_speech(value)
                        fut = self.loop.run_in_executor(
                            self.tts_pool, self.tts.synth, line)
                        self.pending_tts.append(fut)
                        queue.put(("say", line, fut))
                elif kind == "tool":
                    queue.put(("tool", value, None))
        except asyncio.CancelledError:
            pass
        except Exception as e:  # noqa: BLE001
            log(f"turn failed: {e!r}")
            emit("error", text=f"Tutor error: {e}")
        finally:
            queue.close()

    # ----------------------------------------------------------- director
    async def start_director(self) -> None:
        async with self.director_lock:
            if self.director:
                return
            from brain import Director
            d = Director(self.cfg, config.ROOT)
            try:
                await d.start()
            except Exception as e:  # noqa: BLE001
                log(f"director connect failed: {e!r}")
                return
            self.director = d
            log("director connected in the background")

    def start_scene(self, cmd: dict) -> "SceneJob":
        job = SceneJob(cmd)
        asyncio.create_task(self.run_scene(job))
        return job

    async def run_scene(self, job: "SceneJob") -> None:
        """Stream the illustrator's pieces. Before the voice reaches the
        scene they're buffered on the job; after, each goes straight to the
        board, so it visibly draws itself."""
        t0 = time.monotonic()
        first = None
        pending_media: list[asyncio.Task] = []
        try:
            if self.director is None:
                await self.start_director()
            brief = job.brief
            style = self.teaching_style()
            if style:
                brief += f"\nCourse context (from the planner): {style[:600]}"
            async with asyncio.timeout(45):
                async for op in self.director.stream(job.id, brief, job.rect):
                    if op.get("op") in ("clear", "section", "quiz", "result",
                                        "scene"):
                        continue
                    first = first or time.monotonic()
                    if op.get("op") in ("image", "icon"):
                        op.pop("src", None)
                        pending_media.append(asyncio.create_task(
                            self.scene_media(job, op)))
                    else:
                        job.add(op)
            if pending_media:
                await asyncio.gather(*pending_media, return_exceptions=True)
        except Exception as e:  # noqa: BLE001 (incl. timeout)
            log(f"scene {job.id} failed: {e!r}")
            broken, self.director = self.director, None
            if broken:
                asyncio.create_task(broken.stop())  # a fresh one next time
        job.done = True
        if job.played and not job.ops:
            emit("board", cmd={"op": "scene", "id": job.id, "failed": True,
                               "append": True, "brief": job.brief})
        ms = lambda t: int((t - t0) * 1000)  # noqa: E731
        log(f"scene {job.id}: {len(job.ops)} pieces, first after "
            f"{ms(first) if first else '-'} ms, done after "
            f"{ms(time.monotonic())} ms")

    async def scene_media(self, job: "SceneJob", op: dict) -> None:
        job.add(await self.resolve_media(op))

    async def resolve_media(self, cmd: dict) -> dict:
        import media
        t0 = time.monotonic()
        if cmd.get("op") == "icon":
            hit = await asyncio.to_thread(
                media.find_icon, str(cmd.get("name", "")),
                PALETTE.get(cmd.get("color"), PALETTE["ink"]))
        else:
            q = str(cmd.get("query") or cmd.get("caption") or "")
            hit = await asyncio.to_thread(media.find_image, q)
        log(f"media {cmd.get('op')} {cmd.get('query') or cmd.get('name')!r}: "
            f"{'found' if hit else 'nothing'} in "
            f"{int((time.monotonic() - t0) * 1000)} ms")
        return {**cmd, **(hit or {"failed": True})}

    MOTION_OPS = {"scene", "counter", "pulse", "msg", "plotadd", "fx", "move",
                  "anim", "annotate", "cursor"}

    def note_visual(self, cmd: dict, flags: dict) -> None:
        op = cmd.get("op")
        if op in ("image", "icon", "scene"):
            flags["media"] = True
        if (op in self.MOTION_OPS or cmd.get("animate") or cmd.get("type")
                or (op == "svg" and "<animate" in str(cmd.get("content", "")))):
            flags["motion"] = True

    def visual_nudges(self, text: str) -> str:
        """A short reminder appended when the last two answers were static.
        It asks for motion ON the content, never decoration: a blunt "add
        something that moves" made the tutor paste the same decorative curve
        with a dot on it into every answer."""
        if KICKOFF in text or text.startswith(PLAN_READY[:30]):
            return ""
        recent = list(self.history)
        if len(recent) >= 2 and not any(t["motion"] for t in recent[-2:]):
            return ("\n[sidequest] Board check: the last two answers were "
                    "static. In this one, animate the content itself: fx "
                    "(pop, bounce) on the key element as you name it, "
                    "annotate to mark the point, a flow with animate:true if "
                    "something really moves through steps, a counter for a "
                    "real number. Never add a decorative line, curve or wave.")
        return ""

    async def nudge(self, turn: int) -> None:
        """Whenever the tutor has gone quiet for a while mid-turn (reading
        files, thinking), say so out loud. At most twice per turn."""
        said = 0
        while turn == self.turn and self.turn_task and not self.turn_task.done():
            await asyncio.sleep(0.5)
            quiet = time.monotonic() - self.last_voice_at
            if (quiet > NUDGE_AFTER and said < len(self.nudge_clips)
                    and self.state == "thinking" and not self.user_talking
                    and self.player.done.is_set() and turn == self.turn):
                self.player.start_clip(self.nudge_clips[said])
                said += 1
                self.last_voice_at = time.monotonic()

    async def wait_player(self) -> None:
        """Until the current clip (an ack/nudge) is done and you're not
        talking over it."""
        while not self.player.done.is_set() or self.player.paused:
            await asyncio.sleep(0.02)

    def preparing(self) -> None:
        if not self.user_talking and self.state != "thinking":
            self.set_state("thinking", "Preparing the board...")
        elif not self.user_talking:
            emit("status", state="thinking", detail="Preparing the board...",
                 paused=self.paused)

    async def prebuffer(self, turn: int, buf: TurnBuffer) -> None:
        """Stay quiet until the first few drawings are genuinely ready (or
        the answer is complete, or the wait gets long), like a video player
        buffering before it starts."""
        lesson = self.cfg["lesson"]
        max_wait = float(lesson.get("prebufferSeconds", 8) or 0)
        need = int(lesson.get("prebufferVisuals", 3) or 0)
        if max_wait <= 0 or need <= 0:
            return
        t0 = time.monotonic()
        shown = False
        while turn == self.turn:
            ready = 0
            for item in buf.items:
                r = item_ready(item)
                if r is None:
                    continue
                if not r:
                    break   # play in order: stop at the first unready drawing
                ready += 1
            now = time.monotonic()
            started = buf.first_content_at
            if (buf.closed or ready >= need
                    or (started and now - started >= max_wait)
                    or now - t0 >= max_wait + 12):
                why = ("answer complete" if buf.closed else
                       f"{ready} drawings ready" if ready >= need else
                       "waited long enough")
                log(f"buffered {int((now - t0) * 1000)} ms before speaking "
                    f"({why}, {len(buf.items)} items in hand)")
                break
            if not shown and started and now - t0 > 0.8:
                self.preparing()
                shown = True
            await asyncio.sleep(0.1)

    async def gate(self, turn: int, ready, limit: float) -> None:
        """Hold the voice at a drawing that isn't ready yet (up to limit s):
        it never talks about a picture that isn't on the board."""
        t0 = time.monotonic()
        shown = False
        while turn == self.turn and not ready() and \
                time.monotonic() - t0 < limit:
            if not shown and time.monotonic() - t0 > 0.5:
                self.preparing()
                shown = True
            await asyncio.sleep(0.05)

    async def play_queue(self, turn: int, queue: TurnBuffer) -> None:
        await self.prebuffer(turn, queue)
        wait_limit = float(self.cfg["lesson"].get("visualWaitSeconds", 6) or 0)
        follow_on = bool(self.cfg["lesson"].get("followAlong", True))
        follow = {"drawn": None, "pointed": False}
        pos = 0
        while True:
            while pos >= len(queue.items) and not queue.closed:
                queue.changed.clear()
                if pos < len(queue.items) or queue.closed:
                    break
                try:
                    await asyncio.wait_for(queue.changed.wait(), 1.0)
                except TimeoutError:
                    pass
                if turn != self.turn:
                    return
            if pos >= len(queue.items) or turn != self.turn:
                return
            item = queue.items[pos]
            pos += 1
            kind, value, fut = item
            if kind == "media" and wait_limit:
                # A photo is a nice-to-have: wait a little, then a
                # placeholder holds the spot and it fills in on arrival.
                await self.gate(turn, fut.done, min(wait_limit, 3.0))
            elif kind == "scene" and wait_limit:
                # A scene IS the explanation: worth a longer wait for its
                # first pieces (the rest keep streaming in while it talks).
                await self.gate(turn, lambda: bool(fut.ops) or fut.done,
                                wait_limit * 1.5)
            if turn != self.turn:
                return
            m = self.measure
            if m and m["turn"] == turn and kind in ("board", "say", "media",
                                                     "scene"):
                m.setdefault("first_say" if kind == "say" else "first_board",
                             self.since_spoke())
                if "first_board" in m and "first_say" in m and not m.get("logged"):
                    m["logged"] = True
                    log(f"latency after you stopped talking: ack {m['ack']} ms, "
                        f"first drawing {m['first_board']} ms, "
                        f"first sentence {m['first_say']} ms")
            # Follow-along: remember what was just drawn (or whether the tutor
            # is already pointing), so the next sentence can point at it.
            op = value.get("op") if isinstance(value, dict) else None
            if kind == "board" and op in POINTING:
                follow["pointed"] = True
            elif kind in ("media", "scene") or (
                    kind == "board" and op not in NON_VISUAL and op not in POINTING):
                tid = (fut.id if kind == "scene" else value.get("id")
                       or value.get("list") or value.get("seq"))
                if tid:
                    follow["drawn"] = tid
            if kind == "board":
                emit("board", cmd=value)
                self.track(value)
                if value.get("op") == "section":
                    self.push_plan()
            elif kind == "scene":
                job = fut
                job.played = True
                emit("board", cmd={
                    "op": "scene", "id": job.id, **job.rect,
                    "ops": list(job.ops), "pending": not job.ops,
                    "caption": job.brief[:90]})
                if job.done and not job.ops:
                    emit("board", cmd={"op": "scene", "id": job.id,
                                       "failed": True, "append": True,
                                       "brief": job.brief})
            elif kind == "media":
                if fut.done() and not fut.cancelled():
                    emit("board", cmd=fut.result())
                else:
                    # Placeholder now, the real thing the moment it lands.
                    emit("board", cmd={**value, "pending": True})
                    fut.add_done_callback(
                        lambda t: None if t.cancelled() or t.exception()
                        else emit("board", cmd={**t.result(), "update": True}))
            elif kind == "tool":
                self.push_plan()  # picks up a freshly written plan.json
                if not self.user_talking:
                    self.set_state("thinking", value)
            elif kind == "say":
                try:
                    pcm = await fut
                except asyncio.CancelledError:
                    return
                except Exception as e:  # noqa: BLE001
                    log(f"tts failed on {value!r}: {e}")
                    continue
                if fut in self.pending_tts:
                    self.pending_tts.remove(fut)
                await self.wait_player()
                if turn != self.turn:
                    return
                if follow["drawn"]:
                    # Something new just appeared: point at it, and give the
                    # eye a beat to land on it before the voice talks about it.
                    if follow_on and not follow["pointed"]:
                        emit("board", cmd={"op": "spot",
                                           "target": follow["drawn"]})
                    await asyncio.sleep(0.4)
                    if turn != self.turn:
                        return
                follow["drawn"], follow["pointed"] = None, False
                if self.state != "speaking":
                    self.set_state("speaking")
                self.turn_spoke = True
                self.last_said = value
                emit("say", text=value)
                self.ears.tutor_speaking = True
                self.player.start_clip(pcm)
                await self.wait_player()
                self.ears.tutor_speaking = False
                self.last_voice_at = time.monotonic()
                if turn != self.turn:
                    return

    def schedule_auto(self) -> None:
        lesson = self.cfg["lesson"]
        if (not lesson.get("autoContinue") or self.paused or self.planning
                or self.waiting_answer or not self.tutor):
            return
        cap = int(lesson.get("maxAutoChunks", 4) or 0)   # 0 = never stop
        if cap and self.auto_chunks >= cap:
            self.paused = True
            self.set_state("paused", "Paused. Say continue when you're back.")
            return
        self.cancel_auto()

        def go() -> None:
            self.auto_handle = None
            if self.state == "idle" and not self.paused \
                    and not self.user_talking:
                self.auto_chunks += 1
                self.start_turn(CONTINUE, auto=True)

        self.auto_handle = self.loop.call_later(
            float(lesson.get("autoContinueSeconds", 3)), go)


def read_stdin_lines(on_line, on_eof) -> None:
    """Read stdin WITHOUT ever leaving a blocking read pending.

    On Windows a thread parked in ReadFile on the stdin pipe deadlocks every
    later DLL load in the process: each C runtime calls GetFileType(stdin)
    while initialising, and that call waits behind the pending read. (It hung
    numpy's import, and would hang CUDA and the Claude subprocess.) So poll
    with PeekNamedPipe and only read bytes that are already there."""
    import ctypes
    import msvcrt
    from ctypes import wintypes

    peek = ctypes.windll.kernel32.PeekNamedPipe
    peek.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                     ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD),
                     ctypes.c_void_p]
    peek.restype = wintypes.BOOL
    fd = sys.stdin.fileno()
    handle = msvcrt.get_osfhandle(fd)
    avail = wintypes.DWORD()
    buf = b""
    while peek(handle, None, 0, None, ctypes.byref(avail), None):
        if not avail.value:
            time.sleep(0.03)
            continue
        buf += os.read(fd, avail.value)
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            on_line(line.decode("utf-8", "replace").strip())
    on_eof()  # pipe closed: the overlay is gone


async def main() -> None:
    cfg = config.load()
    engine = Engine(cfg)
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def on_line(line: str) -> None:
        if not line:
            return
        try:
            loop.call_soon_threadsafe(queue.put_nowait, json.loads(line))
        except json.JSONDecodeError:
            log(f"bad command: {line[:120]}")

    threading.Thread(target=read_stdin_lines, daemon=True,
                     args=(on_line, lambda: loop.call_soon_threadsafe(
                         queue.put_nowait, None))).start()
    try:
        await engine.boot()
    except Exception as e:  # noqa: BLE001
        log(f"boot failed: {e!r}")
        emit("error", text=f"Engine failed to start: {e}")
        raise
    while True:
        msg = await queue.get()
        if msg is None:
            break
        try:
            await engine.on_command(msg)
        except Exception as e:  # noqa: BLE001
            log(f"command {msg} failed: {e!r}")
    if engine.tutor:
        await engine.tutor.stop()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
