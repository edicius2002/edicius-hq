"""
The calendar pass, and the endpoint that serves what it collected.

One look is 2 to 12 HTTP requests, because a far end the upstream refuses is
walked back rather than given up on — which is the behaviour most of the pass
tests here are about. The endpoint tests are the other half: what a reader gets
when the archive has a curve, and what they get when it has none.

Out of `test_fares_calendar.py`.
"""

import asyncio
import re
from datetime import UTC, date, datetime, timedelta

import httpx
import pytest
from conftest import CAPTURE, REFUSAL, curve, read_fixture, transport
from fastapi.testclient import TestClient

from app.main import app
from app.routers import fares as fares_router
from app.services.fare_budget import RequestLedger
from app.services.fare_calendar import FareCalendar
from app.services.fare_collector import FareWatch, calendar_windows, collect_calendars

# --- the pass ----------------------------------------------------------------


def test_two_windows_cover_the_horizon_and_neither_repeats_a_date():
    """
    Measured 2026-08-19: a 181-date window answered in full and the whole
    331-date horizon was refused, so the horizon is two requests and cannot be
    one. They are contiguous rather than overlapping — a departure returned
    twice would be stored twice under one key and the later answer would
    silently win.
    """
    windows = calendar_windows(datetime(2026, 8, 19, 12, 0, tzinfo=UTC))
    assert windows == [("2026-08-19", "2027-02-15"), ("2027-02-16", "2027-07-15")]

    first, second = windows
    assert date.fromisoformat(second[0]) - date.fromisoformat(first[1]) == timedelta(days=1)
    assert date.fromisoformat(second[1]) - date.fromisoformat(first[0]) == timedelta(days=330)


def test_a_narrower_provider_limit_costs_more_windows_and_not_less_horizon():
    """The horizon is the fixed thing; the window width is whoever answered."""
    windows = calendar_windows(
        datetime(2026, 8, 19, 12, 0, tzinfo=UTC), horizon_days=330, width_days=60
    )
    assert len(windows) == 6
    assert windows[0][0] == "2026-08-19"
    assert windows[-1][1] == "2027-07-15"


