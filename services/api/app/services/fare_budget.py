"""
What this address has already sent today, and — if anything says so — what is
left of the day.

**Two things live here and only one of them is still on by default.** The
*ledger* records every request this address sends, one line each, and it is
unconditional: it is written whether or not there is a ceiling over it, because
what it answers — how much did we send, and on what — is the question that has
to be answerable before anybody can size a ceiling honestly. The *ceiling* is
`config.daily_request_budget()`, which now answers `None` unless an environment
sets a number, and `None` means no ceiling rather than a ceiling of zero. Every
signature below that used to promise an `int` promises `int | None` for exactly
that reason: a caller has to say which of the two it has, and the type is what
makes it say so.

`daily_request_budget()` says "daily" and was once handed to `due_now` as a
**per-pass** ceiling. Nothing carried spend from one pass to the next, so a cron
every fifteen minutes — ninety-six passes a day — would have every one of them
believe it had the whole budget to itself, and the day's total would be
unbounded by construction. That is the one item on the repository's open list
that can reach somebody outside this machine: the upstream is a Google Flights
scraper running from a residential address, because 12.9 records that Google
fingerprints datacenter ones and there is no second provider to fall back to.

What protects that address today is not a count. `REQUEST_GAP_SECONDS` paces
every request three seconds apart, `PassLock` below allows one board pass and
one calendar pass on this machine at a time, and the cadence table decides how
often a departure is worth looking at at all. Those bound the rate, which is
what an unmetered endpoint can actually notice. The ceiling bounded a total,
which it never saw — and `config.py` records why a total nobody has measured
stopped being allowed to stop a pass.

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
  nothing to get wrong when it is missed. This survives the ceiling being off
  and matters more without it: with nothing refusing at a number, "today" is the
  only frame in which the figure means anything.

- *Beside the archive rather than inside `checks/`, and never one file forever.*
  The check files are read end to end on every pass by `last_checked` and they
  grow for the life of the archive, so summing a day out of them would mean
  re-reading a year to learn about today — twice, because the boards and the
  calendar keep their heartbeats in two different stores. A day file is one
  short line per request sent and is never read again after its day.

Durability is the whole point. The collector is a stateless command a scheduler
invokes fresh, so an in-memory counter buys nothing at all: it would be born at
zero ninety-six times a day, which is the bug rather than the fix.

**And one pass at a time, across processes and not only inside one.** `PassLock`
is the file-system half of `CollectionRunner`'s single slot, which serialises
passes inside the API process and cannot see the scheduled command, which is a
second process.

It was argued for as the thing that made a ceiling enforceable — a ledger alone
bounds a day only *eventually*, because two passes starting together each read a
day with room in it, each size a whole day's work against that, and each begin
spending before either can see the other. That argument is retired with the
default ceiling and the lock is not, because the other half of what it does was
never about the count: two passes running at once halve `REQUEST_GAP_SECONDS`
without anybody deciding to. Pace is what this address is actually protected by,
so the lock is now the load-bearing one of the pair rather than the support.

**Ninety days of day files, and the ninety-first is deleted.** Nothing reads a
day file after its day and the directory otherwise grows one file a day forever.
The archive beside it is append-only on purpose and this is deliberately not:
`fares/history` and `fares/checks` record what the world cost, which exists
nowhere else once the day passes, while this records what *we* sent, which is
evidence about us and is reconstructible to within the look-to-request
multiplier from the heartbeats that are kept forever.
"""

import json
import logging
import os
import socket
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from app.config import SPEND_RETENTION_DAYS, daily_request_budget, fares_dir

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


@contextmanager
def _ignoring_oserror() -> Iterator[None]:
    """A best-effort tidy-up that must never be the reason a pass fails."""
    try:
        yield
    except OSError as error:
        logger.error("fare budget housekeeping failed: %s", error)


