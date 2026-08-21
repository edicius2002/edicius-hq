"""
A collection pass pushed rather than polled — `a-pass-is-pushed-not-polled`.

The endpoints are driven directly rather than through `TestClient`, the way
`test_wire.py` drives the market stream: a streaming response never ends, so a
client that asked for one and waited for a body would wait forever. Iterating
`body_iterator` by hand is also the only way to assert on the *order* frames
arrive in, which is half of what is worth pinning here.
"""

import asyncio
import json

import pytest

from app.adapters.fares.models import FareOffer, FareSnapshot
from app.routers import fares as fares_router
from app.services import calendar_job, collection_job, pass_stream
from app.services.fare_collector import CalendarReport, CollectionReport, RouteResult


class FakeRequest:
    """Enough of a `Request` for a stream: a client that has not gone away."""

    def __init__(self, disconnected: bool = False) -> None:
        self._disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self._disconnected


@pytest.fixture(autouse=True)
def a_quiet_runner():
    """
    One pass slot and one broadcast serve the whole process, so both have to be
    emptied between tests — the same reason `test_fares.py` forgets the runner.

    The flush window goes to zero as well. A quarter of a second is right in
    front of a reader and is dead time in a test suite; what these tests are
    about is which frames arrive and in what order, and the window changes
    neither.
    """
    collection_job.RUNNER.forget()
    calendar_job.CALENDAR_RUNNER.forget()
    pass_stream.COLLECTION_STREAM._flush_seconds = 0
    pass_stream.CALENDAR_STREAM._flush_seconds = 0
    yield
    collection_job.RUNNER.forget()
    calendar_job.CALENDAR_RUNNER.forget()
    pass_stream.COLLECTION_STREAM._flush_seconds = pass_stream.FLUSH_SECONDS
    pass_stream.CALENDAR_STREAM._flush_seconds = pass_stream.FLUSH_SECONDS


def parse(frame: str) -> tuple[str, object]:
    """One SSE frame as the pair a client reads it as."""
    name = frame.split("event: ", 1)[1].split("\n", 1)[0]
    return name, json.loads(frame.split("data: ", 1)[1])


def snapshot_for(flight_date: str, price: float = 380.0) -> FareSnapshot:
    return FareSnapshot(
        captured_at=f"2026-08-21T14:00:0{flight_date[-1]}+00:00",
        source="google-flights",
        origin="LIM",
        destination="SCL",
        flight_date=flight_date,
        return_date=None,
        currency="USD",
        offers=[
            FareOffer(
                airline="LA",
                airline_name="LATAM",
                flight_number="LA600",
                departure_at=f"{flight_date}T08:00",
                arrival_at=f"{flight_date}T12:00",
                transfers=0,
                duration_minutes=240,
                price=price,
                currency="USD",
            )
        ],
        insights=None,
    )


def result_for(flight_date: str, *, ok: bool = True, changed: bool = True) -> RouteResult:
    return RouteResult(
        origin="LIM",
        destination="SCL",
        flight_date=flight_date,
        return_date=None,
        ok=ok,
        changed=changed,
        offers=1,
        cheapest=380.0,
        currency="USD",
    )


async def read(body, count: int, timeout: float = 5.0) -> list[str]:
    """The next `count` frames, or an assertion rather than a hung suite."""
    frames = []
    for _ in range(count):
        frames.append(await asyncio.wait_for(anext(body), timeout))
    return frames


async def read_until(body, state: str, limit: int = 20, timeout: float = 5.0) -> list[str]:
    """
    Every frame up to and including the one reporting `state`.

    Counting frames instead would be asserting on the flush window rather than
    on the pass: how many documents a run of publishes collapses into depends
    entirely on how the collector's awaits fall against it, and that is the
    coalescing working. `TestTheFlushCoalesces` is where that is pinned on
    purpose; everywhere else the question is what was said, not in how many
    parts.
    """
    frames: list[str] = []
    for _ in range(limit):
        frame = await asyncio.wait_for(anext(body), timeout)
        frames.append(frame)
        if frame.startswith("event: pass") and parse(frame)[1]["state"] == state:
            return frames
    raise AssertionError(f"the stream never reported {state!r}")


