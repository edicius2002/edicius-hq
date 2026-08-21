"""
What this address has already spent today, and what is left of the day.

`daily_request_budget()` says "daily" and was handed to `due_now` as a
**per-pass** ceiling. Nothing carried spend from one pass to the next, so a cron
every fifteen minutes — ninety-six passes a day — would have every one of them
believe it had the whole budget to itself, and the day's total would be
unbounded by construction. That is the one item on the repository's open list
that can reach somebody outside this machine: the upstream is a Google Flights
scraper running from a residential address, because 12.9 records that Google
fingerprints datacenter ones and there is no second provider to fall back to.

**One line per request actually sent, in a file named after the day.**

- *Per request, not per look.* The heartbeats under `fares/checks/` were the
  obvious home and they cannot serve. A heartbeat is one line per **look**, and
  a calendar look is 2 to 12 HTTP requests, because a refused far end is walked
  back and asked for again (12.245) — measured, a city pair's calendar costs
  **2.43 requests a day and not 2**. A ledger keyed to looks would under-count
  precisely the pass this file exists to bound, and would have to grow a
  `requests` field on a record that means something else to stop doing so.

- *Written before the answer, not after.* A heartbeat is recorded once the
  provider has replied. A request that left this address and then took the
  process down with it leaves no heartbeat and has still been sent. What the
  budget protects is Google's view of this address, so the ledger records the
  send: it over-counts a request that failed to leave rather than under-counting
  one that did.

- *A file per day, so the reset is not an operation.* Midnight does not clear a
  counter here; it names a different file, and a day nobody has collected on is
  a file that does not exist yet. There is nothing to run at a boundary and
  nothing to get wrong when it is missed.

- *Beside the archive rather than inside `checks/`, and never one file forever.*
  The check files are read end to end on every pass by `last_checked` and they
  grow for the life of the archive, so summing a day out of them would mean
  re-reading a year to learn about today — twice, because the boards and the
  calendar keep their heartbeats in two different stores. A day file is at most
  `budget` short lines and is never read again after its day.

Durability is the whole point. The collector is a stateless command a scheduler
invokes fresh, so an in-memory counter buys nothing at all: it would be born at
zero ninety-six times a day, which is the bug rather than the fix.
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path

from app.config import daily_request_budget, fares_dir

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


class RequestLedger:
    """
    Every upstream request this address sent, one line per request, per day.

    Append-only and one file per day, the same shape as the archive beside it
    and for the same reasons: appending touches nothing already written, and a
    crash mid-write can cost the last line and nothing before it.
    """

    def __init__(self, directory: Path | None = None) -> None:
        self._dir = directory

    @property
    def directory(self) -> Path:
        return self._dir if self._dir is not None else fares_dir() / "spend"

    def path_for(self, day: date) -> Path:
        return self.directory / f"{day.isoformat()}.jsonl"

    def spent(self, day: date) -> int | None:
        """
        How many requests that day's file records, or `None` if it cannot say.

        Counted as lines rather than parsed as JSON. A half-written last line is
        still a request that left this address, and the only question being
        asked of the file is how many there were — so the cheap count is also
        the honest one.

        `None` is not zero and callers must not treat it as such: a day whose
        spend cannot be established is a day this process has no idea how much
        it has already sent, and guessing low is the one guess that spends the
        asset. `DailyBudget` reads it as "the day is gone", which stops the pass
        and reports every departure as `over-budget` — loudly, in the report,
        rather than by collecting quietly on an unknown total.
        """
        path = self.path_for(day)
        if not path.exists():
            return 0
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            logger.error("fare ledger could not read %s: %s", path, error)
            return None
        return sum(1 for line in text.splitlines() if line.strip())

    def spend(self, day: date, *, kind: str, what: str) -> None:
        """
        Record one request as sent.

        `kind` is `board` or `calendar` and `what` is the route and, for a
        board, its departure. Neither is read by anything here — the count is
        the whole of what the budget needs — and both are written because the
        day file is also the only place that can answer "what did those 600
        requests go on", which is the question anybody tuning the cadence table
        or the calendar's windows will ask next.
        """
        row = {"at": _now(), "kind": kind, "what": what}
        path = self.path_for(day)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError as error:
            # The request still left. `DailyBudget` counts it in memory whatever
            # this did, so a ledger that cannot be written costs the record of
            # the day rather than the ceiling over it.
            logger.error("fare ledger could not record a request on %s: %s", day, error)


@dataclass
class DailyBudget:
    """
    What is left of today, for a pass to spend.

    Mutable, unlike nearly everything else in the collector, because it is the
    thing that changes while a pass runs — `CollectionPass` is the precedent and
    the reason is the same.

    **The day is fixed when this is built and does not move.** A pass that
    starts at 23:58 keeps spending against the day it started in. Re-deriving
    the date per request would hand a running pass a fresh ceiling halfway
    through, which is the same hole as reading the budget once per pass, just
    with a rarer trigger.
    """

    ledger: RequestLedger
    ceiling: int
    day: date
    #: What this object has watched leave the address, whatever the file did
    #: with it. Starts at nothing and is outranked by the file until the pass
    #: overtakes it, which is what makes a failed append cost the record of a
    #: request rather than the request itself.
    witnessed: int = field(default=0)

    def spent(self) -> int:
        """Today's total: the file's count, or ours, whichever is further on."""
        recorded = self.ledger.spent(self.day)
        if recorded is None:
            return self.ceiling
        return max(recorded, self.witnessed)

    def remaining(self) -> int:
        return max(0, self.ceiling - self.spent())

    def take(self, *, kind: str, what: str) -> None:
        """Spend one request, before it is sent."""
        self.witnessed = self.spent() + 1
        self.ledger.spend(self.day, kind=kind, what=what)


#: The one ledger this process writes, beside `HISTORY` and `CALENDAR` and for
#: the same reason: there is one address, so there is one day's spend.
LEDGER = RequestLedger()


def daily_budget(
    *,
    ceiling: int | None = None,
    ledger: RequestLedger | None = None,
    now: datetime | None = None,
) -> DailyBudget:
    """Today's allowance, read off disk rather than started at zero."""
    moment = now if now is not None else datetime.now(UTC)
    day = (moment.astimezone(UTC) if moment.tzinfo is not None else moment).date()
    return DailyBudget(
        ledger=ledger if ledger is not None else LEDGER,
        ceiling=ceiling if ceiling is not None else daily_request_budget(),
        day=day,
    )
