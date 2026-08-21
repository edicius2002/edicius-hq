"""
One collection pass, watched by however many browser tabs are looking.

**Why this is not `StreamHub`.** The SSE plumbing in `app.routers.market` is
exactly the right plumbing and is reused as it stands (`app.services.sse`). The
*hub* is not, and the reason is not that a pass is smaller. A hub exists to
refcount subscriptions: many tabs want overlapping subsets of symbols, so it
counts who wants what, asks the upstream for the union, and drops a symbol only
when the last listener that wanted it has gone. A collection pass has none of
that shape. `CollectionRunner` keeps one slot, a press that arrives during a
pass is answered with that pass (12.210), and there is therefore exactly one
thing to watch and no subset of it anybody could ask for. Refcounting a set of
size one would be machinery in exchange for nothing.

**And the coalescing rule is the opposite one.** `_Listener.offer` in the hub
*replaces*: an unread tick is thrown away when a newer one arrives, because a
price nobody has rendered yet is worth exactly nothing once a later price
exists. That is right for a price and wrong here. A snapshot is a fact that was
written to the archive, the client is drawing one point per snapshot, and a
snapshot dropped because a later one arrived within the flush window is a point
that never appears until the page is reloaded — the exact fault this stream was
built to remove. So the two kinds of pending held below are deliberately
different: the pass *document* replaces, because it is a whole document and only
the newest is true; the items *accumulate*, because each is a separate thing
that happened. Reusing the hub would have made the wrong one the default.

What is genuinely shared is smaller than it looks and is taken rather than
copied: the SSE framing (`app.services.sse`) and the shape of `drain` — wait on
an `asyncio.Event` with a timeout, hand over everything pending at once, and
report silence as an empty result rather than as an end. The timeout belongs on
the `Event.wait` and never around the generator, and that is worth restating
here because the hub paid for it: `asyncio.wait_for` wrapped around `anext`
delivers its cancellation *into* the generator, which runs the `finally`,
unsubscribes and ends the response — so every quiet interval tore a listener
down and a still market cost roughly 150 reconnects an hour.
"""

import asyncio
import contextlib
from collections.abc import AsyncGenerator, AsyncIterator, Iterator
from dataclasses import dataclass
from typing import Never

from app.adapters.fares.models import FareSnapshot

# The type parameter `T` below is what rides along beside the pass document. A
# board pass carries the snapshots it wrote; a calendar pass carries nothing but
# its own state, and says so in its type rather than in a comment nobody reads.

# How often a listener is flushed.
#
# A quarter second, the same as `StreamHub.FLUSH_SECONDS`, and for a weaker
# reason than the hub has: a departure arrives every `REQUEST_GAP_SECONDS`,
# which is three, so almost nothing here ever needs coalescing at all. The two
# moments that do are the plan settling and the first departure landing on top
# of it, and a pass that ends immediately because nothing was due — where the
# planned, finished and closed frames are all inside one tick. A quarter second
# turns each of those into one frame instead of two or three, and adds a delay
# to a departure that is an order of magnitude under the gap between them.
FLUSH_SECONDS = 0.25

# How long a listener waits before saying "still here" with nothing to report.
#
# Twenty seconds, matching the hub. Long enough that a running pass never
# reaches it — a departure lands every three — and short enough that a proxy
# watching for bytes does not give up first. It matters more here than it does
# for prices, because an idle machine that has collected nothing for hours is
# the *ordinary* state of this endpoint rather than an overnight edge case.
KEEPALIVE_SECONDS = 20.0


@dataclass(frozen=True, slots=True)
class PassUpdate[T]:
    """
    Everything that happened to a pass in one flush window.

    Frozen and handed over whole, so a listener cannot be reading a batch while
    the collector is still adding to it.
    """

    #: The pass document itself moved — planned, a departure came back, the pass
    #: finished or fell over. A flag rather than the document, because the
    #: document is rendered by the router from the runner's live state and the
    #: newest reading is the only one worth sending. A service that built the
    #: wire model here would have to import the router that defines it.
    moved: bool
    #: What was written since the last flush, oldest first. Accumulated rather
    #: than replaced — see the module docstring.
    items: tuple[T, ...]

    def __bool__(self) -> bool:
        """False for a keep-alive: nothing moved and nothing was written."""
        return self.moved or bool(self.items)