def prune_day_files(
    directory: Path,
    today: date,
    *,
    keep_days: int = SPEND_RETENTION_DAYS,
    what: str = "fare ledger",
) -> int:
    """
    Delete the day files in `directory` that are more than `keep_days` days old.

    **Run when a day file is created and at no other time.** That is once a day
    at most, it is the only moment the directory has grown, and in a real pass
    it is already inside `PassLock`, so nothing has to be said about two
    processes sweeping at once. A scheduled sweep was rejected for the reason
    the day file itself was chosen over a rolling counter: a boundary that needs
    something run at it is a boundary that gets missed.

    Only files this repository could have written are touched — the name has to
    parse as a date. Anything else in the directory was put there by somebody
    else and deleting it is not this function's business.

    A failure here is logged and swallowed. The worst case is a directory that
    keeps a few more days than it meant to, which is not a reason to stop a pass
    that is otherwise able to collect.

    **A free function rather than a method, because there are two ledgers of
    days now** — `fares/spend/` a line per request and `fares/passes/` a line per
    pass — and they must age out together. Two copies of this rule would mean a
    spend line whose pass had already been swept, and the `passId` that joins
    them would rot at whichever boundary came first. `what` only names the
    ledger in the log, so a sweep can be told from a sweep.
    """
    cutoff = today - timedelta(days=keep_days)
    try:
        files = sorted(directory.glob("*.jsonl"))
    except OSError as error:
        logger.error("%s could not list %s: %s", what, directory, error)
        return 0

    removed = 0
    for path in files:
        try:
            day = date.fromisoformat(path.stem)
        except ValueError:
            continue
        if day >= cutoff:
            continue
        try:
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError as error:
            logger.error("%s could not remove %s: %s", what, path, error)
            continue
        removed += 1
    if removed:
        logger.info("%s removed %d day file(s) from before %s", what, removed, cutoff.isoformat())
    return removed


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
        it has already sent. Under a ceiling, guessing low is the one guess that
        spends the asset, so `DailyBudget` reads it as "the day is gone", which
        stops the pass and reports every departure as `over-budget` — loudly, in
        the report, rather than by collecting quietly on an unknown total. With
        no ceiling there is nothing to fail closed *against*: an unreadable file
        costs the record of the day and cannot cost the day's collection, since
        no number was going to be compared to anything. `DailyBudget.spent`
        makes that split and is where it is explained.
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

    def spend(
        self,
        day: date,
        *,
        kind: str,
        what: str,
        gap: float | None = None,
        pass_id: str | None = None,
    ) -> None:
        """
        Record one request as sent.

        `kind` is `board` or `calendar` and `what` is the route and, for a
        board, its departure. Neither is read by anything here — the count is
        the whole of what a ceiling would need — and both are written because
        the day file is the only place that can answer "what did a day's
        requests go on", which is the question anybody tuning the cadence table
        or the calendar's windows will ask next. With no ceiling above it that
        is now the *whole* of this file's purpose rather than a note kept
        alongside the enforcement, and `GET /api/fares/spend` is the reader.

        **`gap` and `pass_id` are what make the pace a fact rather than an
        inference.** The gap a pass ran at was recorded nowhere, so telling a
        1.75-second population of requests from a 3.0-second one meant taking
        the modal delta between consecutive `at` values and calling that
        evidence. Written on the line, the comparison is a read. `pass_id` is
        the same identifier `fares/passes/` writes for the pass as a whole, so
        the two ledgers join without either having to grow the other's grain.

        **Both are omitted when they are not known, and every reader must cope
        with a line that has neither.** There are 952 lines already on disk
        without them, and `RequestLedger.spent` counts lines rather than parsing
        them while `fare_spend` reads `kind` through `.get` — so an old line is
        a request with an unknown pace, which is exactly what it is. Writing
        `null` instead would have been a claim about a gap of nothing.
        """
        row: dict[str, object] = {"at": _now(), "kind": kind, "what": what}
        if gap is not None:
            row["gap"] = gap
        if pass_id is not None:
            row["passId"] = pass_id
        path = self.path_for(day)
        # Read before the append rather than after, because after it is always
        # true. This is the one moment the directory grows by a file, and it is
        # therefore the moment to sweep it — see `prune`.
        opens_a_day = not path.exists()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError as error:
            # The request still left. `DailyBudget` counts it in memory whatever
            # this did, so a ledger that cannot be written costs the record of
            # the day rather than the ceiling over it.
            logger.error("fare ledger could not record a request on %s: %s", day, error)
            return
        if opens_a_day:
            self.prune(day)

    def prune(self, today: date, *, keep_days: int = SPEND_RETENTION_DAYS) -> int:
        """
        Delete the day files that are more than `keep_days` days old.

        The rule itself is `prune_day_files` above, because `fares/passes/`
        follows the same one and the two must age out together — see there for
        why it is run at a day's opening and nowhere else, and why it only
        touches files whose name parses as a date.
        """
        return prune_day_files(self.directory, today, keep_days=keep_days)