class TestTheBoardPass:
    def test_a_machine_that_has_never_collected_says_so_at_once(self):
        """
        The catch-up frame goes out before anything is waited for.

        Without it a tab that connects to an idle machine sits silent until the
        keep-alive twenty seconds later, and a tab that connects halfway
        through a pass sees nothing until the next departure — up to three
        seconds of a control that looks broken. `idle` is an ordinary state of a
        fresh install, not an error, which is why `GET /collect` answers it too.
        """

        async def scenario():
            response = await fares_router.stream_collection(FakeRequest())
            body = response.body_iterator
            try:
                return await read(body, 1)
            finally:
                await body.aclose()

        name, document = parse(asyncio.run(scenario())[0])
        assert name == "pass"
        assert document["state"] == "idle"
        assert document["watching"] == []

    def test_a_pass_that_plans_collects_and_finishes_says_each_of_those(self, monkeypatch):
        """
        The three moments a reader is waiting on, in the order they happen.

        `planned` is the denominator — until it lands the bar can only say
        "moving, length unknown" (`passProgress`). Each `collected` is a
        departure landing, and it carries the snapshot in its own frame *before*
        the document that counts it, so a client can never read a completed
        count its chart has not caught up with. The last frame is the pass
        stopping, which is what takes the row off its spinner.
        """
        # Four gates, so the pass advances only when the test lets it — which is
        # what a real pass does by sleeping `REQUEST_GAP_SECONDS` between
        # departures, without the three seconds.
        steps = [asyncio.Event() for _ in range(4)]

        async def fake_collect_due(watched, **kwargs):
            observer = kwargs["observer"]
            await steps[0].wait()
            observer.planned(polling=2, skipped=[("LIM-SCL 2027-03-03", "not-due")])
            await steps[1].wait()
            observer.collected(result_for("2027-03-01"), snapshot_for("2027-03-01"))
            await steps[2].wait()
            observer.collected(result_for("2027-03-02"), snapshot_for("2027-03-02"))
            await steps[3].wait()
            return CollectionReport(
                started_at="2026-08-21T14:00:00+00:00",
                finished_at="2026-08-21T14:00:06+00:00",
                source="google-flights",
                results=[result_for("2027-03-01"), result_for("2027-03-02")],
                skipped=[("LIM-SCL 2027-03-03", "not-due")],
            )

        monkeypatch.setattr(collection_job, "collect_due", fake_collect_due)

        async def scenario():
            response = await fares_router.stream_collection(FakeRequest())
            body = response.body_iterator
            try:
                frames = await read(body, 1)
                collection_job.RUNNER.start(
                    [collection_job.FareWatch(origin="LIM", destination="SCL", month="2027-03")]
                )
                # The press itself is a frame: a tab that was already watching
                # learns a pass began, even though the tab that pressed is
                # already holding this same document as its own answer.
                frames += await read(body, 1)
                steps[0].set()
                frames += await read(body, 1)
                for step in steps[1:3]:
                    step.set()
                    frames += await read(body, 2)
                steps[3].set()
                frames += await read_until(body, "finished")
                return frames
            finally:
                await body.aclose()

        frames = [parse(frame) for frame in asyncio.run(scenario())]
        names = [name for name, _ in frames]

        # Idle, the press, the plan, then each departure as a snapshot followed
        # by the document that counts it, then the pass ending. Snapshots lead.
        assert names == [
            "pass",
            "pass",
            "pass",
            "snapshot",
            "pass",
            "snapshot",
            "pass",
            "pass",
        ]

        assert frames[0][1]["state"] == "idle"

        # A pass that has started but not planned yet. `polling` is null rather
        # than zero, which is a different fact and the one thing that lets the
        # bar say "moving, length unknown" instead of claiming a denominator.
        pressed = frames[1][1]
        assert pressed["state"] == "running" and pressed["polling"] is None

        plan = frames[2][1]
        assert plan["state"] == "running" and plan["polling"] == 2
        assert plan["watching"] == ["LIM-SCL 2027-03"]
        assert plan["skipped"] == [{"what": "LIM-SCL 2027-03-03", "reason": "not-due"}]

        assert frames[3][1]["flightDate"] == "2027-03-01"
        assert frames[4][1]["completed"] == 1
        assert frames[5][1]["flightDate"] == "2027-03-02"
        assert frames[6][1]["completed"] == 2

        ended = frames[7][1]
        assert ended["state"] == "finished" and ended["finishedAt"] is not None

    def test_a_look_that_wrote_nothing_pushes_no_point(self, monkeypatch):
        """
        A snapshot is pushed only when the archive took it.

        `append_if_changed` writes only when the board moved, which at a
        half-hourly cadence is a minority of looks. A frame sent for every look
        would put a point in front of the reader that a page reload then takes
        away again — a chart that disagrees with the file behind it, which is
        worse than the frozen chart this whole thing replaces.
        """

        async def fake_collect_due(watched, **kwargs):
            observer = kwargs["observer"]
            observer.planned(polling=1, skipped=[])
            # The ordinary case: the board had not moved, so nothing was
            # written and the collector hands the observer no snapshot.
            observer.collected(result_for("2027-03-01", changed=False), None)
            return CollectionReport(
                started_at="2026-08-21T14:00:00+00:00",
                finished_at="2026-08-21T14:00:03+00:00",
                source="google-flights",
                results=[result_for("2027-03-01", changed=False)],
            )

        monkeypatch.setattr(collection_job, "collect_due", fake_collect_due)

        async def scenario():
            response = await fares_router.stream_collection(FakeRequest())
            body = response.body_iterator
            try:
                first = await read(body, 1)
                collection_job.RUNNER.start(
                    [collection_job.FareWatch(origin="LIM", destination="SCL", month="2027-03")]
                )
                return first + await read_until(body, "finished")
            finally:
                await body.aclose()

        frames = [parse(frame) for frame in asyncio.run(scenario())]
        assert "snapshot" not in [name for name, _ in frames]
        # The look still happened and the document still counts it — what is
        # absent is only the point, because there is no point.
        assert frames[-1][1]["completed"] == 1 and frames[-1][1]["changed"] == 0

    def test_a_tab_that_arrives_mid_pass_is_caught_up_rather_than_left_waiting(self, monkeypatch):
        """
        The press and the stream are two calls, and a departure can land between
        them. What closes that hole is the catch-up frame carrying the whole
        document rather than only what has happened since — so a listener that
        subscribed a second late still knows the denominator, the count and
        whose pass it is.
        """
        running = asyncio.Event()
        release = asyncio.Event()

        async def slow_collect_due(watched, **kwargs):
            observer = kwargs["observer"]
            observer.planned(polling=31, skipped=[])
            observer.collected(result_for("2027-03-01"), snapshot_for("2027-03-01"))
            running.set()
            await release.wait()
            return CollectionReport(
                started_at="2026-08-21T14:00:00+00:00",
                finished_at="2026-08-21T14:00:09+00:00",
                source="google-flights",
                results=[result_for("2027-03-01")],
            )

        monkeypatch.setattr(collection_job, "collect_due", slow_collect_due)

        async def scenario():
            collection_job.RUNNER.start(
                [collection_job.FareWatch(origin="LIM", destination="SCL", month="2027-03")]
            )
            await asyncio.wait_for(running.wait(), 5.0)

            response = await fares_router.stream_collection(FakeRequest())
            body = response.body_iterator
            try:
                caught_up = await read(body, 1)
                release.set()
                return caught_up + await read(body, 1)
            finally:
                await body.aclose()

        frames = [parse(frame) for frame in asyncio.run(scenario())]
        assert frames[0][0] == "pass"
        assert frames[0][1]["state"] == "running"
        assert frames[0][1]["polling"] == 31 and frames[0][1]["completed"] == 1
        assert frames[0][1]["watching"] == ["LIM-SCL 2027-03"]
        # And it is still told when the pass ends.
        assert frames[1][1]["state"] == "finished"

    def test_a_pass_that_falls_over_is_announced_rather_than_left_running(self, monkeypatch):
        """
        8.8, in the place this stream could most easily have broken it. A task
        that dies has nowhere to raise, and a row that never hears the pass stop
        is a spinner with no end — the exact failure the poll it replaces was
        careful about.
        """

        async def broken_collect_due(watched, **kwargs):
            kwargs["observer"].planned(polling=1, skipped=[])
            raise RuntimeError("the archive volume went away")

        monkeypatch.setattr(collection_job, "collect_due", broken_collect_due)

        async def scenario():
            response = await fares_router.stream_collection(FakeRequest())
            body = response.body_iterator
            try:
                first = await read(body, 1)
                collection_job.RUNNER.start(
                    [collection_job.FareWatch(origin="LIM", destination="SCL", month="2027-03")]
                )
                return first + await read_until(body, "failed")
            finally:
                await body.aclose()

        last = parse(asyncio.run(scenario())[-1])[1]
        assert last["state"] == "failed"
        assert "the archive volume went away" in last["error"]

    def test_silence_is_a_keep_alive_and_not_an_ending(self):
        """
        A machine that is collecting nothing is this endpoint's ordinary state,
        not an edge case — most of the day nobody has pressed anything. The
        comment frame keeps bytes moving past a proxy without delivering an
        event, and nothing about the quiet ends the generator.
        """

        async def scenario():
            pass_stream.COLLECTION_STREAM._keepalive_seconds = 0.05
            try:
                response = await fares_router.stream_collection(FakeRequest())
                body = response.body_iterator
                try:
                    return await read(body, 3)
                finally:
                    await body.aclose()
            finally:
                pass_stream.COLLECTION_STREAM._keepalive_seconds = pass_stream.KEEPALIVE_SECONDS

        frames = asyncio.run(scenario())
        assert frames[0].startswith("event: pass")
        assert frames[1] == ": keep-alive\n\n"
        assert frames[2] == ": keep-alive\n\n"

    def test_a_client_that_went_away_ends_the_stream(self):
        """A response that kept generating for a browser that closed the tab
        would hold a listener and a task for nothing."""

        async def scenario():
            response = await fares_router.stream_collection(FakeRequest(disconnected=True))
            body = response.body_iterator
            try:
                await read(body, 1)
                pass_stream.COLLECTION_STREAM.publish()
                # The disconnect is noticed on the next update, so the generator
                # returns rather than yielding again.
                with pytest.raises(StopAsyncIteration):
                    await asyncio.wait_for(anext(body), 5.0)
            finally:
                await body.aclose()
            return pass_stream.COLLECTION_STREAM.listener_count

        assert asyncio.run(scenario()) == 0


