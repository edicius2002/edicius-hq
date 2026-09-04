"""
The collector, and the `/api/fares` endpoint over it.

Out of `test_fares.py`, and the split is more than tidying here.
`a_runner_with_no_history` below is `autouse` at module scope: in the old file
it emptied the one pass slot before and after all 67 tests, including the forty
that only parse a protobuf and never reach `collection_job` at all. It now runs
for the twenty tests that actually use the runner.

`transport` is defined here rather than taken from `conftest` because the
collector tests want the handler-per-route flavour beside `searched_for`.
"""

import asyncio
import base64
import json
import time

import httpx
import pytest
from conftest import read_fixture
from fastapi.testclient import TestClient

from app.adapters.fares.models import FareQuery
from app.main import app
from app.routers import fares as fares_router
from app.services import collection_job
from app.services.fare_collector import CollectionReport, FareWatch, RouteResult, collect
from app.services.fare_history import FareHistory

# --- the collector ---------------------------------------------------------


def transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def searched_for(request: httpx.Request) -> str:
    """
    The route a request is asking about.

    It is not in the URL in any readable form — the whole search is a base64
    protobuf in `?tfs=` — so a handler that wants to answer differently per
    route has to decode it, exactly as Google does.
    """
    return base64.b64decode(request.url.params["tfs"]).decode("latin-1")


