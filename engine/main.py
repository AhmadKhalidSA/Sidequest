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
from media import KIDS_MEDIA_OPS  # noqa: E402
from prompts import (BUTTONS, CONTINUE, KICKOFF, MISSED, MODES,  # noqa: E402
                     NO_MATERIAL_KICKOFF, PLAN_READY, PLANNING_KICKOFF,
                     SESSION_END, WARMUP)

# Instant acknowledgements. Real words only: the voice mangles "Mm-hm".
# A thinking sound, never a judgement: "good question" was wrong whenever
# the learner was answering, not asking.
ACKS = ["Hmm.", "Hmm, okay.", "Mm, let me see.", "Okay, hmm.", "Hmm, let's see."]
NUDGES = ["One sec, getting it ready.", "Almost there."]
# The same, when it teaches in Arabic.
ACKS_AR = ["اممم.", "طيب، اممم.", "خلني أشوف.", "اممم، طيب.", "همم، خلني أشوف."]
NUDGES_AR = ["لحظة، أجهّز لك.", "قرّبنا."]
NUDGE_AFTER = 7.0
# Board ops that don't draw anything (they don't count as buffered visuals).
NON_VISUAL = {"clear", "section", "result", "quiz", "erase", "unfocus",
              "unzoom", "spot", "card", "shadow", "tick", "geoset", "simsend",
              "tstep"}
# Ops the app consumes itself; they never reach the board.
APP_OPS = {"card", "shadow"}
# Ops where the tutor is already pointing at something itself; the
# follow-along pointer stays out of the way after these.
POINTING = {"highlight", "focus", "callout", "zoom", "annotate", "pulse", "fx",
            "cursor", "move", "anim"}
# Said while the tutor is talking: just listening noises, keep going.
# (Short, no question, starts with one of these: "yeah", "yes sir", "ok cool".)
BACKCHANNEL = re.compile(
    r"^(yeah|yes|yep|yup|okay|ok|mm+-?hm+|uh-huh|right|sure|cool|nice|"
    r"got it|i see|alright|all right|makes sense|true|go on|"
    r"ايه|إيه|ايوه|أيوه|اي|تمام|طيب|اها|آها|صح|اوكي|أوكي|زين)(\W|$)", re.I)
PAUSE = re.compile(r"^((can|could|would) you |please |just )?(pause|stop|wait|"
                   r"hold on|hang on|one sec(ond)?|shut up|be quiet|quiet|"
                   r"not now)\b|^(وقف|اسكت|لحظة|استنى|انتظر)(\W|$)", re.I)
# "see my screen" / "look at this": screenshot the monitor under the cursor.
SEE_SCREEN = re.compile(
    r"(see|look at|check|read|watch|describe|what'?s on|what is on)\s+"
    r"(my|the|this)\s+(screen|monitor|display)|see what i'?m (seeing|looking"
    r" at)|what am i (seeing|looking at)|\blook at this\b|on my screen", re.I)
# Hesitation sounds on their own: not a message, keep listening.
HESITATION = re.compile(r"^(h+m+|m+h*m*|u+h+|u+m+|e+r+m*|a+h+|o+h+|"
                        r"ا+ه+|ا+م+|ء+م+|م+)$", re.I)
WORD = re.compile(r"[^\W\d_]+(?:'[^\W\d_]+)?")   # a word, in any script
# A sentence ending in one of these is almost certainly unfinished: hold it
# and merge with what comes next instead of answering half a thought.
UNFINISHED_END = {"and", "but", "so", "like", "because", "the", "a", "an",
                  "to", "of", "or", "then", "is", "are", "was", "what", "how",
                  "why", "if", "when", "that", "this", "with", "in", "on",
                  "for", "my", "i", "it's", "its", "um", "uh", "hmm", "mm",
                  "er", "which", "about", "from", "by", "as", "at", "into",
                  "و", "بس", "لأن", "لان", "يعني", "اللي", "عشان", "في", "من",
                  "على", "إذا", "اذا", "مثل"}
HOLD_SECONDS = 2.5


def hesitation_only(text: str) -> bool:
    words = WORD.findall(text.lower())
    return not words or all(HESITATION.match(w) for w in words)


def fillers(text: str) -> int:
    return sum(bool(HESITATION.match(w)) for w in WORD.findall(text.lower()))


def unfinished(text: str) -> bool:
    t = text.strip()
    if t.endswith(("...", "…", ",", "،", "-")):
        return True
    words = WORD.findall(t.lower())
    return bool(words) and words[-1] in UNFINISHED_END and not t.endswith(
        ("?", "!", "؟"))
RESUME = re.compile(r"^(continue|go on|resume|keep going|carry on|go ahead|"
                    r"unpause|let's go|next)\b|^(كمل|كمّل|يلا|استمر)(\W|$)",
                    re.I)
START = re.compile(r"^(ok(ay)?[,.!]?\s*)?(so\s+)?(let'?s |lets |can we |shall we )?"
                   r"(start|begin|get started|kick off)\b"
                   r"|^(تمام\s+|طيب\s+)?(يلا\s+)?(نبدأ|نبدا|ابدأ|ابدا|خلنا نبدأ|خلنا نبدا)"
                   r"(\W|$)", re.I)