class TestTheFlushCoalesces:
    """
    Two things happening close together are one repaint, and the two kinds
    coalesce in opposite directions.

    A pass document *replaces*: it is a whole document, only the newest is true,
    and three publishes inside one window are worth one frame. A snapshot
    *accumulates*: each is a separate thing that was written to the archive and
    the client draws one point per snapshot, so a snapshot dropped because a
    later one arrived is a point that never appears until the page is reloaded.
    `StreamHub` replaces in both directions, which is right for a price and is
    the reason this is not that.
    """

    def test_a_run_of_publishes_inside_one_window_is_one_document(self):
        async def scenario():
            with pass_stream.COLLECTION_STREAM.subscribe() as updates:
                for _ in range(5):
                    pass_stream.COLLECTION_STREAM.publish()
                return await asyncio.wait_for(anext(updates), 5.0)

        update = asyncio.run(scenario())
        assert update.moved is True
        assert update.items == ()

    def test_every_snapshot_in_one_window_survives_it(self):
        first, second = snapshot_for("2027-03-01"), snapshot_for("2027-03-02")

        async def scenario():
            with pass_stream.COLLECTION_STREAM.subscribe() as updates:
                pass_stream.COLLECTION_STREAM.write(first)
                pass_stream.COLLECTION_STREAM.publish()
                pass_stream.COLLECTION_STREAM.write(second)
                pass_stream.COLLECTION_STREAM.publish()
                return await asyncio.wait_for(anext(updates), 5.0)

        update = asyncio.run(scenario())
        # One document for the two departures, and both departures.
        assert update.moved is True
        assert [snapshot.flight_date for snapshot in update.items] == [
            "2027-03-01",
            "2027-03-02",
        ]

    def test_a_listener_is_registered_before_anything_is_read_from_it(self):
        """
        The hole an `async def` generator left, pinned so it cannot come back.

        A generator body does not run until something calls `anext`, so a
        `listen()` that subscribed on its first line subscribed on the first
        *read* — which in the endpoint is after the catch-up document has been
        rendered and sent. A departure landing in that window reached nobody.
        """
        broadcast: pass_stream.PassBroadcast[FareSnapshot] = pass_stream.PassBroadcast()

        with broadcast.subscribe():
            # Registered by the `with` itself, with nothing yet read from it.
            assert broadcast.listener_count == 1
        assert broadcast.listener_count == 0