def test_collect_archives_every_route_it_could_fetch(tmp_path):
    html = read_fixture("google_flights_lim_scl.html")
    history = FareHistory(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect(
                [FareQuery("LIM", "SCL", "2026-10-16"), FareQuery("LIM", "MAD", "2026-10-16")],
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.collected == 2
    assert report.failed == 0
    assert report.results[0].cheapest == 124.64
    assert report.results[0].offers == 2
    assert len(history.read("LIM", "SCL")) == 1
    assert len(history.read("LIM", "MAD")) == 1


def test_a_refused_route_is_reported_beside_the_ones_that_worked(tmp_path):
    """
    Decisions 8.8 and 8.41. A collector that dropped the failure would look
    exactly like a route whose price did not move.
    """
    html = read_fixture("google_flights_lim_scl.html")
    history = FareHistory(tmp_path)

    def handler(request):
        if "VVI" in searched_for(request):
            return httpx.Response(429, text="slow down")
        return httpx.Response(200, text=html)

    async def run():
        async with transport(handler) as client:
            return await collect(
                [FareQuery("LIM", "SCL", "2026-10-16"), FareQuery("LIM", "VVI", "2026-10-16")],
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.collected == 1
    assert report.failed == 1

    failed = next(result for result in report.results if not result.ok)
    assert failed.destination == "VVI"
    assert failed.error_code == "rate-limited"
    assert failed.error_message
    # Nothing was archived for the route that failed, so the series keeps no
    # phantom point at a price nobody observed.
    assert history.read("LIM", "VVI") == []


def test_collect_reports_a_route_google_has_no_flights_for(tmp_path):
    empty = json.dumps([None, None, None, [None], None, None, None, None])
    page = (
        f'<script class="ds:1">AF_initDataCallback({{data:{empty}, sideChannel: {{}}}});</script>'
    )
    history = FareHistory(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=page)) as client:
            return await collect(
                [FareQuery("LIM", "IPC", "2026-10-16")],
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.results[0].error_code == "no-offers"
    assert history.read("LIM", "IPC") == []


# --- the endpoint ------------------------------------------------------------


@pytest.fixture(autouse=True)
def a_runner_with_no_history():
    """
    One pass slot serves the whole process, so it has to be emptied between
    tests — 12.210. Without this a test that asserts on the idle state passes
    or fails depending on which tests ran before it.
    """
    collection_job.RUNNER.forget()
    yield
    collection_job.RUNNER.forget()


def stub_pass(skipped=None, results=None):
    """A collector that reaches nothing and reports what it was handed."""
    seen: dict[str, object] = {}

    async def fake_collect_due(watched, **kwargs):
        seen["watched"] = watched
        seen["budget"] = kwargs.get("budget")
        seen["force"] = kwargs.get("force")
        observer = kwargs.get("observer")
        if observer is not None:
            observer.planned(polling=len(results or []), skipped=list(skipped or []))
            for result in results or []:
                observer.collected(result)
        return CollectionReport(
            started_at="2026-08-19T14:00:00+00:00",
            finished_at="2026-08-19T14:00:06+00:00",
            source="google-flights",
            results=list(results or []),
            skipped=list(skipped or []),
        )

    return seen, fake_collect_due


def wait_for_the_pass(client, timeout=5.0):
    """
    Poll `GET /collect` until the pass stops running, and return it.

    A press is answered before the work is done — 12.210 — so a test that
    asserted on the POST's body alone would be asserting about a pass that had
    not started yet. This is the same thing the browser does, and testing it
    the way the client uses it is the point.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        answer = client.get("/api/fares/collect")
        assert answer.status_code == 200
        body = answer.json()
        if body["state"] != "running":
            return body
        time.sleep(0.01)
    raise AssertionError("the collection pass never finished")


def test_nothing_has_been_collected_yet_is_an_answer_rather_than_a_404():
    """
    A fresh install has never run a pass, and that is an ordinary state rather
    than an error — 12.210. Answering 404 would make every client special-case
    a failure to describe a machine that is simply idle.
    """
    with TestClient(app) as client:
        body = client.get("/api/fares/collect").json()
    assert body["state"] == "idle"
    assert body["startedAt"] is None
    assert body["polling"] is None
    assert body["results"] == [] and body["skipped"] == []


def test_a_press_is_answered_before_the_pass_it_started_has_finished(monkeypatch):
    """
    12.210. The press returns 202 and a document, not a completed report.

    This is the whole of what the change buys: the browser's five-minute
    deadline used to be what decided how many departures a press could cover,
    and a press that is answered immediately has no deadline to fit inside. The
    ceiling that deadline implied — forty requests — is gone with it, so the
    pass is handed no budget at all and falls back to the request budget.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        answer = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        assert answer.status_code == 202
        assert answer.json()["watching"] == ["LIM-SCL 2027-03"]
        finished = wait_for_the_pass(client)

    assert finished["state"] == "finished"
    assert finished["finishedAt"] is not None
    # No per-call ceiling any more. `collect_due` falls back to the request
    # budget, which is what the bound should always have been.
    assert seen["budget"] is None


def test_a_running_pass_says_how_far_through_it_is(monkeypatch):
    """
    A four-minute pass that could only be described once it ended would leave
    the reader watching a spinner and a promise — 12.210. `polling` lands
    before the first request so the figure has a denominator from the start.
    """
    result = RouteResult(
        origin="LIM",
        destination="SCL",
        flight_date="2027-03-01",
        return_date=None,
        ok=True,
        changed=True,
        offers=3,
    )
    _, fake = stub_pass(skipped=[("LIM-SCL 2027-03-02", "not-due")], results=[result])
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        finished = wait_for_the_pass(client)

    assert finished["polling"] == 1
    assert finished["completed"] == 1
    assert finished["collected"] == 1 and finished["changed"] == 1
    assert finished["results"][0]["flightDate"] == "2027-03-01"


def test_a_second_press_joins_the_running_pass_rather_than_starting_another(monkeypatch):
    """
    The gap in `fare_collector` paces one loop, so two loops would halve it
    with nobody having decided to — 12.210. The second press is answered with
    the pass that is already going, and `watching` is what says so: a caller
    whose own route is missing from it knows it was answered rather than served.
    """
    started = asyncio.Event()
    release = asyncio.Event()
    calls: list[list] = []

    async def slow_collect_due(watched, **kwargs):
        calls.append(watched)
        observer = kwargs.get("observer")
        if observer is not None:
            observer.planned(polling=1, skipped=[])
        started.set()
        await release.wait()
        return CollectionReport(
            started_at="2026-08-19T14:00:00+00:00",
            finished_at="2026-08-19T14:00:06+00:00",
            source="google-flights",
            results=[],
            skipped=[],
        )

    monkeypatch.setattr(collection_job, "collect_due", slow_collect_due)

    with TestClient(app) as client:
        first = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        assert first.status_code == 202
        # Give the task a turn on the loop, so the second press meets a pass
        # that has genuinely begun rather than one still queued.
        deadline = time.monotonic() + 5.0
        while not started.is_set() and time.monotonic() < deadline:
            client.get("/api/fares/collect")
            time.sleep(0.01)
        assert started.is_set()

        second = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "ARI", "destination": "SCL", "month": "2027-03"}]},
        )
        assert second.status_code == 202
        # Somebody else's pass, and the document says whose.
        assert second.json()["state"] == "running"
        assert second.json()["watching"] == ["LIM-SCL 2027-03"]

        release.set()
        wait_for_the_pass(client)

    assert len(calls) == 1


