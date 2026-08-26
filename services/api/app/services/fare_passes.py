"""
One line per pass, especially the passes that sent nothing.

**What was missing, measured.** Of 105 scheduled firings, 6 sent a request and
99 did not — and until this file existed a pass that sent nothing wrote nothing
at all, so 94% of the collector's behaviour left no trace anywhere. The spend
ledger beside this one is a line per *request*, which is exactly the wrong grain
for the question: a day where the schedule fired ninety-six times and a day
where it fired twice look identical in it, because on a quiet watchlist both
days spend nothing.

**The fallback that was supposed to cover this does not exist on this machine.**
`scripts/fares-collect.py` reasoned that a non-zero exit is what makes a silent
scheduled task visible, "because Task Scheduler records the code". Its operational
log is disabled here — checked rather than assumed — so the exit code was being
written to nowhere. `exit` on the line below is that code, kept where something
reads it.

**Three fields carry the weight, and none of them is decoration.**

`gap` is the pace the pass ran at. It was nowhere on disk, so separating a
1.75-second population from a 3.0-second one meant reconstructing the modal
delta between request timestamps and calling it evidence. It is written here and
on every spend line the pass produces, which turns that reconstruction into a
`grep`.

`wallMs` is how long the pass took, and it is the only instrument for a failure
that currently has no symptom at all. The scheduled task is
`MultipleInstances = IgnoreNew` firing every fifteen minutes, so a pass that runs
longer than fifteen minutes causes the next one to be **discarded silently** —
no error, no log, no missing data that looks like anything but a quiet market.
The longest pass observed is 4m38s; at a 3.0s gap a full watchlist pass is about
9.8 minutes, and a near month — 31 boards at 3s each on top of that — would
overrun. Nothing on this machine would say so. A column of durations would.

`passId` is the join. A pass line says a pass sent eleven requests; the eleven
spend lines carrying the same id say what they were. Neither ledger has to grow
the other's grain to answer a question about both.

**Where the lines come from, and why it is the two ends rather than the
collector.** `collect_due` and `collect_calendars` are *loops*, and the thing
that has to fit inside fifteen minutes is the **invocation**: the scheduled
command runs boards and then the horizon in one process, and its wall time is
the sum plus whatever the process itself costs. So the writers are the two
things that own a pass from beginning to end — `scripts/fares-collect.py` and
the two runners behind the page — and `source` says which of them wrote it.
That also keeps the collector free of this module, which is what stops the
import graph looping back on itself.

**Retention is the spend ledger's, deliberately reused rather than re-decided.**
Ninety days, the same constant, swept by the same function at the same moment —
see `prune_day_files`. Two different numbers would mean spend lines whose pass
had already been swept, and the join above would rot at whichever boundary came
first. The volume is not the argument either way: about 96 lines and 15 KB a
day.
"""

import json
import logging
import secrets
import time
from collections import Counter
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from app.config import SPEND_RETENTION_DAYS, fares_dir
from app.services.fare_budget import prune_day_files

if TYPE_CHECKING:  # annotations only — see the module docstring on the import graph
    from app.services.fare_collector import CalendarReport, CollectionReport

logger = logging.getLogger(__name__)

#: How long a pass id is, in hex characters. Twelve is 48 bits: a day of
#: ninety-six passes has a collision chance of about one in 10^11, and the id
#: costs 26 bytes on a spend line that was 60 — a fifth of the file, which is
#: the price of being able to ask which pass sent a request at all.
PASS_ID_CHARS = 12

#: The reason that means "this was due and the day would not pay for it". Every
#: other skip is the pass deciding there was nothing to ask for; this one is the
#: pass wanting to ask and being stopped, which is why `due` counts it.
OVER_BUDGET = "over-budget"

#: The same fact about a different ceiling: due, and the *window* would not pay
#: for it. A scheduled pass that reaches `SCHEDULER_INTERVAL_MINUTES` stops and
#: names the rest, rather than running on and costing the next firing.
WINDOW_FULL = "pass-window-full"

