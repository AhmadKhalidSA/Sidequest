"""The tutor brain: one persistent Claude session per course, over the Claude
Agent SDK, so it runs on the Claude Code subscription (no API key).

reply() streams the answer as an ordered list of items:
    ("say", sentence)   -> TTS (the main voice)
    ("say:B", sentence) -> TTS in the co-host's voice ("B: ..." lines);
                           "say:C" is a role-play character ("C: ...")
    ("board", {...})    -> whiteboard command, fired when the voice reaches it
    ("tool", label)     -> status line ("Reading ipv4.pdf")
Speech and board commands come from ONE stream, so they are in sync by
construction: no second model has to guess what the first one is saying.

Barge-in: interrupt() aborts the turn, and
reply() always drains a half-finished turn before sending a new query.
Otherwise every answer lags one question behind.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path
from typing import AsyncIterator

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    ToolUseBlock,
)

import config
from prompts import DIRECTOR_PROMPT, PLANNER_PROMPT, SYSTEM_PROMPT

_SENTENCE_END = re.compile(r"[.!?…]['\")\]]?(\s|$)")
_MAX_CHUNK = 220
_MD = re.compile(r"[*_`#~|]|^\s*[-•]\s+", re.MULTILINE)
_FENCE = re.compile(r"^\s*```\w*\s*$")
# "B: ..." / "C: ..." at the start of a speech line: another voice says it.
_SPEAKER = re.compile(r"[ \t]*([BC]):[ \t]+")
_MAYBE_SPEAKER = re.compile(r"[ \t]*([BC]:?)?")


def log(*a) -> None:
    print(*a, file=sys.stderr, flush=True)


def prompt_file(name: str, text: str) -> dict:
    """A system prompt handed to Claude Code as a file. Passed inline, the
    tutor's prompt alone runs past Windows' 32,767-character command-line
    limit and the CLI never starts."""
    path = config.ROOT / "cache" / "prompts" / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_text(encoding="utf-8") != text:
        path.write_text(text, encoding="utf-8")
    return {"type": "file", "path": str(path)}


def with_kids(cfg: dict, prompt: str, illustrator: bool = False) -> str:
    """Kids mode adds its own rules and board ops to a prompt."""
    lesson = cfg.get("lesson", {})
    if not lesson.get("kidsMode"):
        return prompt
    try:
        from kids_prompt import KIDS_REFERENCE, KIDS_RULES
    except ImportError:
        return prompt
    if illustrator:
        return (prompt + "\n\n# Kids mode\nThe learner is a young child. "
                "Characters, stickers and bright, simple scenes; almost no "
                "words on the board.\n" + KIDS_REFERENCE)
    name = str(lesson.get("kidName") or "").strip()
    return (prompt + "\n\n# KIDS MODE (overrides the rules above where they "
            "differ)\n" + KIDS_RULES
            + (f"\nThe child's name is {name}." if name else "")
            + "\n" + KIDS_REFERENCE)


class StreamSplitter:
    """Turns raw text deltas into say/board items. A line starting with '@'
    is a board command (held until its newline arrives). Anything else is
    speech, flushed sentence by sentence so TTS starts before the line ends.
    A speech line starting "B:" or "C:" belongs to another voice."""

    def __init__(self) -> None:
        self.buf = ""
        self.speaker = ""         # voice of the speech line being read
        self._line_start = True
        self._dec = json.JSONDecoder()
        self._joins = 0   # lines glued onto a command whose JSON broke
        self.last_error = ""

    def feed(self, text: str) -> list[tuple]:
        self.buf += text
        return self._drain(final=False)

    def flush(self) -> list[tuple]:
        items = self._drain(final=True)
        self._line_start = True
        return items

    def _drain(self, final: bool) -> list[tuple]:
        items: list[tuple] = []
        while self.buf:
            stripped = self.buf.lstrip()
            if not stripped:
                if final:
                    self.buf = ""
                break
            if stripped.startswith("@"):
                nl = stripped.find("\n")
                if nl < 0 and not final:
                    break  # wait for the whole command line
                line = stripped if nl < 0 else stripped[:nl]
                rest = "" if nl < 0 else stripped[nl + 1:]
                cmds, ok = self._commands(line)
                if not ok:
                    # Common model typos: a stray quote after a number
                    # ("w":200") or a trailing comma before } or ].
                    fixed = re.sub(r'(?<=\d)"(?=\s*[,}\]])', "", line)
                    fixed = re.sub(r",\s*([}\]])", r"\1", fixed)
                    if fixed != line:
                        cmds, ok = self._commands(fixed)
                if not ok and not final and self._joins < 3:
                    # Still broken, probably a line break inside a long svg
                    # string. Glue the next line on and parse again, unless
                    # that line starts a NEW command (never swallow it).
                    if "\n" not in rest:
                        break  # wait for that next line
                    if not rest.lstrip().startswith("@"):
                        self._joins += 1
                        self.buf = line + " " + rest
                        continue
                if not ok:
                    log(f"bad board command dropped ({self.last_error}): "
                        f"{line[:120]} ... {line[-120:]}")
                self._joins = 0
                self.buf = rest
                self._line_start = True
                items.extend(cmds)
                continue
            if self._line_start:
                m = _SPEAKER.match(self.buf)
                if (m is None and not final and "\n" not in self.buf
                        and _MAYBE_SPEAKER.fullmatch(self.buf)):
                    break   # might be the start of "B: ": wait for more
                self.speaker = m.group(1) if m else ""
                if m:
                    self.buf = self.buf[m.end():]
                self._line_start = False
            nl = self.buf.find("\n")
            line = self.buf if nl < 0 else self.buf[:nl]
            at = line.find("@{")
            if at > 0:  # command glued onto a speech line: split it off
                items.extend(self._speech(line[:at], final=True)[0])
                self.buf = self.buf[at:]
                continue
            if nl >= 0:
                items.extend(self._speech(line, final=True)[0])
                self.buf = self.buf[nl + 1:]
                self._line_start = True
                continue
            said, rest = self._speech(line, final=final)
            items.extend(said)
            self.buf = rest
            break
        return items

    def _speech(self, text: str, final: bool) -> tuple[list[tuple], str]:
        if _FENCE.match(text):
            return [], ""
        out = []
        while True:
            m = _SENTENCE_END.search(text)
            if m and (m.end() < len(text) or final):
                chunk, text = text[:m.end()], text[m.end():]
            elif len(text) > _MAX_CHUNK:
                cut = text.rfind(" ", 0, _MAX_CHUNK)
                cut = cut if cut > 40 else _MAX_CHUNK
                chunk, text = text[:cut], text[cut:]
            elif final:
                chunk, text = text, ""
            else:
                break
            chunk = _MD.sub("", chunk).strip()
            if chunk:
                out.append(("say:" + self.speaker if self.speaker else "say",
                            chunk))
            if not text:
                break
        return out, text

    def _commands(self, line: str) -> tuple[list[tuple], bool]:
        """Parse '@{...}' commands; any speech glued between or after them
        on the same line is kept, in order. Returns (items, parsed_ok)."""
        out, s = [], line
        while True:
            at = s.find("@{")
            if at < 0:
                break
            if s[:at].strip():
                out.extend(self._speech(s[:at], final=True)[0])
            try:
                obj, end = self._dec.raw_decode(s[at + 1:])
            except json.JSONDecodeError as e:
                self.last_error = f"{e.msg} at char {e.pos} of {len(s) - at - 1}"
                # Last resort: a tolerant parser for model-made JSON
                # (unescaped quotes inside strings, stray quotes, etc.),
                # over the span up to the line's last closing brace.
                close = s.rfind("}")
                fixed = None
                if close > at:
                    try:
                        import json_repair
                        fixed = json_repair.loads(s[at + 1:close + 1])
                    except Exception:  # noqa: BLE001
                        fixed = None
                if not (isinstance(fixed, dict) and fixed.get("op")):
                    return out, False
                obj, end = fixed, close - at
            if isinstance(obj, dict) and obj.get("op"):
                out.append(("board", obj))
            s = s[at + 1 + end:]
        if s.strip():
            out.extend(self._speech(s, final=True)[0])
        return out, True


def _tool_label(block: ToolUseBlock) -> str:
    inp = block.input or {}
    target = inp.get("file_path") or inp.get("pattern") or inp.get("path") or ""
    name = Path(str(target)).name if target else ""
    verb = {"Read": "Reading", "Glob": "Looking through", "Grep": "Searching",
            "Write": "Writing", "Edit": "Updating",
            "WebSearch": "Searching the web for",
            "WebFetch": "Reading web page"}.get(block.name, block.name)
    if block.name == "WebSearch":
        name = str(inp.get("query", ""))[:60]
    elif block.name == "WebFetch":
        name = str(inp.get("url", ""))[:60]
    return f"{verb} {name}".strip()


class Planner:
    """The slow half of the pair: a separate session with extended thinking
    that designs plan.json in the background while the tutor keeps talking.
    One-shot: connect, plan, write the file, disconnect."""

    def __init__(self, course_dir: Path, cfg: dict,
                 model: str | None = None) -> None:
        brain = cfg.get("brain", {})
        self.model = model or brain.get("plannerModel", "opus")
        self._options = ClaudeAgentOptions(
            model=self.model,
            system_prompt=prompt_file("planner", PLANNER_PROMPT),
            tools=["Read", "Glob", "Grep", "Write", "WebSearch", "WebFetch"],
            allowed_tools=["Read", "Glob", "Grep", "Write", "WebSearch",
                           "WebFetch"],
            permission_mode="bypassPermissions",
            cwd=str(course_dir),
            setting_sources=[],
            # No MCP at all: without this, the account's claude.ai connectors
            # (Docs, Gmail, ...) load into the session and get called.
            mcp_servers={},
            strict_mcp_config=True,
            max_buffer_size=64 * 1024 * 1024,
            thinking={"type": "adaptive"},
            effort="high",
        )

    async def run(self, on_tool=None) -> str:
        client = ClaudeSDKClient(options=self._options)
        await client.connect()
        try:
            await client.query("Design the course plan now.")
            summary = ""
            async for msg in client.receive_response():
                if isinstance(msg, AssistantMessage) and on_tool:
                    for block in msg.content:
                        if isinstance(block, ToolUseBlock):
                            on_tool(_tool_label(block))
                elif isinstance(msg, ResultMessage):
                    summary = str(getattr(msg, "result", "") or "")
                    # is_error can be set on a "success" result (a tool call
                    # that errored along the way); only a real failure counts.
                    if msg.is_error and msg.subtype != "success":
                        raise RuntimeError(f"planner failed: {msg.subtype}")
                    if summary.startswith("API Error"):
                        # e.g. a model safeguard refusing the topic. The
                        # result is the refusal text, not a plan.
                        raise RuntimeError(summary[:240])
            return summary
        finally:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass


class Director:
    """The background illustrator (the Talker-Reasoner split): the tutor
    writes a one-line brief and keeps talking; this separate session turns
    the brief into a rich, choreographed set of board commands. One
    persistent connection, so a build doesn't pay the CLI spawn; requests
    are independent, so the session is recycled now and then to keep its
    context (and latency) small."""

    RECYCLE_AFTER = 20

    def __init__(self, cfg: dict, cwd: Path) -> None:
        brain = cfg.get("brain", {})
        self._options = ClaudeAgentOptions(
            model=brain.get("directorModel", "sonnet"),
            system_prompt=prompt_file("illustrator", with_kids(
                cfg, DIRECTOR_PROMPT, illustrator=True)),
            tools=[],
            allowed_tools=[],
            cwd=str(cwd),
            setting_sources=[],
            mcp_servers={},
            strict_mcp_config=True,
            max_buffer_size=64 * 1024 * 1024,
            thinking={"type": "disabled"},
            include_partial_messages=True,
        )
        self._client: ClaudeSDKClient | None = None
        self._lock = asyncio.Lock()
        self._built = 0

    async def start(self) -> None:
        await self.stop()
        self._client = ClaudeSDKClient(options=self._options)
        await self._client.connect()
        self._built = 0

    async def stop(self) -> None:
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self._client = None

    async def stream(self, slot: str, brief: str, rect: dict):
        """Yield board commands one by one AS they're written, so the scene
        starts appearing ~2 s in and draws itself piece by piece."""
        async with self._lock:
            if self._client is None or self._built >= self.RECYCLE_AFTER:
                await self.start()
            self._built += 1
            await self._client.query(
                f"Slot id: {slot}. Rectangle: x={rect['x']}, y={rect['y']}, "
                f"w={rect['w']}, h={rect['h']}.\nBrief: {brief}")
            split = StreamSplitter()
            async for msg in self._client.receive_response():
                if type(msg).__name__ != "StreamEvent":
                    continue
                ev = msg.event
                delta = ev.get("delta", {}) if ev.get("type") == \
                    "content_block_delta" else {}
                if delta.get("type") == "text_delta":
                    for kind, value in split.feed(delta.get("text", "")):
                        if kind == "board":
                            yield value
            for kind, value in split.flush():
                if kind == "board":
                    yield value


class Tutor:
    def __init__(self, course_dir: Path, cfg: dict) -> None:
        self.course_dir = course_dir
        self._session_file = course_dir / ".session"
        brain = cfg.get("brain", {})
        self._options = ClaudeAgentOptions(
            model=brain.get("model", "sonnet"),
            system_prompt=prompt_file("tutor", with_kids(cfg, SYSTEM_PROMPT)),
            # Files in the course folder (material, plan, notes), screenshots
            # (Read handles images), and the web for anything current.
            tools=["Read", "Glob", "Grep", "Write", "Edit", "WebSearch",
                   "WebFetch"],
            allowed_tools=["Read", "Glob", "Grep", "Write", "Edit",
                           "WebSearch", "WebFetch"],
            permission_mode="bypassPermissions",
            cwd=str(course_dir),
            setting_sources=[],
            # No MCP at all: without this, the account's claude.ai connectors
            # (Docs, Gmail, ...) load into the session and get called.
            mcp_servers={},
            strict_mcp_config=True,
            include_partial_messages=True,
            max_buffer_size=64 * 1024 * 1024,
            thinking=({"type": "adaptive"} if brain.get("thinking")
                      else {"type": "disabled"}),
        )
        self._client: ClaudeSDKClient | None = None
        self._lock = asyncio.Lock()
        self._turn_open = False
        self.resumed = False

    async def start(self) -> None:
        sid = None
        if self._session_file.exists():
            sid = self._session_file.read_text().strip() or None
        self._options.resume = sid
        try:
            self._client = ClaudeSDKClient(options=self._options)
            await self._client.connect()
            self.resumed = bool(sid)
        except Exception:
            if sid is None:
                raise
            log("saved session would not resume; starting fresh")
            self._options.resume = None
            self._client = ClaudeSDKClient(options=self._options)
            await self._client.connect()

    async def stop(self) -> None:
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self._client = None

    async def _drain(self, timeout: float) -> None:
        if self._client is None:
            return
        try:
            await self._client.interrupt()
        except Exception:  # noqa: BLE001
            pass
        if not self._turn_open:
            return
        try:
            async with asyncio.timeout(timeout):
                async for _ in self._client.receive_response():
                    pass
            self._turn_open = False
        except Exception:  # noqa: BLE001
            pass

    async def interrupt(self) -> None:
        """Abort generation only. The reply() loop that owns the stream keeps
        reading until the aborted turn's ResultMessage, so there is never a
        second reader competing for messages."""
        if self._client is None:
            return
        try:
            await self._client.interrupt()
        except Exception:  # noqa: BLE001 — nothing in flight
            pass

    async def reply(self, text: str) -> AsyncIterator[tuple]:
        assert self._client is not None, "start() first"
        async with self._lock:
            if self._turn_open:
                await self._drain(timeout=5)
            await self._client.query(text)
            self._turn_open = True
            split = StreamSplitter()
            async for msg in self._client.receive_response():
                if isinstance(msg, AssistantMessage):
                    for block in msg.content:
                        if isinstance(block, ToolUseBlock):
                            yield ("tool", _tool_label(block))
                    continue
                if isinstance(msg, ResultMessage):
                    if msg.session_id:
                        self._session_file.write_text(msg.session_id)
                    if msg.is_error:
                        log(f"turn ended with error: {msg.subtype} "
                            f"{getattr(msg, 'result', '')}")
                    continue
                if type(msg).__name__ != "StreamEvent":
                    continue
                ev = msg.event
                kind = ev.get("type")
                if kind == "content_block_stop":
                    # text block -> tool call boundary: speak what we have
                    for item in split.flush():
                        yield item
                    continue
                if kind != "content_block_delta":
                    continue
                delta = ev.get("delta", {})
                if delta.get("type") == "text_delta":
                    for item in split.feed(delta.get("text", "")):
                        yield item
            self._turn_open = False
            for item in split.flush():
                yield item