def test_a_pass_that_falls_over_says_so_rather_than_running_forever(monkeypatch):
    """
    8.8 again, in the one place it had nowhere to be reported: a background
    task that raises hands its exception to the event loop, where a browser
    polling for progress would see a pass that is running and always will be.
    """

    async def broken_collect_due(watched, **kwargs):
        raise RuntimeError("the archive volume went away")

    monkeypatch.setattr(collection_job, "collect_due", broken_collect_due)

    with TestClient(app) as client:
        client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        finished = wait_for_the_pass(client)

    assert finished["state"] == "failed"
    assert "the archive volume went away" in finished["error"]
    assert finished["finishedAt"] is not None


def test_the_collect_endpoint_takes_a_month_and_refuses_anything_else(monkeypatch):
    """
    The client sends what the reader watches — a city pair and a month, 12.110.

    It no longer knows which departures exist inside one, and it should not:
    expanding a month is the collector's job because only the collector can
    also report the days it decided to leave alone, and why.

    A typo is a 422 the client can show rather than a month that silently
    expands to nothing.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        ok = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "lim", "destination": "scl", "month": "2027-03"}]},
        )
        assert ok.status_code == 202
        wait_for_the_pass(client)
        assert seen["watched"] == [FareWatch(origin="LIM", destination="SCL", month="2027-03")]

        for bad in ("2027-3", "2027-13", "2027-03-09", "soon"):
            refused = client.post(
                "/api/fares/collect",
                json={"routes": [{"origin": "LIM", "destination": "SCL", "month": bad}]},
            )
            assert refused.status_code == 422, bad


def test_the_collect_body_carries_a_city_pair_and_a_month_and_nothing_else(monkeypatch):
    """
    12.266. The body used to carry `focusDate` beside the month.

    That was the one reading preference this API ever accepted, and the only
    thing it did was decide which departure survived a truncated pass (12.134).
    A watch names no departure now, so the field is gone from the model — and a
    stale client still sending it is ignored rather than refused, which is
    Pydantic's default and the right answer: the value would only have changed
    the order of a pass, and the pass now orders by distance.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        answer = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "lim", "destination": "scl", "month": "2027-03"}]},
        )
        assert answer.status_code == 202
        wait_for_the_pass(client)
        assert seen["watched"] == [FareWatch(origin="LIM", destination="SCL", month="2027-03")]

        stale = client.post(
            "/api/fares/collect",
            json={
                "routes": [
                    {
                        "origin": "LIM",
                        "destination": "SCL",
                        "month": "2027-03",
                        "focusDate": "2027-03-09",
                    }
                ]
            },
        )
        assert stale.status_code == 202
        wait_for_the_pass(client)
        assert seen["watched"] == [FareWatch(origin="LIM", destination="SCL", month="2027-03")]
        assert not hasattr(seen["watched"][0], "focus")