class TestTheFramesAreTheDocumentsThisApiAlreadyHas:
    """
    The whole reason this stream carries no vocabulary of its own.

    `tick_payload` in the market router invented a thinner shape for the socket
    and the two drifted — the socket grew an `EXTENDED` market state the browser
    had no branch for, because one question was being answered in two places. A
    frame that *is* the REST model cannot do that, and these are the assertions
    that keep it that way.
    """

    def test_a_pass_frame_is_the_document_the_poll_answers_with(self):
        assert set(fares_router.IDLE.model_dump(mode="json")) == set(
            fares_router.CollectResponse.model_fields
        )

        async def scenario():
            response = await fares_router.stream_collection(FakeRequest())
            body = response.body_iterator
            try:
                return parse((await read(body, 1))[0])[1]
            finally:
                await body.aclose()

        assert asyncio.run(scenario()) == fares_router.IDLE.model_dump(mode="json")

    def test_a_snapshot_frame_is_an_element_of_the_history_response(self):
        snapshot = snapshot_for("2027-03-01")
        framed = fares_router._snapshot_model(snapshot).model_dump(mode="json")

        assert set(framed) == set(fares_router.SnapshotModel.model_fields)
        assert framed["capturedAt"] == snapshot.captured_at
        assert framed["flightDate"] == "2027-03-01"
        assert framed["offers"][0]["price"] == 380.0
        # Which upstream answered is the API's business — 8.3 — and `source` is
        # the same word `/history` has always used for it.
        assert framed["source"] == "google-flights"