#: The files that say a pass is running, beside the ledger rather than inside
#: `spend/`, because `RequestLedger.prune` sweeps that directory and a lock is
#: not a day.
#:
#: **Two of them, because there are two slots and that is deliberate.**
#: `calendar_job` records the reason and it is not the pace: a board pass is
#: minutes long over dozens of departures and a calendar pass is two requests, so
#: one shared lock would make a route added mid-board-pass wait minutes for the
#: curve that endpoint exists to fetch immediately — and here it would not even
#: wait, it would decline. What these close is each existing slot across
#: processes; whether the two slots should become one shared *queue* is still the
#: open question `calendar_job` names, and nothing here is evidence about it.
#:
#: The hole is closed either way. What one pass must not do is plan a whole day
#: while another is planning the same day, and only the board pass ever plans a
#: whole day: a calendar pass allots one request per window per pair — about six
#: — checks what is left before each pair, and re-checks before every walk-back
#: attempt.
BOARDS_LOCK_NAME = "collect.lock"
CALENDAR_LOCK_NAME = "collect-calendar.lock"

#: How long a lock may go untouched before another pass may take it.
#:
#: The holder refreshes it before **every request it sends**, so the longest
#: silence a living pass can produce is one paced gap plus one upstream timeout:
#: `REQUEST_GAP_SECONDS` is 3 and `UPSTREAM_TIMEOUT_SECONDS` is 12, so fifteen
#: seconds. Five minutes is twenty times that.
#:
#: The alternative — age the lock against how long a whole pass may take — was
#: already bad when a ceiling bounded a pass: 600 requests times fifteen seconds
#: is two and a half hours, so a pass killed at its first request would wedge
#: the collector until mid-afternoon. With no ceiling that alternative has no
#: bound at all to be computed from, which is the second reason it is not the
#: one taken. Timing the *silence* rather than the *work* is what makes this
#: number small, and it is small because the pacing this repository already
#: keeps is what it is measured against — pacing that no longer has a count
#: standing behind it and is now the whole of the guard.
LOCK_STALE_SECONDS = 300.0