def test_the_collect_endpoint_runs_the_schedule_unless_it_is_told_not_to(monkeypatch):
    """
    12.111 is still the default here — `a-press-collects-the-month-it-is-on`
    only adds a way to say otherwise, and a body that says nothing gets exactly
    what it got before.

    A call with no `force` runs the cadence and reports what it declined, which
    is what stops a press that collected nothing from looking like a broken
    button. This is the scheduled and command-line shape of the endpoint, and it
    is asserted rather than assumed because the whole safety of the change rests
    on the default not having moved.
    """
    seen, fake = stub_pass(skipped=[("LIM-SCL 2027-03-01", "not-due")])
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        answer = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        assert answer.status_code == 202
        finished = wait_for_the_pass(client)

    assert seen["force"] is False
    assert finished["skipped"] == [{"what": "LIM-SCL 2027-03-01", "reason": "not-due"}]


def test_a_forced_press_reaches_the_collector_as_every_month_of_one_route(monkeypatch):
    """
    `a-press-collects-the-month-it-is-on`, widened by
    `a-watch-is-a-pair-and-its-months`.

    The reader pressed a control on one row, and a row is a city pair and every
    month of it — so what arrives at the collector is one watch per month, with
    the flag set. The endpoint is what carries it, so this is where the wire
    word and the collector's parameter are pinned to each other.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        answer = client.post(
            "/api/fares/collect",
            json={
                "routes": [
                    {"origin": "lim", "destination": "scl", "month": "2027-03"},
                    {"origin": "lim", "destination": "scl", "month": "2027-04"},
                ],
                "force": True,
            },
        )
        assert answer.status_code == 202
        wait_for_the_pass(client)

    assert seen["force"] is True
    assert seen["watched"] == [
        FareWatch(origin="LIM", destination="SCL", month="2027-03"),
        FareWatch(origin="LIM", destination="SCL", month="2027-04"),
    ]


def test_a_forced_press_covers_one_city_pair_and_is_refused_anything_wider(monkeypatch):
    """
    The narrowing 12.212's cost argument turns on, restated for a wider watch.

    This asserted "exactly one route entry" and meant "one city pair" — the two
    were the same thing only while a watch was one month, and they stopped being
    the same when a press started sending every month of a row. The line moves
    to where `collect_calendars` has always drawn it (`if force and len(pairs) >
    1`), so both layers now say *pair* rather than disagreeing about it.

    What retires with the old wording is the price. 12.212 costed a press at
    thirty-one board requests at the very most; twelve months of one pair is
    ~372, which is more than the busiest day this address has ever sent. That
    bound is not this endpoint's any more — what holds it is the pace and the
    pass lock, plus the horizon, which is why the months-per-pair ceiling below
    is derived from the horizon rather than chosen.

    The same bodies without the flag are still accepted: what is bounded is the
    *forced* press.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)
    two_pairs = [
        {"origin": "LIM", "destination": "SCL", "month": "2027-03"},
        {"origin": "LIM", "destination": "CUZ", "month": "2027-04"},
    ]
    two_months = [
        {"origin": "LIM", "destination": "SCL", "month": "2027-03"},
        {"origin": "LIM", "destination": "SCL", "month": "2027-04"},
    ]

    with TestClient(app) as client:
        refused = client.post("/api/fares/collect", json={"routes": two_pairs, "force": True})
        assert refused.status_code == 400
        assert "one city pair" in refused.json()["detail"]

        # Two months of one pair is the case that used to be refused and is now
        # the whole point of the change.
        allowed = client.post("/api/fares/collect", json={"routes": two_months, "force": True})
        assert allowed.status_code == 202
        wait_for_the_pass(client)
        assert seen["force"] is True
        assert len(seen["watched"]) == 2

        unforced = client.post("/api/fares/collect", json={"routes": two_pairs})
        assert unforced.status_code == 202
        wait_for_the_pass(client)
        assert seen["force"] is False
        assert len(seen["watched"]) == 2