def test_a_pass_spends_two_requests_a_city_pair_and_stores_one_curve(tmp_path):
    """
    Two watched months on one pair are one collection: a curve covers every
    month at once, so the month somebody watches is not a key here.
    """
    page = read_fixture(CAPTURE)
    store = FareCalendar(tmp_path)
    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(request.content.decode("utf-8"))
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [
                    FareWatch("LIM", "CUZ", "2027-03"),
                    FareWatch("LIM", "CUZ", "2027-04"),
                    FareWatch("ARI", "SCL", "2027-03"),
                ],
                now=datetime(2026, 8, 19, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert len(report.results) == 2
    assert report.requests == 4
    assert len(asked) == 4
    assert len(store.read("LIM", "CUZ")) == 1
    assert len(store.read("ARI", "SCL")) == 1
    # Both windows are answered with the same fixture here, which is a shape the
    # contiguous windows cannot produce live — and it is worth pinning that the
    # report counts what the archive holds rather than what arrived, because the
    # stored row is a map keyed by date and would collapse the repeat in silence.
    assert report.results[0].dates == 21
    assert len(store.read("LIM", "CUZ")[0].prices) == 21
    assert report.results[0].cheapest == 40.97
    assert report.results[0].cheapest_on == "2026-12-18"


def test_a_route_looked_at_today_is_skipped_with_a_reason_rather_than_dropped(tmp_path):
    """8.8 and 8.41: a pass that silently skips a route reads like a healthy one."""
    store = FareCalendar(tmp_path)
    store.record_check("LIM", "CUZ", at="2026-08-19T06:00:00+00:00", outcome="unchanged")

    async def run():
        async with transport(lambda request: httpx.Response(500)) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03")],
                now=datetime(2026, 8, 19, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.results == []
    assert report.skipped == [("LIM-CUZ", "not-due")]


def test_a_forced_pass_collects_the_pair_the_cadence_would_have_declined(tmp_path):
    """
    `force` is the reader saying they do not believe the last curve.

    The same second way in `due_now` already has for the boards
    (`a-press-collects-the-month-it-is-on`, 12.212), applied to the one cadence
    that had no way past it at all: a pair looked at inside
    `CALENDAR_POLL_MINUTES` came back `not-due` however it was asked, and the
    only exception was a pair with nothing on disk. Everything else about the
    pass is untouched — the same windows, the same store, the same report.
    """
    page = read_fixture(CAPTURE)
    store = FareCalendar(tmp_path)
    store.record_check("LIM", "CUZ", at="2026-08-19T06:00:00+00:00", outcome="unchanged")

    async def run():
        async with transport(lambda request: httpx.Response(200, text=page)) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03")],
                now=datetime(2026, 8, 19, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
                force=True,
            )

    report = asyncio.run(run())
    assert report.skipped == []
    assert [result.route for result in report.results] == ["LIM-CUZ"]
    assert len(store.read("LIM", "CUZ")) == 1


def test_force_is_refused_for_more_than_one_city_pair_at_a_time(tmp_path):
    """
    The bound 12.212 turns on, kept where it can actually be crossed.

    The endpoint cannot cross it — `CalendarCollectBody` carries one origin and
    one destination, so a press is one pair by the shape of the request. This
    function is the one that can: the scheduled pass hands it the whole
    watchlist, and a `force` that travelled with such a list would poll every
    pair the cadence had declined at 2.43 requests each. Refusing it here makes
    the bound the collector's rather than a habit of whoever calls it.
    """
    store = FareCalendar(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(500)) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03"), FareWatch("ARI", "SCL", "2027-03")],
                now=datetime(2026, 8, 19, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
                force=True,
            )

    with pytest.raises(ValueError, match="one city pair"):
        asyncio.run(run())


def test_a_forced_pair_that_cannot_afford_its_windows_is_still_over_budget(tmp_path):
    """
    The cadence is a judgement a reader may overrule; the day's ledger is not.

    Exactly the division `collect_fares` draws for the boards: `force` replaces
    `not-due` and replaces nothing else, so the budget check still runs after it
    and still answers by name. A press that could spend a day the ledger has
    already spent would make the one bound on what this address sends a
    suggestion.
    """
    store = FareCalendar(tmp_path / "calendar")
    ledger = RequestLedger(tmp_path / "spend")
    store.record_check("LIM", "CUZ", at="2026-08-19T06:00:00+00:00", outcome="unchanged")

    def refuse_to_be_asked(request: httpx.Request) -> httpx.Response:
        raise AssertionError("a pair that cannot afford its windows must cost no requests")

    async def run():
        async with transport(refuse_to_be_asked) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03")],
                now=datetime(2026, 8, 19, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
                budget=1,
                ledger=ledger,
                force=True,
            )

    report = asyncio.run(run())
    assert report.results == []
    assert report.skipped == [("LIM-CUZ", "over-budget")]


def test_one_window_refusing_costs_the_whole_curve_rather_than_half_of_it(tmp_path):
    """
    Two windows are one observation of one year. Storing the half that answered
    would put a curve in the archive that stops in February for a reason the
    file does not record — the quiet partial answer 12.4 exists to forbid.
    """
    page = read_fixture(CAPTURE)
    store = FareCalendar(tmp_path)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, text=page) if calls["n"] == 1 else httpx.Response(429)

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03")],
                now=datetime(2026, 8, 19, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.failed == 1
    assert report.results[0].error_code == "rate-limited"
    assert store.read("LIM", "CUZ") == []
    # The heartbeat is still written, so the gap is a recorded failure rather
    # than a stretch nobody can account for.
    assert [row["outcome"] for row in store.checks("LIM", "CUZ")] == ["error"]


# --- the endpoint ------------------------------------------------------------


def test_the_calendar_endpoint_serves_the_horizon_and_its_health(monkeypatch, tmp_path):
    store = FareCalendar(tmp_path)
    store.append(curve("2026-08-18T12:00:00+00:00", prices=[("2026-12-09", 90.0)]))
    store.append(
        curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87), ("2026-12-10", None)])
    )
    store.record_check("LIM", "CUZ", at="2026-08-19T12:00:00+00:00", outcome="changed", dates=2)
    monkeypatch.setattr(fares_router, "CALENDAR", store)

    answer = TestClient(app).get("/api/fares/calendar?origin=lim&destination=cuz").json()
    assert answer["horizon"]["capturedAt"] == "2026-08-19T12:00:00+00:00"
    # Yesterday's 90.00 is superseded rather than blended: the newer curve
    # answered for that date, so it wins outright and says when it was seen.
    assert answer["horizon"]["prices"] == [
        {
            "departureDate": "2026-12-09",
            "price": 59.87,
            "observedAt": "2026-08-19T12:00:00+00:00",
        },
        {
            "departureDate": "2026-12-10",
            "price": None,
            "observedAt": "2026-08-19T12:00:00+00:00",
        },
    ]
    assert answer["horizon"]["fromDate"] == "2026-08-19"
    assert answer["health"] == {
        "lastCheckedAt": "2026-08-19T12:00:00+00:00",
        "checks": 1,
        "changes": 1,
        "errors": 0,
    }


def test_a_city_pair_nobody_has_collected_answers_null_rather_than_a_404(monkeypatch, tmp_path):
    """
    A route added a minute ago has no curve yet, and that is not an error: the
    client draws nothing and the health block says nothing has looked.
    """
    monkeypatch.setattr(fares_router, "CALENDAR", FareCalendar(tmp_path))
    answer = TestClient(app).get("/api/fares/calendar?origin=LIM&destination=MAD")
    assert answer.status_code == 200
    assert answer.json()["horizon"] is None
    assert answer.json()["health"]["checks"] == 0