# "let's learn about X" / "teach me X" / "new topic: X" -> a course for X, made
# on the spot, planned from knowledge (and the web, if it's new).
LEARN_NEW = re.compile(
    r"^(ok(ay)?[,.!]?\s*)?(so\s+)?(?:"
    r"(?:let'?s |lets |i want to |i'?d like to |i wanna |can we |could we )"
    r"(?:learn|study)(?: about| something about| more about)?"
    r"|teach me(?: about)?|new (?:topic|course|subject)[:,]?(?: about)?"
    r"|(?:يلا |طيب )?(?:خلنا|خلينا|ابغى|أبغى|ابي|أبي|ودي)\s+(?:نتعلم|اتعلم|أتعلم|"
    r"ندرس|ادرس|أدرس)(?: عن| شي عن)?"
    r"|علمني(?: عن)?|درسني(?: عن)?|اشرح لي عن"
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


def cmd(pattern: str) -> re.Pattern:
    """A short spoken command: matched at the start, case-insensitive."""
    return re.compile(rf"^(ok(ay)?[,.!]?\s*)?(please\s+)?(?:{pattern})(\W|$)",
                      re.I)


# Fight mode: quick recall only while the game needs you.
BUSY_CMD = cmd(r"(i'?m |i am )?(busy|in a fight|fighting)|fight mode|مشغول")
FREE_CMD = cmd(r"(i'?m |i am )?(free|done fighting|out of the fight)|"
               r"fight'?s over|فاضي|خلصت")
REWIND_CMD = cmd(r"show (me )?that again|go back|previous board|"
                 r"show (me )?the last (board|one|drawing)|rewind|"
                 r"(show|bring) (it|that) back|ارجع")
LIVE_CMD = cmd(r"back to (now|live|the lesson)|(go )?forward|show now")
MISSED_CMD = re.compile(r"what did i miss|catch me up|i missed (that|it)|"
                        r"وش فاتني|ايش فاتني|شو فاتني", re.I)
RAPID_CMD = cmd(r"quick ?fire|rapid ?fire|quick round|lightning round|"
                r"speed round")
TEACHBACK_ON = cmd(r"let me teach (you|it)|you be the student|teach ?back|"
                   r"i'?ll teach you|خلني اشرح|خليني اشرح")
TEACHBACK_OFF = cmd(r"you teach( me)?( again)?|stop teach ?back|"
                    r"you be the teacher|back to normal")
SOCRATIC_ON = cmd(r"make me work for it|don'?t tell me|socratic( mode)?|"
                  r"ask me instead")
SOCRATIC_OFF = cmd(r"just tell me|tell me the answer|stop asking")
ROLEPLAY_CMD = cmd(r"put me in it|(let'?s )?role ?play|act it out")
COHOST_ON = cmd(r"bring in the co-?host|two hosts|podcast mode|"
                r"add (a |the )?co-?host")
COHOST_OFF = cmd(r"just you|solo( mode)?|no co-?host|lose the co-?host")
SLOWER = cmd(r"slow down|(speak|talk) slower|slower")
FASTER = cmd(r"speed up|(speak|talk) faster|faster")
OTHER_VOICE = cmd(r"(use )?(an)?other voice|change (your )?voice|"
                  r"different voice|switch voices?")
HARDER = cmd(r"make it harder|harder|too easy|challenge me")
EASIER = cmd(r"make it easier|easier|too hard|simpler")
FUNNIER = cmd(r"more jokes|be funnier|funnier")
SERIOUS = cmd(r"be serious|no (more )?jokes|less jokes|fewer jokes")
END_SESSION = cmd(r"that'?s (it|all) for today|end (the )?session|"
                  r"i'?m done( for today)?|let'?s stop (here|for today)")
BREAK_SCREEN = cmd(r"this is a break|this is downtime|learn this screen|"
                   r"remember this screen")
KIDS_ANY = re.compile(r"kids? mode|وضع الأطفال|وضع الاطفال", re.I)
KIDS_ON = cmd(r"kids? mode|turn on kids? mode|وضع الأطفال|وضع الاطفال")
KIDS_OFF = cmd(r"(normal|adult|grown-?up) mode|kids? mode off|turn off kids? mode|"
               r"الوضع العادي")
EXPORT_ANKI = cmd(r"export (it |this )?(to |my )?(anki|flash ?cards|deck)")
# "Other voice" cycles through these (Kokoro names).
VOICE_CYCLE = ["af_heart", "am_michael", "bf_emma", "bm_george", "af_bella"]
PERSONAS = {"default": "lively explainer", "hype": "hype",
            "dry": "dry", "calm": "calm"}


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
        # Memory deck (spaced review), and this session's numbers for the
        # end-of-session card.
        self.deck = None
        self.last_quiz = ""
        self.pending_grade: dict | None = None   # a @result awaiting its @card
        self.session = {"start": time.monotonic(), "asked": 0, "correct": 0,
                        "ranks": {}}
        # Fight mode (manual, "busy") and the lull meter's automatic pause.
        self.busy = False
        self.busy_since = 0.0
        self.lull = None
        self.hush = False             # a fight is on: hold lecture content
        self.hush_since = 0.0
        self.replay_last = False      # after a long fight, repeat the last line
        self.turn_auto = False        # the current turn is lecture, not a reply
        self.rewound = 0              # boards back the learner is looking
        self.rewind_handle: asyncio.TimerHandle | None = None
        self.said_log: collections.deque = collections.deque(maxlen=40)
        self.last_pcm = None
        self.modes: set[str] = set()  # teachback, socratic
        self.style_dirty = True       # send the style dials with the next turn
        self.asked_at = 0.0           # when the last question finished playing
        self.speech_started_at = 0.0
        self.shadow: dict | None = None   # a phrase to repeat, being scored
        self.rapid_handle: asyncio.TimerHandle | None = None
        self.warm: dict | None = None     # the session opening, made at launch
        self.warm_dropped = False

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
        await self.make_clips()
        from deck import Deck
        self.deck = Deck(config.COURSES / ".sidequest" / "deck.json")
        import pron
        pron.set_models_dir(config.models_dir(self.cfg))   # loads on first use

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
        emit("kids", on=self.kids())
        self.voice_style()
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
        self.send_deck()
        self.start_lull()
        asyncio.create_task(self.meter())
        asyncio.create_task(self.start_director())  # pre-connect the illustrator
        asyncio.create_task(self.warm_start())
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

    # -------------------------------------------------------------- voice
    def synth(self, text: str, speaker: str = "") -> "object":
        """TTS in the right voice: "" = the tutor, "B" = the co-host,
        "C" = a role-play character. Arabic lines go to the Arabic voice
        inside TTS."""
        voice = {"B": self.cfg["tts"].get("voice2"),
                 "C": self.cfg["tts"].get("voice3")}.get(speaker)
        return self.tts.synth(text, voice) if voice else self.tts.synth(text)

    async def make_clips(self) -> None:
        arabic = (self.cfg["lesson"].get("teachLanguage") == "ar"
                  and getattr(self.tts, "has_arabic", False))
        self.acks = await asyncio.to_thread(
            lambda: [self.tts.synth(t) for t in (ACKS_AR if arabic else ACKS)])
        self.nudge_clips = await asyncio.to_thread(
            lambda: [self.tts.synth(t)
                     for t in (NUDGES_AR if arabic else NUDGES)])
        self.where_clip = await asyncio.to_thread(
            self.tts.synth, "وين وقفنا؟" if arabic else "So, where was I.")

    def set_voice(self, voice: str | None = None,
                  speed: float | None = None) -> None:
        if voice:
            self.tts.set_voice(voice) if hasattr(self.tts, "set_voice") \
                else setattr(self.tts, "_voice", voice)
        if speed:
            self.tts.set_speed(speed) if hasattr(self.tts, "set_speed") \
                else setattr(self.tts, "_speed", speed)
        if hasattr(self.tts, "set_arabic_voice"):
            self.tts.set_arabic_voice(self.cfg["tts"].get("arabicVoice", ""))
        if not hasattr(self.tts, "set_voice"):
            self.tts.desc = f"Kokoro {self.tts._voice}"

    def voice_list(self) -> list[str]:
        if hasattr(self.tts, "voice_list"):
            return self.tts.voice_list()
        try:
            return sorted(self.tts._kokoro.get_voices())
        except Exception:  # noqa: BLE001
            return [self.cfg["tts"].get("voice", "af_heart")]

    # --------------------------------------------------------------- deck
    def send_deck(self) -> None:
        """Due count and streak for the header; section ranks for the index."""
        if not self.deck:
            return
        rest = self.cfg["lesson"].get("restDays") or []
        emit("deck", due=self.deck.due_count(), streak=self.deck.streak(rest))
        plan = self.load_plan()
        if plan and self.course:
            emit("ranks", ranks=self.deck.ranks(
                self.course, len(plan.get("sections", []))))

    def card_lines(self, cards: list[dict]) -> str:
        return "\n".join(
            f"- id {c['id']}: {c['q']} (answer: {c.get('a') or '?'})"
            + (f" [from the {c['course']} course]" if c["course"] != self.course
               else "") for c in cards) or "- (no cards yet: ask about what " \
                                           "we've covered so far)"

    def grade(self, q: str, rating: str, a: str = "", cid: str = "") -> None:
        if not (self.deck and self.course and q):
            return
        section = int(self.load_progress().get("section", 0) or 0)
        self.deck.review(self.course, section, q, a, rating, cid=cid)
        self.send_deck()

    def flush_grade(self) -> None:
        """A @result the tutor never followed with @card still counts."""
        if self.pending_grade:
            g, self.pending_grade = self.pending_grade, None
            self.grade(g["q"], "good" if g["correct"] else "again")

    # --------------------------------------------------------------- lull
    def start_lull(self) -> None:
        if self.lull:
            self.lull.stop()
            self.lull = None
        lull = self.cfg.get("lull") or {}
        if config.TEST or not lull.get("auto"):
            return
        from lull import LullMeter
        call = self.loop.call_soon_threadsafe
        self.lull = LullMeter(
            config.COURSES / ".sidequest" / "break_screens.json",
            lambda state, score: call(self.on_lull, state, score),
            float(lull.get("fightAt", 0.6)), float(lull.get("calmAt", 0.3)))
        log("lull meter on")

    def on_lull(self, state: str, score: float) -> None:
        log(f"lull: {state} (score {score})")
        emit("lull", state=state)
        if state == "fight" and not self.hush:
            self.hush, self.hush_since = True, time.monotonic()
        elif state != "fight" and self.hush:
            self.hush = False
            if (time.monotonic() - self.hush_since > 20 and self.last_pcm
                    is not None and self.turn_active()):
                # Back after a long fight: re-anchor with the last sentence.
                self.player.start_clip(self.where_clip)
                self.replay_last = True

    async def wait_unhushed(self, turn: int) -> None:
        """Lecture content waits while a fight is on or a replayed board is
        showing. Answers to the learner never wait: they asked."""
        while turn == self.turn and ((self.hush and self.turn_auto)
                                     or self.rewound):
            await asyncio.sleep(0.1)

    # --------------------------------------------------------- warm start
    def opening(self) -> str:
        """The session opening: kickoff, course context, and due cards."""
        text = f"{KICKOFF}\n{self.resume_brief()}"
        cards = self.deck.due(6) if self.deck else []
        if cards:
            rest = self.cfg["lesson"].get("restDays") or []
            text += "\n" + WARMUP.format(
                n=len(cards), minutes=max(1, round(len(cards) * 0.4)),
                streak=max(1, self.deck.streak(rest)),
                cards=self.card_lines(cards))
        return text

    async def warm_start(self) -> None:
        """Make the session opening in the background while nobody's talking,
        so "let's start" plays at once instead of after ~8 s."""
        if ((config.TEST and not os.environ.get("SIDEQUEST_TEST_WARM"))
                or not self.cfg["lesson"].get("warmStart", True)
                or not self.plan_exists()):
            return
        if not await self.ensure_tutor(quiet=True):
            return
        if self.turn_active() or self.user_talking or self.warm:
            return
        self.tutor_used = True
        text = self.style_prefix() + self.opening()
        buf = TurnBuffer()
        self.warm = {"turn": self.turn, "buf": buf,
                     "task": asyncio.create_task(
                         self.produce(self.turn, buf, text))}
        log("warm start: preparing the session opening in the background")

    def drop_warm(self) -> None:
        if self.warm:
            if not self.warm["task"].done() and self.tutor:
                asyncio.create_task(self.tutor.interrupt())
            self.warm = None
            self.warm_dropped = True

    # ----------------------------------------------------------- settings
    def save_user_config(self, patch: dict) -> None:
        """Merge a patch into config.json (keeping anything hand-edited)."""
        path = config.ROOT / "config.json"
        try:
            user = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            user = {}
        if not config.TEST:     # self-tests never touch the real settings
            path.write_text(json.dumps(config._merge(user, patch), indent=2),
                            encoding="utf-8")
        self.cfg = config._merge(self.cfg, patch)

    def send_settings(self) -> None:
        arabic = (self.tts.arabic_voice_list()
                  if getattr(self.tts, "has_arabic", False) else [])
        emit("settings", voices=self.voice_list(), arabicVoices=arabic, cfg={
            k: self.cfg.get(k) for k in ("keys", "brain", "lesson", "stt",
                                         "tts", "audio", "mirror", "lull")})

    async def apply_settings(self, patch: dict) -> None:
        from keys import vk
        for name in (patch.get("keys") or {}).values():
            try:
                if name:
                    vk(name)
            except ValueError as e:
                emit("error", text=str(e))
                return
        old = copy.deepcopy(self.cfg)
        self.save_user_config(patch)
        if "tts" in patch:
            self.set_voice(self.cfg["tts"].get("voice"),
                           float(self.cfg["tts"].get("speed", 1.0)))
        if "tts" in patch or "teachLanguage" in patch.get("lesson", {}):
            await self.make_clips()   # voice or language of the quick replies
        if "lesson" in patch or "tts" in patch:
            self.style_dirty = True
        if "lull" in patch:
            self.start_lull()
        if (old["lesson"].get("kidsMode") != self.cfg["lesson"].get("kidsMode")
                or old["lesson"].get("kidName")
                != self.cfg["lesson"].get("kidName")):
            await self.set_kids(self.kids(), greet=False)
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
                       for k in ("model", "device", "language"))
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
        elif action == "busy":
            self.set_busy(not self.busy)
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
        if not self.pending_text:
            self.speech_started_at = time.monotonic()
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
        # Smart Turn hears an Arabic trail-off as finished more often than an
        # English one, so while you speak Arabic, wait out the full pause.
        self.ears.turn_confidence = (1.01 if getattr(self.stt, "lang", "en")
                                     == "ar" else 0.7)
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
        if self.shadow and not (PAUSE.match(text) or RESUME.match(text)):
            await self.score_shadow(audio, text)
            return
        await self.handle_text(text)

    async def score_shadow(self, audio, text: str) -> None:
        """They repeated the phrase: score it (sound by sound when the
        phoneme model is there, word by word otherwise) and let the tutor
        coach from the result."""
        target, self.shadow = self.shadow, None
        emit("heard", text=text, turn=True)
        self.player.start_clip(random.choice(self.acks))
        try:
            import pron
            try:
                res = await asyncio.to_thread(pron.score, audio,
                                              target["text"], target["lang"])
            except Exception as e:  # noqa: BLE001 — model missing or failed
                log(f"pronunciation model unavailable ({e!r}); words only")
                res = pron.score_words(text, target["text"])
        except Exception as e:  # noqa: BLE001
            log(f"pronunciation scoring failed: {e!r}")
            self.start_turn(text)
            return
        emit("board", cmd={"op": "pron", "id": "pron", "lang": target["lang"],
                           "score": res.get("score"),
                           "words": res.get("words", [])})
        off = [w["w"] for w in res.get("words", []) if not w.get("ok")]
        sounds = sorted({s[0] for w in res.get("words", [])
                         for s in w.get("sounds", []) if not s[1]})
        self.start_turn(
            f"[sidequest] Shadowing result for \"{target['text']}\": score "
            f"{res.get('score')}/100. Heard: \"{res.get('heard') or text}\". "
            f"Words off: {', '.join(off) or 'none'}. Sounds off: "
            f"{' '.join(sounds) or 'none'}.")

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
        if await self.local_command(text):
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
        elif self.waiting_answer and self.asked_at:
            text += self.answer_timing(text)
        self.start_turn(text)
        self.player.start_clip(random.choice(self.acks))
        self.measure = {"turn": self.turn, "ack": self.since_spoke()}

    def answer_timing(self, text: str) -> str:
        """How the answer came out, for the tutor's pacing (never said)."""
        took = max(0.0, self.speech_started_at - self.asked_at)
        n = fillers(text)
        unclear = getattr(self.stt, "logprob", 0) < -0.8
        return (f"\n[sidequest] answer timing: {took:.0f} s to start, {n} "
                f"filler{'s' if n != 1 else ''}"
                f"{', unclear audio' if unclear else ''}")

    async def local_command(self, text: str) -> bool:
        """Voice commands the app handles itself. True = handled; dial
        changes like "harder" also go on to the tutor (False)."""
        s = short(text, 7)

        def heard() -> None:
            emit("heard", text=text)
            self.on_speech_cancel()

        if MISSED_CMD.search(text):
            emit("heard", text=text, turn=True)
            self.catch_up()
            return True
        if KIDS_ANY.search(text) and not self.kids() and not s:
            # "...let's go into kids mode and teach me X": switch, then the
            # tutor still answers the whole request.
            await self.set_kids(True, greet=False)
            return False
        if not s:
            return False
        if BUSY_CMD.match(text):
            heard()
            self.set_busy(True)
        elif FREE_CMD.match(text) and self.busy:
            heard()
            self.set_busy(False)
        elif REWIND_CMD.match(text):
            heard()
            self.rewind(self.rewound + 1)
        elif LIVE_CMD.match(text) and self.rewound:
            heard()
            self.rewind(0)
        elif RAPID_CMD.match(text):
            emit("heard", text=text, turn=True)
            self.rapid_fire()
        elif TEACHBACK_ON.match(text):
            emit("heard", text=text, turn=True)
            self.set_mode_flag("teachback", True)
        elif TEACHBACK_OFF.match(text) and "teachback" in self.modes:
            emit("heard", text=text, turn=True)
            self.set_mode_flag("teachback", False)
        elif SOCRATIC_ON.match(text):
            emit("heard", text=text, turn=True)
            self.set_mode_flag("socratic", True)
        elif SOCRATIC_OFF.match(text) and "socratic" in self.modes:
            emit("heard", text=text, turn=True)
            self.set_mode_flag("socratic", False)
        elif ROLEPLAY_CMD.match(text):
            emit("heard", text=text, turn=True)
            self.paused = False
            self.start_turn(MODES["roleplay"])
            self.player.start_clip(random.choice(self.acks))
        elif COHOST_ON.match(text) or COHOST_OFF.match(text):
            emit("heard", text=text, turn=True)
            self.set_cohost(bool(COHOST_ON.match(text)))
        elif SLOWER.match(text) or FASTER.match(text):
            heard()
            speed = float(self.cfg["tts"].get("speed", 1.0))
            speed = round(min(1.5, max(0.7, speed + (0.1 if FASTER.match(text)
                                                      else -0.1))), 2)
            await self.apply_settings({"tts": {"speed": speed}})
            emit("toast", text=f"Speaking speed {speed}")
        elif OTHER_VOICE.match(text):
            heard()
            cur = self.cfg["tts"].get("voice", VOICE_CYCLE[0])
            voices = [v for v in VOICE_CYCLE if v in self.voice_list()] \
                or VOICE_CYCLE
            nxt = voices[(voices.index(cur) + 1) % len(voices)] \
                if cur in voices else voices[0]
            await self.apply_settings({"tts": {"voice": nxt}})
            emit("toast", text=f"Voice: {nxt}")
            self.player.start_clip(random.choice(self.acks))
        elif END_SESSION.match(text):
            emit("heard", text=text, turn=True)
            self.end_session()
        elif BREAK_SCREEN.match(text):
            heard()
            self.mark_break()
        elif EXPORT_ANKI.match(text):
            heard()
            await self.export_anki()
        elif KIDS_OFF.match(text) or KIDS_ON.match(text):
            emit("heard", text=text, turn=True)
            await self.set_kids(not KIDS_OFF.match(text))
        else:
            # Difficulty and humour dials: remember them, and let the tutor
            # hear the request too so it adjusts right away.
            lesson = self.cfg["lesson"]
            for pat, key, step in ((HARDER, "difficulty", 1),
                                   (EASIER, "difficulty", -1),
                                   (FUNNIER, "humor", 1),
                                   (SERIOUS, "humor", -2)):
                if pat.match(text):
                    v = min(5, max(1, int(lesson.get(key, 3)) + step))
                    self.save_user_config({"lesson": {key: v}})
                    self.style_dirty = True
                    emit("toast", text=f"{'Difficulty' if key == 'difficulty' else 'Humour'} {v}/5")
                    break
            return False
        return True

    # ------------------------------------------------------ lesson modes
    def set_busy(self, on: bool) -> None:
        """Fight mode: quick recall only while the game needs you."""
        if on == self.busy:
            return
        self.busy = on
        emit("busy", on=on)
        emit("toast", text="Fight mode: quick questions only. Say \"I'm free\" "
             f"or press {pretty(self.keys.get('busy', ''))} when you're back"
             if on else "Back to the lesson")
        self.paused = False
        if on:
            self.busy_since = time.monotonic()
            cards = self.deck.due(5) if self.deck else []
            cards = cards or (self.deck.recent(self.course or "", 5)
                              if self.deck else [])
            self.start_turn(MODES["busy"].format(cards=self.card_lines(cards)))
        else:
            self.start_turn(MODES["busy_off"])
        self.player.start_clip(random.choice(self.acks))

    def kids(self) -> bool:
        return bool(self.cfg["lesson"].get("kidsMode"))

    async def set_kids(self, on: bool, greet: bool = True) -> None:
        """Kids mode changes the tutor's and illustrator's instructions, so
        both reconnect (the conversation itself carries on)."""
        if on != self.kids():
            self.save_user_config({"lesson": {"kidsMode": on}})
        emit("kids", on=on)
        self.voice_style()
        emit("toast", text="Kids mode on" if on else "Kids mode off")
        await self.reconnect_brains()
        if greet and self.course:
            self.paused = False
            self.start_turn(
                "[sidequest] Kids mode is now on: a child is learning now. "
                "Say hello in two short, warm sentences with your mascot on a "
                "fresh board, and ask their name if you don't know it."
                if on else "[sidequest] Kids mode is off: back to the normal "
                "style. One line, then carry on.")
            self.player.start_clip(random.choice(self.acks))

    def voice_style(self) -> None:
        """Kids get a livelier Arabic delivery from the same voice."""
        saudi = getattr(self.tts, "_saudi", None)
        if saudi:
            base = float(self.cfg["tts"].get("arabicExpressive", 0.5))
            saudi.exaggeration = max(base, 0.75) if self.kids() else base

    async def reconnect_brains(self) -> None:
        self.interrupt()
        self.drop_warm()
        if self.tutor:
            await self.tutor.stop()
            self.tutor = None
        if self.director:
            stale, self.director = self.director, None
            asyncio.create_task(stale.stop())
        asyncio.create_task(self.start_director())
        asyncio.create_task(self.ensure_tutor(quiet=True))

    def set_mode_flag(self, name: str, on: bool) -> None:
        (self.modes.add if on else self.modes.discard)(name)
        emit("modes", on=sorted(self.modes))
        self.paused = False
        self.start_turn(MODES[name if on else f"{name}_off"])
        self.player.start_clip(random.choice(self.acks))

    def set_cohost(self, on: bool) -> None:
        self.save_user_config({"lesson": {"cohost": on}})
        emit("toast", text="Co-host on" if on else "Co-host off")
        self.paused = False
        self.start_turn(MODES["cohost" if on else "cohost_off"])
        self.player.start_clip(random.choice(self.acks))

    def rapid_fire(self) -> None:
        """A 60-second round of one-word answers. The end-of-sentence pause
        gets shorter for it, since the answers are single words."""
        cards = self.deck.due(5) if self.deck else []
        if len(cards) < 5 and self.deck and self.course:
            seen = {c["id"] for c in cards}
            cards += [c for c in self.deck.recent(self.course, 10)
                      if c["id"] not in seen][:5 - len(cards)]
        self.paused = False
        self.start_turn(MODES["rapid"].format(cards=self.card_lines(cards)))
        self.player.start_clip(random.choice(self.acks))
        from voice import FRAME_MS
        normal = int(self.cfg["audio"].get("endSilenceMs", 1600))
        self.ears._end_frames = max(8, min(normal, 800) // FRAME_MS)
        if self.rapid_handle:
            self.rapid_handle.cancel()

        def restore() -> None:
            self.rapid_handle = None
            self.ears._end_frames = max(8, int(self.cfg["audio"].get(
                "endSilenceMs", 1600)) // FRAME_MS)
        self.rapid_handle = self.loop.call_later(90, restore)

    def rewind(self, steps: int) -> None:
        """Show an earlier board (missed in a fight). The lecture holds while
        it's up, and comes back by itself after 20 s."""
        steps = max(0, min(12, steps))
        self.rewound = steps
        emit("board", cmd={"op": "rewind", "steps": steps})
        if self.rewind_handle:
            self.rewind_handle.cancel()
            self.rewind_handle = None
        if steps:
            self.rewind_handle = self.loop.call_later(20, self.rewind, 0)

    def catch_up(self) -> None:
        """"What did I miss?": the tutor recaps what it said while you were
        busy (or the last few sentences)."""
        since = max(self.busy_since, self.hush_since)
        lines = [t for at, t in self.said_log if since and at >= since - 2]
        lines = lines or [t for _, t in list(self.said_log)[-6:]]
        self.paused = False
        if self.rewound:
            self.rewind(0)
        self.start_turn(MISSED.format(lines="\n".join(f"- {t}" for t in lines)
                                      or "- (nothing yet)"))
        self.player.start_clip(random.choice(self.acks))

    def mark_break(self) -> None:
        if self.lull and self.lull.mark_break():
            emit("toast", text="Got it: I'll treat this screen as a break")
        else:
            emit("toast", text="I can only learn a break screen while a "
                 "full-screen game is in front")

    async def export_anki(self) -> None:
        if not self.deck:
            return
        folder = config.COURSES / ".sidequest" / "exports"
        path = folder / f"sidequest-{self.course or 'all'}.apkg"
        try:
            n = await asyncio.to_thread(self.deck.export_anki, path,
                                        self.course)
        except Exception as e:  # noqa: BLE001
            emit("error", text=f"Anki export failed: {e}")
            return
        emit("toast", text=f"Exported {n} cards for Anki")
        emit("reveal", path=str(path))

    def end_session(self) -> None:
        """The session card (built here, no AI), then a short goodbye."""
        self.flush_grade()
        plan = self.load_plan() or {}
        secs = plan.get("sections", [])
        changes = []
        if self.deck and self.course:
            now = self.deck.ranks(self.course, len(secs))
            for i, r in now.items():
                before = self.session["ranks"].get(self.course, {}).get(
                    i, {}).get("rank", "New")
                if r["rank"] != before:
                    changes.append({"title": secs[i - 1].get("title", ""),
                                    "from": before, "to": r["rank"]})
        cur = int(self.load_progress().get("section", 0) or 0)
        nxt = secs[cur]["title"] if 0 <= cur < len(secs) else ""
        import datetime as dt
        tomorrow = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)
        rest = self.cfg["lesson"].get("restDays") or []
        emit("board", cmd={
            "op": "sessioncard", "title": plan.get("title", self.course or ""),
            "minutes": round((time.monotonic() - self.session["start"]) / 60),
            "recalled": self.session["correct"],
            "asked": self.session["asked"], "ranks": changes,
            "due": self.deck.due_count(tomorrow) if self.deck else 0,
            "streak": self.deck.streak(rest) if self.deck else 0,
            "next": nxt})
        self.paused = False
        self.start_turn(SESSION_END)
        self.paused = True       # no lecture after the goodbye
        self.player.start_clip(random.choice(self.acks))

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
            text = msg["text"].strip()
            self.paused = False
            import ingest
            ids = ingest.youtube_ids(text)
            if ids and self.course:
                emit("heard", text=text)
                await self.add_youtube(ids, text)
            elif not await self.local_command(text):
                emit("heard", text=text)
                self.start_turn(text)
        elif cmd == "button":
            name = msg.get("name")
            if name in ("rapid", "roleplay", "missed", "end", "break", "anki",
                        "busy", "rewind", "live", "teachback", "socratic",
                        "cohost", "kids"):
                await self.on_mode_button(name)
            elif name == "pause":
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

    async def on_mode_button(self, name: str) -> None:
        if name == "rapid":
            self.rapid_fire()
        elif name == "roleplay":
            self.paused = False
            self.start_turn(MODES["roleplay"])
        elif name == "missed":
            self.catch_up()
        elif name == "end":
            self.end_session()
        elif name == "break":
            self.mark_break()
        elif name == "anki":
            await self.export_anki()
        elif name == "busy":
            self.set_busy(not self.busy)
        elif name == "rewind":
            self.rewind(self.rewound + 1)
        elif name == "live":
            self.rewind(0)
        elif name in ("teachback", "socratic"):
            self.set_mode_flag(name, name not in self.modes)
        elif name == "cohost":
            self.set_cohost(not self.cfg["lesson"].get("cohost"))
        elif name == "kids":
            await self.set_kids(not self.kids())

    async def add_youtube(self, ids: list[str], text: str) -> None:
        """A pasted YouTube link: save its transcript as material and teach
        it."""
        import ingest
        dest = config.COURSES / self.course / "materials"
        dest.mkdir(parents=True, exist_ok=True)
        emit("toast", text="Fetching the video's transcript...")
        saved = []
        for vid in ids[:3]:
            try:
                path = await asyncio.to_thread(ingest.youtube_transcript, vid,
                                               dest)
                saved.append(path.name)
            except Exception as e:  # noqa: BLE001
                log(f"youtube transcript {vid} failed: {e!r}")
                emit("error", text=f"Couldn't get that video's transcript "
                     f"(no captions, or YouTube blocked it): {str(e)[:80]}")
        if not saved:
            return
        emit("toast", text=f"Added {', '.join(saved)} to {self.course}")
        self.start_turn(
            f"[sidequest] The learner shared a video; its transcript is in "
            f"materials/{saved[0]}. They wrote: \"{text}\". Skim the "
            f"transcript and teach it as they asked (or, if they didn't say, "
            f"its key ideas, in order, with boards). Refer to moments by "
            f"their timestamps when useful.")

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
                try:
                    import ingest
                    md = ingest.convert(dest / src.name)
                    if md:
                        added[-1] += f" (as {md.name})"
                except Exception as e:  # noqa: BLE001
                    log(f"couldn't convert {src.name}: {e!r}")
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
        plan = self.load_plan()
        if self.deck and plan and name not in self.session["ranks"]:
            # Ranks as they stood when this session met the course.
            self.session["ranks"][name] = self.deck.ranks(
                name, len(plan.get("sections", [])))
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
            self.send_deck()

    def track(self, cmd: dict) -> None:
        """The app owns progress.json and the deck; the tutor reports through
        board ops."""
        op = cmd.get("op")
        if op == "card":
            g, self.pending_grade = self.pending_grade, None
            rating = str(cmd.get("rating") or "").lower()
            if rating not in ("again", "hard", "good", "easy"):
                rating = "good" if (g or {}).get("correct", True) else "again"
            self.grade(str(cmd.get("q") or (g or {}).get("q") or
                           self.last_quiz), rating, str(cmd.get("a") or ""),
                       str(cmd.get("id") or ""))
            return
        if op == "shadow":
            text = str(cmd.get("text", "")).strip()
            lang = str(cmd.get("lang") or ("ar" if re.search(
                r"[؀-ۿ]", text) else "en"))
            self.shadow = {"text": text, "lang": lang} if text else None
            return
        if op == "pick":           # a kids picture question counts as a quiz
            op, cmd = "quiz", {"q": cmd.get("q") or " / ".join(
                str(c.get("label", "")) for c in cmd.get("choices", []))}
        elif op == "answer" and not cmd.get("retry"):
            op, cmd = "result", {"correct": cmd.get("chose") == cmd.get("right")}
        if op == "quiz":
            self.flush_grade()
            self.last_quiz = str(cmd.get("q", ""))
            self.session["asked"] += 1
        elif op == "result":
            self.flush_grade()
            self.pending_grade = {"q": self.last_quiz,
                                  "correct": bool(cmd.get("correct"))}
            self.session["correct"] += bool(cmd.get("correct"))
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
        if self.rewound:
            self.rewind(0)
        warm = self.warm
        if warm and text == KICKOFF and warm["turn"] == self.turn \
                and not (self.turn_task and not self.turn_task.done()):
            # The opening was made at launch: play it now, no waiting.
            self.warm = None
            self.cancel_auto()
            self.turn_auto = False
            self.auto_chunks = 0
            log("warm start: playing the prepared opening")
            self.turn_task = asyncio.create_task(
                self.run_turn(self.turn, text, warm=warm))
            return
        self.drop_warm()
        self.interrupt()
        if not auto:
            self.auto_chunks = 0
        self.turn_auto = auto
        self.turn_task = asyncio.create_task(self.run_turn(self.turn, text))

    def style_prefix(self) -> str:
        """The style dials and language, sent once after any change."""
        if not self.style_dirty:
            return ""
        self.style_dirty = False
        lesson = self.cfg["lesson"]
        persona = lesson.get("persona", "default")
        lines = [f"[sidequest] style: difficulty {lesson.get('difficulty', 3)}"
                 f"/5, humour {lesson.get('humor', 3)}/5, persona "
                 f"{persona if persona in PERSONAS else 'default'}; co-host "
                 f"{'on' if lesson.get('cohost') else 'off'}"]
        lang = lesson.get("teachLanguage", "auto")
        if lang in ("en", "ar"):
            lines.append(f"[sidequest] language: "
                         f"{'Arabic' if lang == 'ar' else 'English'}")
        return "\n".join(lines) + "\n"

    async def run_turn(self, turn: int, text: str,
                       warm: dict | None = None) -> None:
        if warm:
            buf, producer = warm["buf"], warm["task"]
            self.set_state("thinking")
            self.last_voice_at = time.monotonic()
            await self.play_turn(turn, buf, producer)
            return
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
            # notes first (that cost ~8 s before the first word), plus the
            # cards due for review.
            text = text.replace(KICKOFF, self.opening())
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
        if self.warm_dropped:
            self.warm_dropped = False
            text = ("[sidequest] (The session opening you prepared earlier "
                    "was never played; the learner said this first.)\n" + text)
        if self.busy and text == CONTINUE:
            cards = self.deck.due(3) if self.deck else []
            text = MODES["busy"].format(cards=self.card_lines(cards))
        elif self.modes and not text.startswith("[sidequest] Mode"):
            text += f"\n[sidequest] (mode: {', '.join(sorted(self.modes))})"
        text = self.style_prefix() + text + self.visual_nudges(text)
        self.set_state("thinking")
        self.last_voice_at = time.monotonic()
        asyncio.create_task(self.nudge(turn))
        buf = TurnBuffer()
        producer = asyncio.create_task(self.produce(turn, buf, text))
        await self.play_turn(turn, buf, producer)

    async def play_turn(self, turn: int, buf: "TurnBuffer",
                        producer: asyncio.Task) -> None:
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
            self.flush_grade()
            self.push_plan()
            if (not self.plan_exists() and self.has_materials()
                    and not self.planning):
                self.start_planner()   # the tutor just wrote topic.md
            self.waiting_answer = buf.asked
            if buf.asked:
                self.asked_at = time.monotonic()
            if nxt and self.lecturing() and not self.user_talking:
                self.auto_chunks += 1
                self.turn_auto = True
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
                and not self.busy
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
                if kind.startswith("say"):
                    speaker = kind[4:]      # "" tutor, "B" co-host, "C" character
                    if speaker == "B" and not self.cfg["lesson"].get("cohost"):
                        speaker = ""
                    fut = self.loop.run_in_executor(self.tts_pool, self.synth,
                                                    value, speaker)
                    fut.speaker = speaker
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
                    if value.get("op") in KIDS_MEDIA_OPS:
                        # Kids stickers: colour Fluent Emoji, fetched (and
                        # cached) ahead of the voice like any picture.
                        import media
                        task = asyncio.create_task(asyncio.to_thread(
                            media.resolve_stickers, value))
                        queue.put(("media", value, task))
                        if value.get("op") == "pick":
                            queue.asked = True    # waits for her answer
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
                  "anim", "annotate", "cursor", "prop", "propset"}  # kids props animate themselves

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
            await self.wait_unhushed(turn)
            if turn != self.turn:
                return
            if self.replay_last:
                # Back from a long fight: "So, where was I." and the last
                # sentence again, before going on.
                self.replay_last = False
                await self.wait_player()
                if self.last_pcm is not None:
                    self.player.start_clip(self.last_pcm)
                    await self.wait_player()
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
                                min(wait_limit, 4.0))
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
                if value.get("op") not in APP_OPS:
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
                self.track(value)
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
                self.said_log.append((time.monotonic(), value))
                self.last_pcm = pcm
                emit("say", text=value, speaker=getattr(fut, "speaker", ""))
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
            if self.hush or self.rewound:
                self.schedule_auto()     # a fight or a replay: ask again later
                return
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