class TestTheHorizonPass:
    def test_it_reports_the_two_states_a_curve_pass_has(self, monkeypatch):
        """
        There is no halfway point to report and deliberately no `snapshot`
        event: a curve is one city pair and two paced requests, which is why
        `CalendarPass` has no observer either. "Has it stopped yet" is the whole
        of what the two-second poll was asking, and one frame answers it.
        """

        async def fake_collect_calendars(watched, **kwargs):
            return CalendarReport(
                started_at="2026-08-21T14:00:00+00:00",
                finished_at="2026-08-21T14:00:04+00:00",
                source="google-flights",
                results=[],
                skipped=[("LIM-SCL", "not-due")],
            )

        monkeypatch.setattr(calendar_job, "collect_calendars", fake_collect_calendars)

        async def scenario():
            response = await fares_router.stream_calendar_collection(FakeRequest())
            body = response.body_iterator
            try:
                first = await read(body, 1)
                calendar_job.CALENDAR_RUNNER.start(
                    [calendar_job.FareWatch(origin="LIM", destination="SCL", month="")]
                )
                return first + await read_until(body, "finished")
            finally:
                await body.aclose()

        frames = [parse(frame) for frame in asyncio.run(scenario())]
        # No `snapshot` event exists on this stream at all; there is nothing
        # between a curve pass starting and ending for one to describe.
        assert set(name for name, _ in frames) == {"pass"}
        assert frames[0][1]["state"] == "idle"
        assert frames[-1][1]["state"] == "finished"
        assert frames[-1][1]["watching"] == ["LIM-SCL"]
        assert frames[-1][1]["skipped"] == [{"what": "LIM-SCL", "reason": "not-due"}]