class PassLock:
    """
    The one collection pass this address is running, across every process.

    **What it protects is the pace, and it is taken around planning-plus-spending
    rather than around the append.** A lock held only over `RequestLedger.spend`
    would serialise the writes and nothing else, leaving two passes talking to
    the upstream at once — which halves `REQUEST_GAP_SECONDS` without anybody
    deciding to, and pace is what this address is actually protected by.

    It was also the thing that made a ceiling enforceable, and that is the half
    that has gone quiet: two passes would each read a day with room left, each
    plan a whole day of work against it, and each start spending before either
    could see the other. With no ceiling by default there is no day's work to
    overcommit, and this is why the lock is still taken where it is anyway — the
    span it holds is the span in which two loops could interleave, whatever the
    plan inside it was sized against.

    **There are two of these and not one** — see `BOARDS_LOCK_NAME`. The board
    pass and the calendar pass are two slots on purpose, and these close each of
    those across processes rather than merging them.

    **Failing to get it is not an error.** A cron firing while the owner presses
    Collect is the ordinary case, not a fault, so `acquire` answers `False` and
    the caller reports every departure as `another-pass-is-running` — the same
    shape, and the same place in a report, as `over-budget`. Nothing blocks and
    nothing waits: a pass is minutes long, so a second one queueing behind it
    would be a scheduled task sitting on the machine for the length of the first,
    only to run against a day the first has already spent.

    **The mechanism is an `O_EXCL` create, and it is the same one on both.**
    `fcntl.flock` does not exist on Windows, which is where this repository runs,
    and `msvcrt.locking` does not exist on Linux, which is where CI runs; either
    one means two implementations, of which the machine that matters would only
    ever exercise one. `os.open(..., O_CREAT | O_EXCL)` is a single atomic create
    on both, so the code that runs here is the code CI proves. What it gives up
    is the kernel's own liveness: a flock dies with the process that held it and
    a file does not, which is what the staleness rule below is for.

    **When there is a ceiling, the ledger and not this is what enforces it.** A
    pass that somehow ends up running beside another still re-reads the day's
    spend before every single request and still stops at `over-budget`. This is
    what makes that check arrive early enough to matter rather than after two
    passes have both committed to a day's work. With no ceiling configured that
    backstop has nothing to check and this is the only guard left standing,
    which is an argument for keeping it rather than against.
    """

    def __init__(
        self,
        path: Path | None = None,
        *,
        name: str = BOARDS_LOCK_NAME,
        stale_after: float = LOCK_STALE_SECONDS,
    ) -> None:
        self._path = path
        self._name = name
        self._stale_after = stale_after
        #: Ours while we hold it. The file names its holder, so a lock taken off
        #: us can be recognised as somebody else's before we delete it.
        self._token: str | None = None

    @property
    def path(self) -> Path:
        return self._path if self._path is not None else fares_dir() / self._name

    def held(self) -> bool:
        return self._token is not None

    def acquire(self) -> bool:
        """
        Take the lock if nobody has it, without waiting. `False` means decline.

        Three ways this ends. Nobody holds it and the create wins. Somebody holds
        it and has touched it recently, so we decline. Or the lock is stale and
        we clear it first — see `_steal` for why that cannot hand it to two
        processes at once.
        """
        if self._token is not None:
            return True

        token = uuid4().hex
        if self._claim(token):
            self._token = token
            return True

        standing = self._standing()
        if standing is None:
            # It went away between the create and the stat. Whoever released it
            # released it; one more try, and if somebody else got in first we
            # decline like anybody else.
            if self._claim(token):
                self._token = token
                return True
            return False

        holder, idle = standing
        if idle < self._stale_after:
            logger.info(
                "a collection pass is already running (%s, last seen %.0fs ago); declining",
                holder,
                idle,
            )
            return False

        logger.warning(
            "clearing a collection lock nothing has touched for %.0fs (%s)", idle, holder
        )
        if not self._steal(token):
            return False
        if self._claim(token):
            self._token = token
            return True
        return False

    def touch(self) -> None:
        """
        Say this pass is still alive. Called before every request it sends.

        It is the mtime that carries the claim, not the contents, so this is a
        `utime` rather than a rewrite — the record of who is holding it was
        written once at `acquire` and has not changed.

        A lock that is no longer ours is **not** refreshed. Our process was
        frozen long enough to look dead — a laptop suspended mid-pass is the
        realistic way — somebody took it, and touching it now would extend a
        stranger's claim and then delete it at `release`. Letting go here is
        also what makes that release safe.
        """
        if self._token is None:
            return
        if self._owner() != self._token:
            logger.warning("this pass's collection lock was taken over while it ran")
            self._token = None
            return
        try:
            os.utime(self.path, None)
        except OSError as error:
            logger.error("could not refresh the collection lock: %s", error)

    def release(self) -> None:
        """
        Give the lock up, and only if it is still ours to give.

        The token is checked first, so a pass whose lock was cleared under it
        cannot delete the lock of the pass that took over.
        """
        token, self._token = self._token, None
        if token is None:
            return
        if self._owner() != token:
            logger.warning("the collection lock was no longer ours to release")
            return
        try:
            self.path.unlink(missing_ok=True)
        except OSError as error:
            logger.error("could not release the collection lock: %s", error)

    # ------------------------------------------------------------ internals --

    def _claim(self, token: str) -> bool:
        """One atomic create, and the record of who won it."""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            return False
        except OSError as error:
            # Fail closed, like an unreadable ledger and for the same reason: a
            # process that cannot show it is alone must not assume it is.
            logger.error("could not take the collection lock at %s: %s", self.path, error)
            return False
        record = {
            "token": token,
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "since": _now(),
        }
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False))
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as error:
            logger.error("could not write the collection lock at %s: %s", self.path, error)
            # An empty lock file left behind would read as held-by-nobody until
            # it went stale, which is five minutes of a collector that cannot
            # start. We made it, so we take it away.
            with _ignoring_oserror():
                self.path.unlink(missing_ok=True)
            return False
        return True

    def _standing(self) -> tuple[str, float] | None:
        """Who holds the lock and how long since anything touched it."""
        try:
            stamp = self.path.stat().st_mtime
        except OSError:
            return None
        try:
            record = json.loads(self.path.read_text(encoding="utf-8"))
            holder = f"pid {record['pid']} on {record['host']} since {record['since']}"
        except (OSError, ValueError, KeyError, TypeError):
            # A lock created a microsecond ago and not yet written is empty, and
            # so is one whose writer died between the two. Neither is a reason to
            # treat it as free: the mtime is what decides that, and an
            # unreadable lock is a held one until it goes stale like any other.
            holder = "unreadable"
        return holder, max(0.0, time.time() - stamp)

    def _steal(self, token: str) -> bool:
        """
        Take a stale lock away, in a way that cannot happen twice.

        **The clearing is a rename, not a delete, and that is the whole of why
        it is not itself a race.** "See that it is stale, then unlink it" lets
        two processes both see it, both unlink — the second one unlinking the
        lock the first has already replaced — and both believe they are alone.
        `os.replace` moves the file to a name only this call knows, and a file
        can only be moved away once: whoever loses finds no source and declines.
        The winner does not even inherit the lock, it only earns the right to try
        the ordinary `O_EXCL` create, which is still the one arbiter — a third
        process that slipped in between simply wins it instead, and the stealer
        declines.

        The stolen file is kept just long enough to be moved and then removed.
        Its contents are already in the log line that decided to clear it.
        """
        casualty = self.path.with_name(f"{self.path.name}.{token}.cleared")
        try:
            os.replace(self.path, casualty)
        except OSError:
            # Somebody else cleared it first, or — on Windows — still has it
            # open. Both mean this process is not the one that gets it.
            return False
        with _ignoring_oserror():
            casualty.unlink(missing_ok=True)
        return True

    def _owner(self) -> str | None:
        try:
            record = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        token = record.get("token") if isinstance(record, dict) else None
        return token if isinstance(token, str) else None


