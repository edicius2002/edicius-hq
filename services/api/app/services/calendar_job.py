"""
The one calendar pass that may be running, and what it has come back with.

**Why this exists at all.** A city pair added to the watchlist has no curve, and
until one is collected the eleven months the reader did not pick are simply
blank — the calendar chart has nothing to draw and cannot say whether that is
because the year is empty or because nobody has looked. The only thing that has
ever filled that gap is `scripts/fares-collect.py`, a command line the owner
runs on a timer, so the honest answer to "when will the curve appear" was "at
whatever minute the scheduled task next fires". This is the HTTP way to ask for
one pair's curve now, so the press that adds a route can also start collecting
it.

**It does not make the browser wait, and the reason is not politeness.** A curve
is two paced requests per pair, which is a few seconds when the upstream is
answering and is unbounded when it is not. Holding the request open would put a
`fetch` deadline in charge of whether a curve gets stored — the same mistake the
board collection already had to undo, where a five-minute client timeout was
what decided how many departures a press could cover. A pass that runs on the
server's own task and is asked about afterwards has no deadline to fit inside.

**One pass at a time, and that is a feature.** `REQUEST_GAP_SECONDS` in
`fare_collector` is the only thing pacing this repository against an unmetered
upstream, and it paces one loop. Two calendar passes at once would halve it
without anybody deciding to, so a press that arrives while a pass is running is
answered with the running pass rather than starting a second one — the same rule
`CollectionRunner` enforces, for the same reason.

**Two slots, and the pace can still be doubled across them — named here rather
than fixed here.** This runner is separate from `CollectionRunner`, so a
calendar pass and a board pass can genuinely overlap and the upstream can see
two paced loops at once. The alternative was one slot shared by both, and it was
rejected on what it would cost the reader: a board pass is minutes long over
dozens of departures, a calendar pass is two requests, and sharing a slot would
mean a route added mid-board-pass waits minutes for the curve this endpoint
exists to fetch immediately. A shared *queue* rather than a shared slot would
serve both, and that is the shape to build if the doubled pace ever shows up as
a refusal; nothing measured so far says it has.
"""

import asyncio
import contextlib
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx

from app.adapters.fares.registry import DEFAULT_PROVIDER
from app.config import CALENDAR_POLL_MINUTES
from app.services.fare_collector import (
    CalendarReport,
    CalendarResult,
    FareWatch,
    collect_calendars,
)

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


@dataclass
class CalendarPass:
    """
    One calendar pass, from the press that started it to the report it ends as.

    Mutable, unlike everything else in the collector, and deliberately so: this
    is the thing that changes while the pass runs. `CalendarReport` stays frozen
    and is what this becomes at the end, so nothing downstream of a finished
    pass has to know a mutable version ever existed.

    There is no progress observer here, unlike `CollectionPass`. A board pass is
    dozens of departures and a reader watching it wants to see it move; a
    calendar pass is two requests for one city pair, so the only two states
    worth reporting are the two it already has. Wiring an observer through
    `collect_calendars` for a denominator that is always one would be machinery
    in exchange for nothing.
    """

    started_at: str
    source: str
    #: What this pass covers, as `"LIM-SCL"`. A press for a pair that is not in
    #: here was answered with somebody else's pass and the caller needs to be
    #: able to tell.
    watching: list[str]
    #: `running`, `finished` or `failed`.
    state: str = "running"
    finished_at: str | None = None
    results: list[CalendarResult] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    #: Set only when `state` is `failed` — the pass itself fell over, as
    #: distinct from a provider refusing a route inside it. A refused route
    #: travels in `results` with its reason, the same as it always has.
    error: str | None = None

    @property
    def completed(self) -> int:
        return len(self.results)

    def as_report(self) -> CalendarReport:
        return CalendarReport(
            started_at=self.started_at,
            finished_at=self.finished_at or _now(),
            source=self.source,
            results=list(self.results),
            skipped=list(self.skipped),
        )