def test_more_months_than_the_horizon_reaches_is_refused(monkeypatch):
    """
    The ceiling that replaced the flat cap on entries, and why it is twelve.

    A departure past `MAX_DEPARTURE_HORIZON_DAYS` cannot be collected at all,
    and 330 days touches at most twelve calendar months — so a thirteenth month
    on one pair is not an expensive request, it is a request for departures the
    provider does not have. The refusal names the pair and the reason, because a
    client that cannot say which row was too wide cannot show the reader.
    """
    _, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    def months(count: int) -> list[dict[str, str]]:
        # Rolled into the next year rather than counted past twelve: `2027-13`
        # is refused by `RouteBody`'s own pattern as a 422, which would test the
        # model rather than the ceiling this test is about.
        return [
            {
                "origin": "LIM",
                "destination": "SCL",
                "month": f"{2027 + index // 12}-{index % 12 + 1:02d}",
            }
            for index in range(count)
        ]

    with TestClient(app) as client:
        refused = client.post("/api/fares/collect", json={"routes": months(13)})
        assert refused.status_code == 400
        detail = refused.json()["detail"]
        assert "LIM-SCL" in detail and "13 months" in detail

        allowed = client.post("/api/fares/collect", json={"routes": months(12)})
        assert allowed.status_code == 202
        wait_for_the_pass(client)


