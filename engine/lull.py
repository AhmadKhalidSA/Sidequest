"""Lull meter: is the game keeping you busy right now?

It reads only what any overlay can see, the same way a screen recorder
does, and never touches the game process:
  - how fast keys and mouse buttons are being pressed (GetAsyncKeyState
    polling, like the hotkeys),
  - how much the picture changes between two tiny screenshots.
It only counts while a full-screen (borderless) window is in front, so
typing in a browser or an editor never looks like a fight.

Screens you mark as a break ("this is a break") are remembered per game
window and always count as calm: a respawn screen, a queue, a lobby.

States: "fight" (pause the voice), "calm" (teach), "away" (no game in
front: teach)."""

from __future__ import annotations

import ctypes
import json
import threading
import time
from ctypes import wintypes
from pathlib import Path
from typing import Callable

_user32 = ctypes.windll.user32

# Keys games mostly use: movement, abilities, number row, mouse buttons.
WATCHED = ([ord(c) for c in "WASDQERFCVGXZ12345"]
           + [0x20, 0x10, 0x11, 0x09, 0x01, 0x02, 0x04, 0x05, 0x06])
POLL_S = 1 / 40
GRAB_S = 0.5
THUMB = (48, 27)          # tiny grey screenshot used for motion and matching
MATCH = 0.9               # similarity that counts as a remembered break screen


class _MonitorInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


def foreground_game() -> tuple[str, dict] | None:
    """(window key, monitor rect) when the foreground window covers its whole
    monitor and isn't the desktop or Sidequest itself; else None."""
    hwnd = _user32.GetForegroundWindow()
    if not hwnd:
        return None
    cls = ctypes.create_unicode_buffer(128)
    _user32.GetClassNameW(hwnd, cls, 128)
    title = ctypes.create_unicode_buffer(256)
    _user32.GetWindowTextW(hwnd, title, 256)
    if cls.value in ("Progman", "WorkerW", "Shell_TrayWnd") \
            or title.value == "Sidequest":
        return None
    rect = wintypes.RECT()
    _user32.GetWindowRect(hwnd, ctypes.byref(rect))
    mon = _user32.MonitorFromWindow(hwnd, 2)          # MONITOR_DEFAULTTONEAREST
    info = _MonitorInfo(cbSize=ctypes.sizeof(_MonitorInfo))
    if not _user32.GetMonitorInfoW(mon, ctypes.byref(info)):
        return None
    m = info.rcMonitor
    if (rect.left, rect.top, rect.right, rect.bottom) != (m.left, m.top,
                                                          m.right, m.bottom):
        return None
    return f"{cls.value}|{title.value}", {
        "left": m.left, "top": m.top, "width": m.right - m.left,
        "height": m.bottom - m.top}


class LullMeter:
    """Polls in a background thread; on_change(state, score) fires on each
    state change (from that thread: the caller marshals it)."""

    def __init__(self, store: Path, on_change: Callable[[str, float], None],
                 fight_at: float = 0.6, calm_at: float = 0.3) -> None:
        self.store = store
        self.on_change = on_change
        self.fight_at, self.calm_at = fight_at, calm_at
        self.state = "away"
        self.score = 0.0
        self.window: str | None = None
        self._thumb = None
        try:
            self.breaks: dict[str, list] = json.loads(
                store.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            self.breaks = {}
        self._stop = threading.Event()
        threading.Thread(target=self._run, daemon=True, name="lull").start()

    def stop(self) -> None:
        self._stop.set()

    def mark_break(self) -> bool:
        """Remember the current screen as a break for this game window."""
        if self.window is None or self._thumb is None:
            return False
        shots = self.breaks.setdefault(self.window, [])
        shots.append([round(float(v), 1) for v in self._thumb.flatten()])
        del shots[:-8]                     # the last 8 break screens per game
        self.store.parent.mkdir(parents=True, exist_ok=True)
        self.store.write_text(json.dumps(self.breaks), encoding="utf-8")
        self._set("calm")
        return True

    # --------------------------------------------------------------- loop
    def _grab(self, mon: dict):
        import mss
        import numpy as np
        from PIL import Image
        with mss.mss() as sct:
            shot = sct.grab(mon)
        img = Image.frombytes("RGB", shot.size, shot.rgb).convert("L")
        return np.asarray(img.resize(THUMB, Image.BOX), dtype=np.float32)

    def _on_break_screen(self, thumb) -> bool:
        import numpy as np
        for shot in self.breaks.get(self.window or "", []):
            ref = np.asarray(shot, dtype=np.float32).reshape(thumb.shape)
            if 1 - float(np.abs(ref - thumb).mean()) / 255 >= MATCH:
                return True
        return False

    def _set(self, state: str) -> None:
        if state != self.state:
            self.state = state
            try:
                self.on_change(state, round(self.score, 2))
            except Exception:  # noqa: BLE001 — never kill the poller
                pass

    def _run(self) -> None:
        was_down = {k: False for k in WATCHED}
        presses: list[float] = []
        motion = 0.0
        last_grab = 0.0
        hot_since = cool_since = None
        while not self._stop.is_set():
            now = time.monotonic()
            for k in WATCHED:
                down = bool(_user32.GetAsyncKeyState(k) & 0x8000)
                if down and not was_down[k]:
                    presses.append(now)
                was_down[k] = down
            presses = [t for t in presses if now - t < 2.0]
            if now - last_grab >= GRAB_S:
                last_grab = now
                game = foreground_game()
                if game is None:
                    self.window, self._thumb = None, None
                    hot_since = cool_since = None
                    self.score = 0.0
                    self._set("away")
                else:
                    self.window, mon = game
                    try:
                        thumb = self._grab(mon)
                    except Exception:  # noqa: BLE001
                        thumb = None
                    if thumb is not None and self._thumb is not None:
                        diff = float(abs(thumb - self._thumb).mean()) / 255
                        motion = 0.6 * motion + 0.4 * diff
                    self._thumb = thumb if thumb is not None else self._thumb
                    rate = len(presses) / 2.0           # presses per second
                    self.score = min(1.0, 0.55 * min(1.0, rate / 4.0)
                                     + 0.45 * min(1.0, motion / 0.06))
                    on_break = thumb is not None and self._on_break_screen(thumb)
                    if on_break or self.score <= self.calm_at:
                        hot_since = None
                        cool_since = cool_since or now
                        if on_break or now - cool_since >= 3.0 \
                                or self.state == "away":
                            self._set("calm")
                    elif self.score >= self.fight_at:
                        cool_since = None
                        hot_since = hot_since or now
                        if now - hot_since >= 1.0:
                            self._set("fight")
                    else:
                        hot_since = cool_since = None
            time.sleep(POLL_S)
