"""Global hotkeys by polling GetAsyncKeyState.

Polling (not a keyboard hook) is deliberate: it never swallows the key from
the game, needs no admin rights, sees mouse side buttons, and gives us real
key-UP events, which push-to-talk needs and Electron's globalShortcut lacks.
"""

from __future__ import annotations

import ctypes
import threading
import time
from typing import Callable

_user32 = ctypes.windll.user32

_NAMED = {
    "MOUSE3": 0x04, "MBUTTON": 0x04,
    "MOUSE4": 0x05, "XBUTTON1": 0x05,
    "MOUSE5": 0x06, "XBUTTON2": 0x06,
    "BACKSPACE": 0x08, "TAB": 0x09, "ENTER": 0x0D, "SHIFT": 0x10,
    "CTRL": 0x11, "ALT": 0x12, "PAUSE": 0x13, "CAPSLOCK": 0x14,
    "ESC": 0x1B, "SPACE": 0x20, "PAGEUP": 0x21, "PAGEDOWN": 0x22,
    "END": 0x23, "HOME": 0x24, "LEFT": 0x25, "UP": 0x26, "RIGHT": 0x27,
    "DOWN": 0x28, "INSERT": 0x2D, "DELETE": 0x2E,
    "LSHIFT": 0xA0, "RSHIFT": 0xA1, "LCTRL": 0xA2, "RCTRL": 0xA3,
    "LALT": 0xA4, "RALT": 0xA5,
    "BACKTICK": 0xC0, "MINUS": 0xBD, "EQUALS": 0xBB, "LBRACKET": 0xDB,
    "RBRACKET": 0xDD, "BACKSLASH": 0xDC, "SEMICOLON": 0xBA,
    "QUOTE": 0xDE, "COMMA": 0xBC, "PERIOD": 0xBE, "SLASH": 0xBF,
    "SCROLLLOCK": 0x91, "NUMLOCK": 0x90,
}
_NAMED.update({f"F{i}": 0x6F + i for i in range(1, 25)})
_NAMED.update({f"NUMPAD{i}": 0x60 + i for i in range(10)})
_NAMED.update({chr(c): c for c in range(ord("A"), ord("Z") + 1)})
_NAMED.update({str(d): 0x30 + d for d in range(10)})

_PRETTY = {"MOUSE3": "Middle mouse", "MOUSE4": "Mouse 4", "MOUSE5": "Mouse 5",
           "XBUTTON1": "Mouse 4", "XBUTTON2": "Mouse 5",
           "MBUTTON": "Middle mouse"}


def vk(name: str) -> int:
    key = str(name).strip().upper().replace(" ", "")
    if key.startswith("0X"):
        return int(key, 16)
    if key not in _NAMED:
        raise ValueError(f"unknown key name {name!r} (see README for names)")
    return _NAMED[key]


def pretty(name: str) -> str:
    return _PRETTY.get(str(name).upper(), str(name).upper())


class KeyWatcher:
    """Calls on_event(action, down) on press/release of each bound key.
    on_event runs on the polling thread; the caller marshals to asyncio."""

    def __init__(self, bindings: dict[str, str],
                 on_event: Callable[[str, bool], None]) -> None:
        self._codes = {action: vk(name) for action, name in bindings.items()}
        self._on_event = on_event
        self._state = {action: False for action in self._codes}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name="keys")

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            for action, code in self._codes.items():
                down = bool(_user32.GetAsyncKeyState(code) & 0x8000)
                if down != self._state[action]:
                    self._state[action] = down
                    try:
                        self._on_event(action, down)
                    except Exception:  # noqa: BLE001 — never kill the poller
                        pass
            time.sleep(0.012)