def _watching(watches: list[FareWatch]) -> list[str]:
    """
    The city pairs this pass covers, each named once, in the order given.

    Deduplicated because `collect_calendars` is keyed by city pair and not by
    watch — a curve covers every month at once, so two watched months on one
    pair are one collection. Saying `LIM-CUZ` twice would promise a caller two
    results it is never going to get. `dict.fromkeys` rather than a set so the
    order a watchlist was written in survives, which is what makes two passes
    comparable by eye.
    """
    return list(dict.fromkeys(f"{watch.origin}-{watch.destination}" for watch in watches))


class CalendarRunner:
    """
    The single slot a calendar pass runs in.

    Module-level state, like `CALENDAR` and the shared upstream client, and for
    the same reason: there is one process, one address talking to the upstream,
    and one pace to keep. A per-request object would let the pace be kept twice.
    """

    def __init__(self) -> None:
        self._pass: CalendarPass | None = None
        # Held so the loop does not drop the only reference to a running task
        # and collect it mid-pass. `asyncio` documents this and it is otherwise
        # a bug that only appears under load.
        self._task: asyncio.Task[None] | None = None

    def current(self) -> CalendarPass | None:
        """The pass that is running, or the last one that ran. `None` if never."""
        return self._pass

    def running(self) -> bool:
        return self._pass is not None and self._pass.state == "running"

    def forget(self) -> None:
        """
        Drop the last pass, so the runner is idle again.

        For tests, and named for what it does rather than `reset`: one slot
        outlives every request in the process, so a test that asserts on the
        idle state would otherwise pass or fail according to which test ran
        before it. Nothing in the app calls this — a finished pass is replaced
        by the next press, not cleared between them.
        """
        self._pass = None
        self._task = None

    def start(
        self,
        watches: list[FareWatch],
        *,
        provider: str = DEFAULT_PROVIDER,
        client: httpx.AsyncClient | None = None,
        every_minutes: int = CALENDAR_POLL_MINUTES,
    ) -> CalendarPass:
        """
        Begin a pass, or hand back the one already going.

        Returns which of those happened by way of `watching`: a caller whose
        city pair is missing from it was answered rather than served, and the
        control that pressed can say so.

        `every_minutes` is the cadence the store measures staleness against, and
        it is a parameter rather than the constant because the caller can know
        something the store's clock cannot: whether there is anything on disk at
        all. See the endpoint for what it does with that.
        """
        if self.running():
            assert self._pass is not None
            return self._pass

        started = CalendarPass(started_at=_now(), source=provider, watching=_watching(watches))
        self._pass = started
        self._task = asyncio.get_running_loop().create_task(
            self._run(started, watches, provider, client, every_minutes)
        )
        return started

    async def _run(
        self,
        started: CalendarPass,
        watches: list[FareWatch],
        provider: str,
        client: httpx.AsyncClient | None,
        every_minutes: int = CALENDAR_POLL_MINUTES,
    ) -> None:
        try:
            report = await collect_calendars(
                watches, provider=provider, client=client, every_minutes=every_minutes
            )
        except asyncio.CancelledError:
            started.state = "failed"
            started.error = "The pass was cancelled before it finished"
            started.finished_at = _now()
            raise
        except Exception as error:  # a dead task is a silent one
            # The alternative is a task that raises into the event loop's
            # default handler, where the browser polling for progress sees a
            # pass that is running forever. A failure that is not reported is
            # worse than one that is.
            logger.exception("fare calendar pass failed")
            started.state = "failed"
            started.error = f"{type(error).__name__}: {error}"
            started.finished_at = _now()
        else:
            # Filled in at the end rather than as they arrive, because unlike a
            # board pass there is nothing in between to watch: `collect_calendars`
            # returns a whole report and a pass over one city pair has no
            # halfway point a reader could act on.
            started.results = list(report.results)
            started.skipped = list(report.skipped)
            started.state = "finished"
            started.finished_at = _now()
            logger.info(
                "calendar pass finished: %d collected, %d refused, %d skipped",
                report.collected,
                report.failed,
                len(report.skipped),
            )

    async def aclose(self) -> None:
        """
        Stop a pass at shutdown, before the shared client under it is closed.

        Ordering matters: closing the client first would have the pass fail on
        a socket that went away rather than on being asked to stop, and the two
        read very differently in a log.
        """
        task = self._task
        self._task = None
        if task is None or task.done():
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


CALENDAR_RUNNER = CalendarRunner()