#: The skips that mean "wanted and refused", which is what `due` counts.
#:
#: A tuple rather than two `.count()` calls so that the next ceiling — if there
#: is one — is added in one place and cannot be added to the constant list
#: while being forgotten in the arithmetic. The reason vocabulary itself stays
#: open by design: nothing downstream has to learn a word to render it.
WANTED_AND_REFUSED = (OVER_BUDGET, WINDOW_FULL)


def new_pass_id() -> str:
    """A short identifier for one pass, minted by whoever starts it."""
    return secrets.token_hex(PASS_ID_CHARS // 2)


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


class PassTally:
    """
    What one pass did, accumulated across however many loops it ran.

    Mutable, like `CollectionPass` and `DailyBudget` and for the same reason:
    it is the thing that changes while the pass runs. A scheduled invocation
    adds a board report and then a calendar one; a press adds exactly one.

    **The two loops count different units and are added anyway.** Boards are
    departures and the horizon is city pairs, so `due` mixes them — and `sent`
    is what reconciles the line, because it counts *requests*, which is what the
    day's ledger counts and what this address is actually judged on. A pass line
    where `sent` is 5 has five spend lines carrying its id, whatever the work
    was called.
    """

    def __init__(self) -> None:
        #: Units this pass judged due: polled, or wanted and refused by the day.
        self.due = 0
        #: Requests that actually left. The join with the spend ledger.
        self.sent = 0
        #: Units that came back an error. A refusal is not a skip.
        self.failed = 0
        #: Reasons for everything not polled, counted. Only the reasons that
        #: happened: the collector's vocabulary is open (`unreadable-month`,
        #: `departed`, `past-horizon`, `another-pass-is-running`, …) and a
        #: writer padding a fixed three of them would be claiming a closed set
        #: that does not exist. `fare_spend` makes the same argument about
        #: `kind` — what the ledger holds is whatever was written on the day.
        self.skipped: Counter[str] = Counter()

    def boards(self, report: "CollectionReport") -> None:
        """
        Fold in one board pass. One request per departure looked at.

        `due` counts what the pass *wanted*, so the reasons that mean "wanted
        and refused" count towards it while the ones that mean "not wanted yet"
        do not. `over-budget` was the only one of the first kind;
        `pass-window-full` is the second, and it is the same fact about a
        different ceiling — a departure this pass meant to poll and ran out of
        room for. Counting it as not-due would make an overrunning pass look
        like a quiet one, which is the whole failure this ledger exists to make
        visible.
        """
        reasons = [reason for _, reason in report.skipped]
        self.skipped.update(reasons)
        self.due += len(report.results) + sum(reasons.count(r) for r in WANTED_AND_REFUSED)
        self.sent += len(report.results)
        self.failed += report.failed

    def calendars(self, report: "CalendarReport") -> None:
        """
        Fold in one horizon pass. **Requests, not looks** — the two differ here.

        A pair is two windows, and a refused far end is walked back and asked
        for again (12.245), so one pair measured 2.43 requests. `report.requests`
        is what was sent and is what the spend ledger will agree with.
        """
        reasons = [reason for _, reason in report.skipped]
        self.skipped.update(reasons)
        self.due += len(report.results) + reasons.count(OVER_BUDGET)
        self.sent += report.requests
        self.failed += report.failed


class PassLedger:
    """
    Every pass this address ran, one line per pass, per day.

    Append-only and one file per day, the same shape as the spend ledger and the
    archive and for the same reasons: appending touches nothing already written,
    and a crash mid-write can cost the last line and nothing before it.
    """

    def __init__(self, directory: Path | None = None) -> None:
        self._dir = directory

    @property
    def directory(self) -> Path:
        return self._dir if self._dir is not None else fares_dir() / "passes"

    def path_for(self, day: date) -> Path:
        return self.directory / f"{day.isoformat()}.jsonl"

    def append(self, row: dict, *, day: date) -> None:
        """
        Record one finished pass.

        **A failure here is logged and swallowed**, exactly as it is in
        `RequestLedger.spend`, and the argument is stronger rather than weaker:
        this file records passes and does not affect them, so a ledger that
        cannot be written must cost the record and never the collection. An
        instrument that can end a pass is a new way for the collector to fail.
        """
        path = self.path_for(day)
        # Read before the append rather than after, because after it is always
        # true. This is the one moment the directory grows by a file, and it is
        # therefore the moment to sweep it.
        opens_a_day = not path.exists()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError as error:
            logger.error("fare pass ledger could not record a pass on %s: %s", day, error)
            return
        if opens_a_day:
            self.prune(day)

    def prune(self, today: date, *, keep_days: int = SPEND_RETENTION_DAYS) -> int:
        """
        Delete the day files that are more than `keep_days` days old.

        The spend ledger's sweep, called on this directory — same rule, same
        moment, same swallowed failure. See `prune_day_files`.
        """
        return prune_day_files(self.directory, today, keep_days=keep_days, what="fare pass ledger")


#: The one pass ledger this process writes, beside `LEDGER` and `HISTORY` and
#: for the same reason: there is one address, so there is one record of what it
#: ran.
PASSES = PassLedger()


class PassRecorder:
    """
    A pass being timed, from the moment it starts to the line it leaves.

    Held by whoever owns the whole pass — the command line, or one of the two
    runners — because that is the only vantage point from which `wallMs` means
    what it has to mean. Built at the start so `at` is the *start* instant: the
    question the file exists to answer is whether firings are fifteen minutes
    apart, which is a question about when passes begin, and an end timestamp
    would fold the drift and the duration into one number and lose both. It also
    fixes which day file a pass belongs to, so one that starts at 23:59 is never
    split across two of them.

    `clock` is monotonic and separate from `now` on purpose: a wall clock that
    steps — an NTP correction, a daylight change — would make a pass look
    negative or hours long, and the one number here that a scheduler decision
    would hang on is the duration.
    """

    def __init__(
        self,
        *,
        source: str,
        kind: str,
        gap: float,
        pass_id: str | None = None,
        ledger: PassLedger | None = None,
        now: datetime | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        #: `cron` for the scheduled command line, `ui` for a press on the page.
        #: A human running the command by hand is recorded as `cron` too: what
        #: the line can honestly say is which code path ran, not who asked.
        self.source = source
        #: `board`, `calendar`, or `board+calendar` for the invocation that runs
        #: both. Known before the pass starts in every case, because it is a
        #: property of what was invoked rather than of what it found.
        self.kind = kind
        self.gap = gap
        self.pass_id = pass_id if pass_id is not None else new_pass_id()
        self.tally = PassTally()
        self._ledger = ledger if ledger is not None else PASSES
        self._clock = clock if clock is not None else time.monotonic
        self._started = now if now is not None else datetime.now(UTC)
        self._began = self._clock()

    def finish(self, *, exit_code: int) -> None:
        """
        Write the line.

        `exit_code` is the process's own code from the command line, and the
        same 0-or-1 for a pass that has no process — a runner's task that raised
        writes 1. One field answers "did this end badly" whichever origin wrote
        it, which is what makes a day's lines comparable at all.
        """
        started = self._started.astimezone(UTC)
        row = {
            "at": started.replace(microsecond=0).isoformat(),
            "passId": self.pass_id,
            "source": self.source,
            "kind": self.kind,
            "gap": self.gap,
            "due": self.tally.due,
            "sent": self.tally.sent,
            # Sorted so two days' files diff against each other rather than
            # against the order reasons happened to arrive in.
            "skipped": dict(sorted(self.tally.skipped.items())),
            "failed": self.tally.failed,
            "wallMs": round((self._clock() - self._began) * 1000),
            "exit": exit_code,
        }
        self._ledger.append(row, day=started.date())