def test_an_unforced_body_may_carry_more_entries_than_months_in_a_year(monkeypatch):
    """
    The flat cap on entries is gone, and its absence is pinned.

    `MAX_COLLECT_MONTHS` counted routes while being named for months, and once
    one entry stopped meaning one month it bounded neither. It also refused over
    HTTP what `scripts/fares-collect.py` hands the collector by hand every
    fifteen minutes — the whole watchlist at once — which is a bound on the wire
    rather than on the work.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)
    wide = [
        {"origin": origin, "destination": "SCL", "month": f"2027-{index:02d}"}
        for origin in ("LIM", "CUZ", "AQP")
        for index in range(1, 6)
    ]

    with TestClient(app) as client:
        answer = client.post("/api/fares/collect", json={"routes": wide})
        assert answer.status_code == 202
        wait_for_the_pass(client)

    assert len(seen["watched"]) == 15


def test_a_pass_names_every_month_it_covers_and_names_each_one_once(monkeypatch):
    """
    What the client matches on, and the one way it can be lied to.

    `watching` is how a row decides whether the pass in hand is its own, so a
    body that repeats a month must not have the pass name it twice: `expand`
    collapses the repeat into one set of departures, and a document naming it
    twice would promise work no result will ever arrive for. Order is the order
    sent, because that is the order the day is spent down in.
    """
    _, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        answer = client.post(
            "/api/fares/collect",
            json={
                "routes": [
                    {"origin": "AEP", "destination": "SCL", "month": "2027-03"},
                    {"origin": "AEP", "destination": "SCL", "month": "2027-04"},
                    {"origin": "AEP", "destination": "SCL", "month": "2027-03"},
                ],
                "force": True,
            },
        )
        assert answer.status_code == 202
        finished = wait_for_the_pass(client)

    assert finished["watching"] == ["AEP-SCL 2027-03", "AEP-SCL 2027-04"]


def test_five_impatient_presses_start_one_pass(monkeypatch):
    """
    The hazard 12.212 named, measured rather than reasoned about.

    A forced press is ninety-odd seconds of paced requests behind a control that
    answers instantly, so the reader who clicks five times waiting for something
    to happen is the ordinary case rather than the perverse one. Five presses
    here, all forced, all inside one running pass: `collect_due` is entered
    once, so the day is charged for one month and not five.

    Pressed straight at the endpoint, past the browser. The row's own guards —
    a synchronous in-flight ref and a disabled button — are real and are tested
    on the web side, and they are not what makes this safe: a second tab defeats
    both. `CollectionRunner`'s single slot is what cannot be defeated, and this
    is the test of that slot rather than of the button.
    """
    entered: list[bool] = []
    release = asyncio.Event()

    async def slow_collect_due(watched, **kwargs):
        entered.append(bool(kwargs.get("force")))
        observer = kwargs.get("observer")
        if observer is not None:
            observer.planned(polling=31, skipped=[])
        await release.wait()
        return CollectionReport(
            started_at="2026-08-19T14:00:00+00:00",
            finished_at="2026-08-19T14:01:33+00:00",
            source="google-flights",
            results=[],
            skipped=[],
        )

    monkeypatch.setattr(collection_job, "collect_due", slow_collect_due)
    body = {
        "routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}],
        "force": True,
    }

    with TestClient(app) as client:
        answers = [client.post("/api/fares/collect", json=body) for _ in range(5)]
        assert [answer.status_code for answer in answers] == [202] * 5
        # Every one of them is answered with a document, and it is the *same*
        # pass: a caller cannot tell it was refused except by the fact that the
        # pass it was handed started before it pressed.
        started = {answer.json()["startedAt"] for answer in answers}
        assert len(started) == 1
        assert all(answer.json()["state"] == "running" for answer in answers)

        release.set()
        wait_for_the_pass(client)

    assert entered == [True]


def test_airports_endpoint_resolves_requested_waypoints_from_the_reference_catalog(
    monkeypatch, tmp_path
):
    """
    A stop is not necessarily an airport we searched directly, so it is absent
    from the archive's endpoint catalogue.  The optional codes parameter fills
    only that gap from the bundled, worldwide IATA coordinate reference.
    """
    monkeypatch.setattr(fares_router, "HISTORY", FareHistory(tmp_path))

    body = TestClient(app).get("/api/fares/airports?codes=BOG&codes=unknown").json()

    assert body["airports"] == [
        {
            "code": "BOG",
            "name": None,
            "city": None,
            "country": None,
            "latitude": 4.70159,
            "longitude": -74.1469,
        }
    ]


def test_the_history_endpoint_narrows_a_month_or_a_single_day(monkeypatch, tmp_path):
    """
    `departure` is a prefix — 12.112. `2027-03` selects the month a route is
    now watched by and `2027-03-09` still selects one departure, because these
    keys are `YYYY-MM-DD` and truncate the way the calendar does.
    """
    from app.adapters.fares.models import PricePoint

    history = FareHistory(tmp_path)
    for departure, price in (("2027-03-09", 210.0), ("2027-03-10", 240.0), ("2027-04-02", 900.0)):
        history.merge_baseline(
            "LIM", "SCL", departure, [PricePoint("2026-08-18", price)], source="s", currency="USD"
        )
    monkeypatch.setattr(fares_router, "HISTORY", history)
    client = TestClient(app)

    march = client.get("/api/fares/history?origin=LIM&destination=SCL&departure=2027-03")
    assert [point["price"] for point in march.json()["baseline"]] == [210.0, 240.0]

    ninth = client.get("/api/fares/history?origin=LIM&destination=SCL&departure=2027-03-09")
    assert [point["price"] for point in ninth.json()["baseline"]] == [210.0]


def test_a_baseline_figure_says_which_departure_it_priced(monkeypatch, tmp_path):
    """
    12.171. A watched month brings back one of these series per departure, so
    the same observation date arrives thirty-one times with thirty-one prices.
    Without the departure beside it the client cannot tell those rows apart —
    and cannot work out how far ahead of the flight any of them was quoted,
    which is the whole of what a lead-time axis is drawn on.
    """
    from app.adapters.fares.models import PricePoint

    history = FareHistory(tmp_path)
    for departure, price in (("2027-03-09", 210.0), ("2027-03-10", 240.0)):
        history.merge_baseline(
            "LIM", "SCL", departure, [PricePoint("2026-08-18", price)], source="s", currency="USD"
        )
    monkeypatch.setattr(fares_router, "HISTORY", history)

    baseline = (
        TestClient(app)
        .get("/api/fares/history?origin=LIM&destination=SCL&departure=2027-03")
        .json()["baseline"]
    )
    assert [(point["flightDate"], point["date"]) for point in baseline] == [
        ("2027-03-09", "2026-08-18"),
        ("2027-03-10", "2026-08-18"),
    ]
