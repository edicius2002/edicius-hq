"""
The one collection pass that may be running, and how far through it is.

**Why this exists at all — 12.210.** A collection pass is minutes long and
`POST /api/fares/collect` used to hold the browser open for the whole of it.
That put a five-minute client deadline in charge of how much of a watchlist a
press could cover: `MAX_COLLECT_REQUESTS` was forty because forty paced
requests fitted inside five minutes, not because forty was the right amount of
work. The owner's two watched months expand to sixty-two departures, so a full
manual refresh did not fit in one press and never could — it took two, with a
human in between, and the human had to know that.

Nothing about the upstream had to change to fix that. A pass that runs on the
server's own task and is asked about afterwards has no deadline to fit inside,
so the cap can simply go and the pass can cover the whole watchlist at the same
pace it always ran at.

**One pass at a time, and that is a feature.** The gap in `fare_collector` is
the only thing pacing this repository against an unmetered upstream, and it
paces one loop. Two passes running at once would halve it without anybody
deciding to, which is precisely the accident the gap exists to prevent — so a
press that arrives while a pass is running is answered with the running pass
rather than starting a second one. That was already the honest behaviour and
was previously not enforced anywhere: two rows pressed together really did run
two loops.

**This slot is one process's, and the other half is a file.** A scheduled
command is a second process and this object cannot see it, so the runner alone
would have answered a press with the running pass while a cron three seconds
later started a second loop anyway. `PassLock` in `fare_budget` is the same rule
written where both processes can read it, and `collect_due` takes it before it
plans. Nothing here changes: a press that loses that lock still gets a pass
back, still finishes, and reports every departure as `another-pass-is-running`
rather than raising.

**A pass that is still running still says what it is doing.** `planned` lands
before the first request, so the progress document knows its own denominator
from the start; every result is added as it arrives. A reader watching a
four-minute pass sees it move rather than seeing a spinner and a promise.

**And it says it out loud, rather than waiting to be asked** —
`a-pass-is-pushed-not-polled`. Every one of those moments is announced on
`COLLECTION_STREAM` as well as recorded here, so `GET /collect/stream` can push
it. The recording stays: the stream is how a watcher hears about a change, and
this is still what the change *is*, so a tab that connects halfway through a
pass reads the document rather than the events it missed. Announcing is a flag
set on each listener and never blocks — these methods run inside the collector's
own loop, between an upstream request and the next paced wait, and anything that
awaited there would be pacing the provider by accident.
"""

import asyncio
import contextlib
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx

from app.adapters.fares.models import FareSnapshot
from app.adapters.fares.registry import DEFAULT_PROVIDER
from app.services.fare_collector import (
    CollectionReport,
    FareWatch,
    RouteResult,
    collect_due,
)
from app.services.pass_stream import COLLECTION_STREAM

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


@dataclass
class CollectionPass:
    """
    One pass, from the press that started it to the report it ends as.

    Mutable, unlike everything else in the collector, and deliberately so: this
    is the thing that changes while the pass runs. `CollectionReport` stays
    frozen and is what this becomes at the end, so nothing downstream of a
    finished pass has to know a mutable version ever existed.
    """

    started_at: str
    source: str
    #: What this pass covers, as `"ARI-SCL 2027-03"`. A press for a route that
    #: is not in here was answered with somebody else's pass and the caller
    #: needs to be able to tell.
    watching: list[str]
    #: `running`, `finished` or `failed`.
    state: str = "running"
    finished_at: str | None = None
    #: How many departures this pass means to poll. `None` until the plan is
    #: settled, which is a different thing from zero and reads differently on a
    #: progress bar.
    polling: int | None = None
    results: list[RouteResult] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    #: Set only when `state` is `failed` — the pass itself fell over, as
    #: distinct from a route inside it being refused. A refused route travels
    #: in `results` with its reason, the same as it always has (8.8, 8.41).
    error: str | None = None

    @property
    def completed(self) -> int:
        return len(self.results)

    # `planned` and `collected` are `PassObserver`. Spelled out on the pass
    # itself rather than on a separate adapter class because the pass is the
    # only thing that wants them and an adapter would exist purely to forward.

    def planned(self, *, polling: int, skipped: list[tuple[str, str]]) -> None:
        self.polling = polling
        self.skipped = skipped
        # The denominator arriving is worth a frame of its own: until it lands
        # the bar can only say "moving, length unknown" (`passProgress`), and on
        # a pass where nothing was due it is also the moment the reader learns
        # there is nothing to wait for.
        COLLECTION_STREAM.publish()

    def collected(self, result: RouteResult, snapshot: FareSnapshot | None = None) -> None:
        self.results.append(result)
        # Order matters, and only in one direction. The snapshot goes out first
        # so that a client which draws the point and then re-reads the document
        # can never see a completed count that its chart has not caught up with;
        # both ride the same flush anyway, and this is what makes that true even
        # if they ever stop doing so.
        if snapshot is not None:
            COLLECTION_STREAM.write(snapshot)
        COLLECTION_STREAM.publish()

    def as_report(self) -> CollectionReport:
        return CollectionReport(
            started_at=self.started_at,
            finished_at=self.finished_at or _now(),
            source=self.source,
            results=list(self.results),
            skipped=list(self.skipped),
        )