@dataclass
class DailyBudget:
    """
    What today has cost so far, and — if a ceiling was configured — what is left.

    Mutable, unlike nearly everything else in the collector, because it is the
    thing that changes while a pass runs — `CollectionPass` is the precedent and
    the reason is the same.

    **`ceiling` is `None` by default and that means unbounded, not exhausted.**
    Everything a pass asks this object is asked through `affords`, which answers
    `True` for every cost when there is no ceiling, so no call site has to hold
    the distinction in its head — see that method for why the arithmetic is not
    left to callers. `remaining` keeps the `None` visible for the one caller
    that genuinely needs it, `due_now`, whose `budget` parameter has always read
    `None` as "do not truncate".

    **The day is fixed when this is built and does not move.** A pass that
    starts at 23:58 keeps spending against the day it started in. Re-deriving
    the date per request would hand a running pass a fresh ceiling halfway
    through, which is the same hole as reading the budget once per pass, just
    with a rarer trigger. Unchanged by the ceiling going away: the day still
    names the ledger file being appended to, and a pass that wandered onto
    tomorrow's file at midnight would split one pass's record across two days.
    """

    ledger: RequestLedger
    ceiling: int | None
    day: date
    #: What this object has watched leave the address, whatever the file did
    #: with it. Starts at nothing and is outranked by the file until the pass
    #: overtakes it, which is what makes a failed append cost the record of a
    #: request rather than the request itself.
    witnessed: int = field(default=0)
    #: The pass lock this allowance is being spent under, if the caller took
    #: one. Held here rather than threaded through the collector because the
    #: moments a pass must prove it is alive are exactly the moments it spends,
    #: and `take` is already the one place both passes call — the calendar's
    #: walk-back reaches it four functions down without a parameter of its own.
    lock: "PassLock | None" = field(default=None)
    #: The pace this pass is sending at, written onto every line it records.
    #: Carried here rather than threaded through the collector for the same
    #: reason the lock is: `take` is the one place both passes spend, and the
    #: calendar's walk-back reaches it four functions down without a parameter
    #: of its own. `None` for a caller that built a budget with no pass around
    #: it, and the line is written without the field rather than with a null.
    gap: float | None = field(default=None)
    #: The identifier of the pass these requests belong to, minted by whoever
    #: started it, and the join to `fares/passes/`. `None` for the same reason.
    pass_id: str | None = field(default=None)

    def spent(self) -> int:
        """
        Today's total: the file's count, or ours, whichever is further on.

        **An unreadable ledger answers the ceiling, which is how the pass fails
        closed** — a day whose spend cannot be established is treated as fully
        spent, because guessing low is the guess that spends the asset.

        With no ceiling there is nothing to fail closed against and the answer
        is what this pass has watched leave. That is not a weakening of the old
        rule: the rule existed so an unknown total could not be compared
        favourably against a ceiling, and where no comparison is made, reporting
        an unknown day as fully spent would stop a collector for a reason that
        no longer exists — it would be the ledger's own writability deciding
        whether fares get collected, which it was never meant to be.
        """
        recorded = self.ledger.spent(self.day)
        if recorded is None:
            return self.ceiling if self.ceiling is not None else self.witnessed
        return max(recorded, self.witnessed)

    def remaining(self) -> int | None:
        """
        What a pass may still spend today, or `None` when nothing bounds it.

        `None` is not zero and the type is deliberate: this is handed straight
        to `due_now`'s `budget`, which has always read `None` as "do not
        truncate", so an unbounded day arrives there as the absence of a cap
        rather than as a very large one. Anything comparing this to a number
        wants `affords` instead.
        """
        if self.ceiling is None:
            return None
        return max(0, self.ceiling - self.spent())

    def affords(self, cost: int = 1) -> bool:
        """
        Whether `cost` more requests can be sent today.

        **The one question every spending site asks, so that none of them has to
        do the `None` arithmetic.** `remaining() <= 0` was the old test and it
        is exactly the shape that breaks on an unbounded day — in Python
        `None <= 0` raises, which is the good failure, but the shape that
        silently substitutes a large sentinel is the bad one and this is what
        makes it unnecessary. With no ceiling every cost is affordable and the
        answer does not even read the ledger.
        """
        left = self.remaining()
        return True if left is None else left >= cost

    def take(self, *, kind: str, what: str) -> None:
        """Spend one request, before it is sent."""
        self.witnessed = self.spent() + 1
        self.ledger.spend(self.day, kind=kind, what=what, gap=self.gap, pass_id=self.pass_id)
        if self.lock is not None:
            self.lock.touch()


