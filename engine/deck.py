"""Spaced memory deck: every checkpoint question becomes a card, scheduled
with FSRS (the algorithm Anki uses) and shared across all courses, so each
session can open with what's actually due. The study streak and the
per-section ranks are derived from the same review log.

Stored in courses/.sidequest/deck.json (a dot folder, so it never shows up
as a course)."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
from pathlib import Path

from fsrs import Card, Rating, Scheduler

RATINGS = {"again": Rating.Again, "hard": Rating.Hard, "good": Rating.Good,
           "easy": Rating.Easy}
RANKS = ["New", "Bronze", "Silver", "Gold", "Diamond"]
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
REPAIR_REVIEWS = 3        # reviews in a day that repair yesterday's miss
REPAIR_EVERY_DAYS = 7     # at most one repair a week


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _today() -> dt.date:
    return dt.date.today()


def card_id(course: str, q: str) -> str:
    norm = re.sub(r"\W+", " ", q.lower()).strip()
    return hashlib.sha1(f"{course}|{norm}".encode()).hexdigest()[:8]


class Deck:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.scheduler = Scheduler(enable_fuzzing=False)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            data = {}
        self.cards: dict[str, dict] = data.get("cards", {})
        self.days: dict[str, int] = data.get("days", {})   # date -> reviews
        self.repaired: list[str] = data.get("repaired", [])

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"cards": self.cards, "days": self.days,
                                   "repaired": self.repaired}, indent=1,
                                  ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)

    # ------------------------------------------------------------ reviews
    def review(self, course: str, section: int, q: str, a: str = "",
               rating: str = "good", sure: bool | None = None,
               cid: str = "") -> dict:
        """Grade one answer. Creates the card the first time it's asked."""
        cid = cid if cid in self.cards else card_id(course, q)
        card = self.cards.get(cid)
        if card is None:
            card = self.cards[cid] = {
                "id": cid, "course": course, "section": section, "q": q,
                "a": a, "fsrs": Card().to_dict(), "log": [],
                "created": _today().isoformat()}
        if a and not card.get("a"):
            card["a"] = a
        fs, _ = self.scheduler.review_card(
            Card.from_dict(card["fsrs"]), RATINGS.get(rating, Rating.Good))
        card["fsrs"] = fs.to_dict()
        today = _today().isoformat()
        card["log"].append([today, rating] + ([sure] if sure is not None
                                                else []))
        self.days[today] = self.days.get(today, 0) + 1
        self._maybe_repair()
        self.save()
        return card

    def due(self, limit: int = 6, course: str | None = None) -> list[dict]:
        """Cards due now, most overdue first, alternating courses so a
        session's warm-up mixes subjects."""
        now = _now()
        hits = [c for c in self.cards.values()
                if (course is None or c["course"] == course)
                and dt.datetime.fromisoformat(c["fsrs"]["due"]) <= now]
        hits.sort(key=lambda c: c["fsrs"]["due"])
        by_course: dict[str, list] = {}
        for c in hits:
            by_course.setdefault(c["course"], []).append(c)
        mixed = []
        while any(by_course.values()) and len(mixed) < limit:
            for cards in by_course.values():
                if cards and len(mixed) < limit:
                    mixed.append(cards.pop(0))
        return mixed

    def due_count(self, when: dt.datetime | None = None) -> int:
        when = when or _now()
        return sum(dt.datetime.fromisoformat(c["fsrs"]["due"]) <= when
                   for c in self.cards.values())

    def recent(self, course: str, limit: int = 5) -> list[dict]:
        """Most recently created cards of a course (rapid-fire fodder when
        nothing is due yet)."""
        cards = [c for c in self.cards.values() if c["course"] == course]
        cards.sort(key=lambda c: (c["log"][-1][0] if c["log"] else "",
                                  c["created"]), reverse=True)
        return cards[:limit]

    # -------------------------------------------------------------- ranks
    def section_rank(self, course: str, section: int) -> tuple[str, bool]:
        """(rank, rusty). A rank comes only from recall: passing every card
        of the section, then passing them again on later days. Overdue
        reviews make it rusty, which shows one rank lower."""
        cards = [c for c in self.cards.values()
                 if c["course"] == course and c["section"] == section]
        if not cards:
            return "New", False

        def pass_days(c: dict) -> int:
            return len({d for d, r, *_ in c["log"] if r != "again"})

        def passing(c: dict) -> bool:
            return bool(c["log"]) and c["log"][-1][1] != "again"

        level = 1
        if all(passing(c) for c in cards):
            level = 2
            if all(pass_days(c) >= 2 for c in cards):
                level = 3
                if all(pass_days(c) >= 3 and c["fsrs"].get("stability", 0) >= 21
                       for c in cards):
                    level = 4
        late = _now() - dt.timedelta(days=2)
        rusty = any(dt.datetime.fromisoformat(c["fsrs"]["due"]) < late
                    for c in cards)
        if rusty and level > 1:
            level -= 1
        return RANKS[level], rusty

    def ranks(self, course: str, sections: int) -> dict[int, dict]:
        out = {}
        for i in range(1, sections + 1):
            rank, rusty = self.section_rank(course, i)
            out[i] = {"rank": rank, "rusty": rusty}
        return out

    # ------------------------------------------------------------- streak
    def streak(self, rest_days: list[str] | None = None) -> int:
        """Days studied in a row. Rest days you picked don't break it, and
        one missed day a week is repaired by a short review the day after.
        Today only counts once you've reviewed something."""
        rest = {WEEKDAYS.index(d) for d in (rest_days or []) if d in WEEKDAYS}
        day = _today()
        if not self.days.get(day.isoformat()):
            day -= dt.timedelta(days=1)   # not studied yet today: no break
        count = 0
        for _ in range(3650):
            key = day.isoformat()
            if self.days.get(key):
                count += 1
            elif day.weekday() in rest or key in self.repaired:
                pass
            else:
                break
            day -= dt.timedelta(days=1)
        return count

    def _maybe_repair(self) -> None:
        today = _today()
        if self.days.get(today.isoformat(), 0) != REPAIR_REVIEWS:
            return
        yesterday = today - dt.timedelta(days=1)
        before = today - dt.timedelta(days=2)
        recent = [d for d in self.repaired if dt.date.fromisoformat(d)
                  > today - dt.timedelta(days=REPAIR_EVERY_DAYS)]
        if (not self.days.get(yesterday.isoformat()) and not recent
                and self.days.get(before.isoformat())):
            self.repaired.append(yesterday.isoformat())

    def reviewed_on(self, day: dt.date | None = None) -> int:
        return self.days.get((day or _today()).isoformat(), 0)

    # --------------------------------------------------------------- anki
    def export_anki(self, path: Path, course: str | None = None) -> int:
        """Write an Anki .apkg with every card (or one course's)."""
        import genanki
        model = genanki.Model(
            1607392319, "Sidequest card",
            fields=[{"name": "Question"}, {"name": "Answer"},
                    {"name": "Course"}],
            templates=[{"name": "Card 1", "qfmt": "{{Question}}",
                        "afmt": "{{FrontSide}}<hr id=answer>{{Answer}}"
                                "<br><small>{{Course}}</small>"}])
        name = f"Sidequest::{course}" if course else "Sidequest"
        deck = genanki.Deck(int(hashlib.sha1(name.encode()).hexdigest()[:8], 16),
                            name)
        n = 0
        for c in self.cards.values():
            if course and c["course"] != course:
                continue
            deck.add_note(genanki.Note(
                model=model, fields=[c["q"], c.get("a") or "", c["course"]],
                guid=genanki.guid_for(c["id"]),
                tags=[re.sub(r"\W+", "_", c["course"])]))
            n += 1
        path.parent.mkdir(parents=True, exist_ok=True)
        genanki.Package(deck).write_to_file(str(path))
        return n