def _watching(watches: list[FareWatch]) -> list[str]:
    return [f"{watch.route} {watch.month}" for watch in watches]


class CollectionRunner:
    """
    The single slot a manual pass runs in.

    Module-level state, like `HISTORY` and the shared upstream client, and for
    the same reason: there is one process, one address talking to the upstream,
    and one pace to keep. A per-request object would let the pace be kept twice.
    """

    def __init__(self) -> None:
        self._pass: CollectionPass | None = None
        # Held so the loop does not drop the only reference to a running task
        # and collect it mid-pass. `asyncio` documents this and it is otherwise
        # a bug that only appears under load.
        self._task: asyncio.Task[None] | None = None

    def current(self) -> CollectionPass | None:
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
        force: bool = False,
    ) -> CollectionPass:
        """
        Begin a pass, or hand back the one already going.

        Returns which of those happened by way of `watching`: a caller whose
        route is missing from it was answered rather than served, and the
        control that pressed can say so.

        **The already-going branch is what stops a double press from spending
        twice, and it stops it here rather than in the browser** —
        `a-press-collects-the-month-it-is-on`. A forced press is a minute and a
        half of paced requests, and the control returns instantly, so an
        impatient reader clicking five times is the ordinary hazard rather than
        a rare one. The second click meets a running pass and is answered with
        it: no second task, no second plan, no request. The disabled button on
        the row is the first guard and this is the one that does not depend on a
        browser having rendered anything; `PassLock` is the third and closes the
        same hole against a scheduled pass in another process.

        `force` rides with the pass rather than being consulted here, because
        the runner's slot is about *how many* passes run and force is about what
        one of them may poll. A press that is handed somebody else's pass is
        handed it whichever of the two asked for force — there is one loop and
        it was planned before this caller arrived.
        """
        if self.running():
            assert self._pass is not None
            return self._pass

        started = CollectionPass(started_at=_now(), source=provider, watching=_watching(watches))
        self._pass = started
        self._task = asyncio.get_running_loop().create_task(
            self._run(started, watches, provider, client, force)
        )
        # A tab that was already watching — the map is on screen and somebody
        # presses a row in another window — learns that a pass began. The tab
        # that pressed does not need this: it is holding the same document as
        # this call's own answer.
        COLLECTION_STREAM.publish()
        return started

    async def _run(
        self,
        started: CollectionPass,
        watches: list[FareWatch],
        provider: str,
        client: httpx.AsyncClient | None,
        force: bool = False,
    ) -> None:
        try:
            await collect_due(
                watches, provider=provider, client=client, observer=started, force=force
            )
        except asyncio.CancelledError:
            started.state = "failed"
            started.error = "The pass was cancelled before it finished"
            started.finished_at = _now()
            # Announced before the re-raise, and this is the one path where the
            # order is load-bearing: cancellation is what shutdown does, and a
            # listener told nothing would be left holding a `running` document
            # that will never move again.
            COLLECTION_STREAM.publish()
            raise
        except Exception as error:  # a dead task is a silent one
            # The alternative is a task that raises into the event loop's
            # default handler, where the browser polling for progress sees a
            # pass that is running forever. 8.8 again: a failure that is not
            # reported is worse than one that is.
            logger.exception("fare collection pass failed")
            started.state = "failed"
            started.error = f"{type(error).__name__}: {error}"
            started.finished_at = _now()
        else:
            started.state = "finished"
            started.finished_at = _now()
            logger.info(
                "manual collection finished: %d looked at, %d skipped",
                started.completed,
                len(started.skipped),
            )
        # Both endings, in one place after the branch: whichever way a pass
        # stopped, a row that is watching it has to be told it stopped. A row
        # left on a `running` document is a spinner that never ends, which is
        # the failure 8.8 and 8.41 name and the one this stream could most
        # easily introduce.
        COLLECTION_STREAM.publish()

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


RUNNER = CollectionRunner()