def test_a_far_end_the_provider_will_not_price_is_walked_back_rather_than_lost(tmp_path):
    """
    The horizon is a date the provider prices up to, and it moves one day closer
    every day until they extend their schedule.

    Measured 2026-08-20: a window ending +330 days out was refused and the same
    window ending +329 answered in full, while the day before that +330 had
    answered — so `MAX_DEPARTURE_HORIZON_DAYS` was correct when it was measured
    and wrong the next morning. A collector that reported the refusal and gave
    up would lose the whole curve for the sake of one day at its far end, every
    day, and the archive would simply stop growing.
    """
    page = read_fixture(CAPTURE)
    store = FareCalendar(tmp_path)
    asked: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode("utf-8")
        window = re.findall(r"\d{4}-\d{2}-\d{2}", body)[-2:]
        asked.append((window[0], window[1]))
        # Refuse anything reaching past the date this provider will price.
        if window[1] > "2027-07-15":
            return httpx.Response(200, text=read_fixture(REFUSAL))
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("ARI", "SCL", "2027-03")],
                now=datetime(2026, 8, 20, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.failed == 0, "a far end one day out of reach must not fail the curve"
    # The second window asks to 2027-07-16, is refused, and is asked again one
    # day shorter. Three requests: the first window, the refusal, the retry.
    assert [end for _, end in asked] == ["2027-02-16", "2027-07-16", "2027-07-15"]
    assert report.requests == 3


def test_a_pass_that_retries_says_so_while_it_is_still_running(tmp_path):
    """
    The twenty seconds a reader used to sit through with one unchanging sentence.

    This is the same pass as the test above — two windows, one refused and asked
    again — watched through a `CalendarObserver` rather than by its report. The
    plan settles before any request goes out, so a bar has a denominator from
    the start; requests move ahead of windows priced, which is what makes the
    retry visible as work rather than as a machine that has stopped.
    """
    page = read_fixture(CAPTURE)
    store = FareCalendar(tmp_path)
    seen: list[tuple[str, int, int, int]] = []

    class Recorder:
        def __init__(self) -> None:
            self.windows: int | None = None
            self.requests = 0
            self.priced_windows = 0
            self.dates = 0

        def _note(self, what: str) -> None:
            seen.append((what, self.requests, self.priced_windows, self.dates))

        def planned(self, *, windows: int, skipped: list[tuple[str, str]]) -> None:
            self.windows = windows
            self._note("planned")

        def requested(self) -> None:
            self.requests += 1
            self._note("requested")

        def priced(self, *, dates: int) -> None:
            self.priced_windows += 1
            self.dates += dates
            self._note("priced")

    watcher = Recorder()

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode("utf-8")
        window = re.findall(r"\d{4}-\d{2}-\d{2}", body)[-2:]
        if window[1] > "2027-07-15":
            return httpx.Response(200, text=read_fixture(REFUSAL))
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("ARI", "SCL", "2027-03")],
                now=datetime(2026, 8, 20, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
                observer=watcher,
            )

    asyncio.run(run())

    # The denominator lands first and before a single request, so nothing ever
    # draws a bar against a total it has not been told.
    assert seen[0][0] == "planned"
    assert watcher.windows == 2
    # Three requests for two windows. The pass says both numbers because they
    # are different facts, and the retry is the whole reason they differ.
    assert watcher.requests == 3
    assert watcher.priced_windows == 2
    assert watcher.dates > 0
    # And it moved while it ran rather than all at the end: by the time the
    # second window was priced the reader had already been told about the
    # refused attempt.
    assert [what for what, *_ in seen] == [
        "planned",
        "requested",
        "priced",
        "requested",
        "requested",
        "priced",
    ]


def test_a_pass_with_nothing_due_settles_at_zero_rather_than_staying_unsettled(tmp_path):
    """
    Zero windows and "not settled yet" are different facts and read differently.

    A bar drawn at zero for a plan that has not landed claims a denominator
    nobody has; a bar that never appears for a pass with nothing to do is
    correct. The observer has to be able to say which, so `planned` fires even
    when it has nothing to announce.
    """
    store = FareCalendar(tmp_path)
    store.record_check("LIM", "CUZ", at="2026-08-20T11:00:00+00:00", outcome="unchanged", dates=331)
    announced: list[int] = []

    class Recorder:
        def planned(self, *, windows: int, skipped: list[tuple[str, str]]) -> None:
            announced.append(windows)

        def requested(self) -> None:
            raise AssertionError("a pair that is not due must cost no requests")

        def priced(self, *, dates: int) -> None:
            raise AssertionError("a pair that is not due prices no windows")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("nothing was due, so nothing should be asked")

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03")],
                now=datetime(2026, 8, 20, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
                observer=Recorder(),
            )

    report = asyncio.run(run())
    assert announced == [0]
    assert report.skipped == [("LIM-CUZ", "not-due")]


def test_a_refusal_that_is_not_about_the_range_is_reported_rather_than_retried(tmp_path):
    """
    Only `range-refused` is answered by asking for less. A parse failure or a
    consent page does not become an answer by being asked again, and 12.4 wants
    those loud — a retry loop around them would turn one clear alarm into a
    handful of quiet ones.
    """
    store = FareCalendar(tmp_path)
    asked = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal asked
        asked += 1
        return httpx.Response(500, text="upstream fell over")

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("ARI", "SCL", "2027-03")],
                now=datetime(2026, 8, 20, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.failed == 1
    assert asked == 1, "a refusal that is not about the range is asked exactly once"
