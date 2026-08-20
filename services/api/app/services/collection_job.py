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

**A pass that is still running still says what it is doing.** `planned` lands
before the first request, so the progress document knows its own denominator
from the start; every result is added as it arrives. A reader watching a
four-minute pass sees it move rather than seeing a spinner and a promise.
"""

import asyncio
import contextlib
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx

from app.adapters.fares.registry import DEFAULT_PROVIDER
from app.services.fare_collector import (
    CollectionReport,
    FareWatch,
    RouteResult,
    collect_due,
)

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

    def collected(self, result: RouteResult) -> None:
        self.results.append(result)

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
    ) -> CollectionPass:
        """
        Begin a pass, or hand back the one already going.

        Returns which of those happened by way of `watching`: a caller whose
        route is missing from it was answered rather than served, and the
        control that pressed can say so.
        """
        if self.running():
            assert self._pass is not None
            return self._pass

        started = CollectionPass(started_at=_now(), source=provider, watching=_watching(watches))
        self._pass = started
        self._task = asyncio.get_running_loop().create_task(
            self._run(started, watches, provider, client)
        )
        return started

    async def _run(
        self,
        started: CollectionPass,
        watches: list[FareWatch],
        provider: str,
        client: httpx.AsyncClient | None,
    ) -> None:
        try:
            await collect_due(watches, provider=provider, client=client, observer=started)
        except asyncio.CancelledError:
            started.state = "failed"
            started.error = "The pass was cancelled before it finished"
            started.finished_at = _now()
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