#: The one ledger this process writes, beside `HISTORY` and `CALENDAR` and for
#: the same reason: there is one address, so there is one day's spend.
LEDGER = RequestLedger()


def daily_budget(
    *,
    ceiling: int | None = None,
    ledger: RequestLedger | None = None,
    now: datetime | None = None,
    lock: PassLock | None = None,
    gap: float | None = None,
    pass_id: str | None = None,
) -> DailyBudget:
    """
    Today's allowance, read off disk rather than started at zero.

    `ceiling=None` means "whatever is configured", which is itself `None` — no
    ceiling — unless an environment sets a number. The two `None`s collapsing
    into one is deliberate rather than tolerated: there is no caller that wants
    to force an unbounded day while the environment asks for a bounded one, and
    inventing a second sentinel to express that would put a word in every
    signature to serve nobody. A caller with a ceiling in hand passes the number.

    `gap` and `pass_id` are what the pass sending against this allowance will
    write onto every line it records. Both default to `None`, which writes the
    field away rather than as a null — a budget built with no pass around it
    genuinely does not know either, and 952 lines already on disk say the same.
    """
    moment = now if now is not None else datetime.now(UTC)
    day = (moment.astimezone(UTC) if moment.tzinfo is not None else moment).date()
    return DailyBudget(
        ledger=ledger if ledger is not None else LEDGER,
        ceiling=ceiling if ceiling is not None else daily_request_budget(),
        day=day,
        lock=lock,
        gap=gap,
        pass_id=pass_id,
    )