class _Listener[T]:
    """One browser tab's view of the pass, and what is owed to it."""

    def __init__(self) -> None:
        self._moved = False
        self._items: list[T] = []
        self._ready = asyncio.Event()
        self._closed = False

    def offer_move(self) -> None:
        self._moved = True
        self._ready.set()

    def offer_item(self, item: T) -> None:
        self._items.append(item)
        self._ready.set()

    def close(self) -> None:
        self._closed = True
        self._ready.set()

    async def drain(self, timeout: float | None = None) -> PassUpdate[T]:
        """
        Wait for something to say, then say all of it at once.

        A falsy update means "nothing within `timeout`" — a keep-alive, not a
        reason to stop. The timeout is on the `Event.wait` and deliberately not
        around the generator that calls this; see the module docstring for what
        the other arrangement cost.
        """
        try:
            await asyncio.wait_for(self._ready.wait(), timeout)
        except TimeoutError:
            return PassUpdate(moved=False, items=())

        self._ready.clear()
        batch = PassUpdate(moved=self._moved, items=tuple(self._items))
        self._moved = False
        self._items.clear()
        return batch

    @property
    def closed(self) -> bool:
        return self._closed


class PassBroadcast[T]:
    """
    The one pass everybody is watching, fanned out to everybody watching it.

    Module-level state where it is instantiated, like `RUNNER` and `HISTORY`
    and for the same reason: there is one process and one pass slot, so a
    per-request broadcaster would be a broadcast to one.

    **Nothing here blocks, and that is a requirement rather than a property.**
    `publish` and `write` are called from inside the collector's own loop,
    between an upstream request and the next paced wait. Anything that awaited
    there would be pacing the provider by accident.
    """

    def __init__(
        self,
        *,
        flush_seconds: float = FLUSH_SECONDS,
        keepalive_seconds: float = KEEPALIVE_SECONDS,
    ) -> None:
        self._listeners: set[_Listener[T]] = set()
        self._flush_seconds = flush_seconds
        self._keepalive_seconds = keepalive_seconds

    @property
    def listener_count(self) -> int:
        return len(self._listeners)

    def publish(self) -> None:
        """The pass document moved. Every listener will re-read it."""
        for listener in self._listeners:
            listener.offer_move()

    def write(self, item: T) -> None:
        """Something was written to the archive, and must reach every listener."""
        for listener in self._listeners:
            listener.offer_item(item)

    @contextlib.contextmanager
    def subscribe(self) -> Iterator[AsyncIterator[PassUpdate[T]]]:
        """
        Register a listener now, and hand back the updates owed to it.

        **A plain `async def` generator here was wrong, and quietly.** An async
        generator's body does not run until something calls `anext` on it, so a
        `listen()` that registered its listener on the first line registered it
        on the first *read* — which in the endpoint is after the catch-up
        document has already been rendered and sent. Anything the collector
        published in between reached nobody: a departure landing in that window
        was a point the chart never drew and the reader never got back without a
        reload, which is the whole fault this stream exists to remove. It was
        found by a test that disconnected a client and watched the frame it
        published go nowhere.

        A synchronous context manager cannot have that gap. `subscribe()` runs
        on the `with`, before its body renders anything, and the listener is
        dropped on the way out whether the body returned, raised, or was
        unwound by the `GeneratorExit` Starlette throws in when a browser
        closes the tab.

        A falsy `PassUpdate` is a **keep-alive**: nothing has happened for a
        while and the connection is still good. The caller turns it into
        whatever its transport needs. Nothing about an idle machine ends the
        iteration, which matters more here than it does for prices — a machine
        that collects nothing for hours is this endpoint's ordinary state.
        """
        listener: _Listener[T] = _Listener()
        self._listeners.add(listener)
        try:
            yield self._updates(listener)
        finally:
            self._listeners.discard(listener)

    async def _updates(self, listener: _Listener[T]) -> AsyncGenerator[PassUpdate[T], None]:
        while True:
            batch = await listener.drain(self._keepalive_seconds)
            if listener.closed:
                return
            yield batch
            # Rate limit after a real batch only. Pausing after a keep-alive
            # would delay the next genuine departure by a window it did nothing
            # to earn.
            if batch:
                await asyncio.sleep(self._flush_seconds)

    def close(self) -> None:
        """End every listener, at shutdown."""
        for listener in list(self._listeners):
            listener.close()


#: The board pass — `CollectionRunner`. Carries the snapshots it writes, so a
#: chart gains its point without asking for anything.
COLLECTION_STREAM: PassBroadcast[FareSnapshot] = PassBroadcast()

#: The booking-horizon pass — `CalendarRunner`. `Never` rather than a payload
#: type it would not use, and that half of the original reasoning stands: a pair
#: writes exactly one curve and it writes it at the very end, so there is no
#: item to ride along and the chart refreshes from `GET /calendar` when the pass
#: stops, exactly as it did.
#:
#: What this carries is therefore the pass document alone — but it now moves
#: more than three times. `CalendarPass` gained an observer once a pass was
#: measured at three requests and twenty seconds rather than the two requests
#: and few seconds it was designed against, so `publish` also fires as each
#: request goes out and each window comes back.
CALENDAR_STREAM: PassBroadcast[Never] = PassBroadcast()
