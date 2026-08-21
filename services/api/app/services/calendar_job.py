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

**Both halves of that survive the cross-process lock, deliberately.**
`collect_calendars` takes `collect-calendar.lock` and the boards take
`collect.lock`, so what became true is that a *second calendar pass* — a
scheduled command firing while this runner is mid-curve — declines instead of
running. Two slots stay two slots. Merging them into one lock was rejected here
rather than quietly: it would have made a route added mid-board-pass go without
its curve entirely, since a lock declines rather than queues, which is worse than
the case this paragraph already rejected.
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
from app.services.pass_stream import CALENDAR_STREAM

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

    **This used to say it had no halfway point, and that was wrong.** The
    argument was that a calendar pass is one city pair and two requests, so
    there was nothing between the start and the end worth reporting. Measured
    against the live provider on 2026-08-21 a pass took **three requests and
    twenty seconds** — two windows three seconds apart, one of them refused and
    asked for again with a nearer end (12.245). Twenty seconds is not an
    instant, and for the whole of it the row that started the pass showed one
    unchanging sentence, which is indistinguishable from a control that did
    nothing. The observer is `CalendarObserver` rather than `PassObserver`
    because what moves here is windows and requests, not departures.
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
    #: How many date windows this pass means to price. `None` until the plan is
    #: settled, which is a different thing from zero — zero is every pair
    #: collected inside its cadence, and a bar drawn at zero for the other one
    #: would be claiming a denominator nobody has yet.
    windows: int | None = None
    #: Windows that have come back. The numerator for `windows`. Named in full
    #: rather than `priced`, which is the observer method's name and would have
    #: shadowed this field with a function the moment the dataclass was built.
    windows_priced: int = 0
    #: Upstream requests sent so far. Deliberately not equal to `priced`: a
    #: refused far end is walked back and asked for again, so this is what the
    #: pass is spending where the other is what it is achieving.
    requests: int = 0
    #: Departure dates priced so far, across every window that has landed.
    dates: int = 0
    results: list[CalendarResult] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    #: Set only when `state` is `failed` — the pass itself fell over, as
    #: distinct from a provider refusing a route inside it. A refused route
    #: travels in `results` with its reason, the same as it always has.
    error: str | None = None

    @property
    def completed(self) -> int:
        return len(self.results)

    # `planned`, `requested` and `priced` are `CalendarObserver`. Spelled out on
    # the pass itself rather than on a separate adapter, exactly as
    # `CollectionPass` does it and for the same reason: the pass is the only
    # thing that wants them and an adapter would exist purely to forward.

    def planned(self, *, windows: int, skipped: list[tuple[str, str]]) -> None:
        self.windows = windows
        self.skipped = skipped
        # Worth a frame of its own. Until the denominator lands a bar can only
        # say "moving, length unknown", and on a pass where nothing was due this
        # is also the moment the reader learns there is nothing to wait for.
        CALENDAR_STREAM.publish()

    def requested(self) -> None:
        self.requests += 1
        # The one frame that arrives *before* a wait rather than after it. A
        # request takes seconds and those seconds are what the reader is sitting
        # through; this is what makes a retry visible as work rather than as a
        # pause.
        CALENDAR_STREAM.publish()

    def priced(self, *, dates: int) -> None:
        self.windows_priced += 1
        self.dates += dates
        CALENDAR_STREAM.publish()

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
        CALENDAR_STREAM.publish()
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
                watches,
                provider=provider,
                client=client,
                every_minutes=every_minutes,
                observer=started,
            )
        except asyncio.CancelledError:
            started.state = "failed"
            started.error = "The pass was cancelled before it finished"
            started.finished_at = _now()
            # Before the re-raise: cancellation is what shutdown does, and a
            # listener told nothing would hold a `running` document for a pass
            # that will never move again.
            CALENDAR_STREAM.publish()
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
            # The results are still filled in at the end, and that is not the
            # same claim the observer above disproves. What moves during a pass
            # is windows and requests, and those are pushed as they happen; a
            # `CalendarResult` is the summary of a whole city pair and does not
            # exist until that pair is done. `collect_calendars` returns them
            # together because there is nothing to be gained by handing over a
            # summary one pair at a time when a pass is usually one pair.
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
        # Both endings, in one place after the branch. The frames in between are
        # the observer's; this is the one that says the pass has stopped, which
        # is what the two-second poll it replaced was ever asking about.
        CALENDAR_STREAM.publish()

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
