"""
Asking for one city pair's curve over HTTP, and being told how it went.

The collection itself is tested next door in `test_fares_calendar.py`, which
owns the request bytes, the parser and the store. This file owns the thing built
on top of it: an endpoint that starts a pass and answers immediately, so the
press that adds a route to the watchlist can also fill in the eleven months the
reader did not pick without holding a `fetch` open while it happens.

Three behaviours carry most of the weight here, and each is easy to get subtly
wrong in a way that still looks healthy:

- **A pair collected an hour ago is skipped, and the answer says so.** That is
  the schedule working, not the endpoint failing, and it must not be reported as
  a collection that found nothing.
- **A provider refusal finishes the pass.** The pass falling over and a provider
  saying no are different events with different fixes, so they are different
  states — the refusal travels in `results` with its code.
- **A second press joins the pass that is running.** The gap in `fare_collector`
  paces one loop, and `watching` is the only thing that tells a caller its own
  press was answered rather than served.

Nothing here touches the network: every upstream answer comes from an
`httpx.MockTransport`, and every store writes into `tmp_path`.
"""

import asyncio
import time
from datetime import UTC, datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import fares as fares_router
from app.services import calendar_job, fare_collector
from app.services.fare_calendar import FareCalendar
from app.services.fare_collector import CalendarReport, CalendarResult, FareWatch

PAIR = {"origin": "LIM", "destination": "CUZ"}


@pytest.fixture(autouse=True)
def a_calendar_runner_with_no_history():
    """
    One pass slot serves the whole process, so it has to be emptied between
    tests. Without this a test that asserts on the idle state passes or fails
    according to which test ran before it.
    """
    calendar_job.CALENDAR_RUNNER.forget()
    yield
    calendar_job.CALENDAR_RUNNER.forget()


def mock_upstream(monkeypatch, handler):
    """
    Put a client with no socket behind it where the shared fares client lives.

    Set on the module global rather than by replacing `get_client`, so the
    router reaches it by exactly the path it reaches the real one by — and so
    the app's own shutdown closes it, which is the ordering this endpoint
    depends on.
    """
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(fares_router, "_client", client)
    return client


def stub_pass(results=None, skipped=None):
    """A collector that reaches nothing and reports what it was handed."""
    seen: dict[str, object] = {}

    async def fake_collect_calendars(watched, **kwargs):
        seen["watched"] = watched
        seen["provider"] = kwargs.get("provider")
        seen["client"] = kwargs.get("client")
        return CalendarReport(
            started_at="2026-08-19T14:00:00+00:00",
            finished_at="2026-08-19T14:00:03+00:00",
            source="google-flights",
            results=list(results or []),
            skipped=list(skipped or []),
        )

    return seen, fake_collect_calendars


def wait_for_the_pass(client, timeout=5.0):
    """
    Poll `GET /calendar/collect` until the pass stops running, and return it.

    A press is answered before the work is done, so a test that asserted on the
    POST's body alone would be asserting about a pass that had not started yet.
    This is the same thing the browser does, and testing it the way the client
    uses it is the point.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        answer = client.get("/api/fares/calendar/collect")
        assert answer.status_code == 200
        body = answer.json()
        if body["state"] != "running":
            return body
        time.sleep(0.01)
    raise AssertionError("the calendar pass never finished")


# --- the slot ----------------------------------------------------------------


def test_two_watches_on_one_pair_are_named_once_because_they_are_one_curve():
    """
    A curve covers every month at once, so `collect_calendars` is keyed by city
    pair. Naming a pair twice would promise a caller two results it is never
    going to get, and the order is kept so two passes can be compared by eye.
    """
    assert calendar_job._watching(
        [
            FareWatch("LIM", "CUZ", "2027-03"),
            FareWatch("LIM", "CUZ", "2027-04"),
            FareWatch("ARI", "SCL", "2027-03"),
        ]
    ) == ["LIM-CUZ", "ARI-SCL"]


# --- the endpoint ------------------------------------------------------------


def test_no_calendar_pass_has_ever_run_is_an_answer_rather_than_a_404():
    """
    A fresh install has never collected a curve, and that is an ordinary state.
    Answering 404 would make every client special-case a failure to describe a
    machine that is simply idle.
    """
    with TestClient(app) as client:
        body = client.get("/api/fares/calendar/collect").json()
    assert body["state"] == "idle"
    assert body["startedAt"] is None
    assert body["watching"] == []
    assert body["results"] == [] and body["skipped"] == []


def test_a_press_is_answered_before_the_curve_it_asked_for_is_collected(monkeypatch):
    """
    The press returns 202 and a `running` document, not a finished report.

    Two paced requests is a few seconds when the upstream answers and is
    unbounded when it does not, and a curve that only gets stored if a `fetch`
    outlasts it is a curve whose collection is decided by a client timeout.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(calendar_job, "collect_calendars", fake)

    with TestClient(app) as client:
        answer = client.post("/api/fares/calendar/collect", json=PAIR)
        assert answer.status_code == 202
        assert answer.json()["state"] == "running"
        assert answer.json()["watching"] == ["LIM-CUZ"]
        assert answer.json()["finishedAt"] is None
        finished = wait_for_the_pass(client)

    assert finished["state"] == "finished"
    assert finished["finishedAt"] is not None
    assert [(w.origin, w.destination) for w in seen["watched"]] == [("LIM", "CUZ")]


def test_a_finished_pass_reports_the_curve_it_found_field_for_field(monkeypatch):
    """
    Every figure the client draws with, pinned on the wire in camelCase.

    `dates` and `priced` are separate because a horizon that came back with
    nothing to sell on any day is a real answer and must not read like a
    horizon we never reached.
    """
    result = CalendarResult(
        origin="LIM",
        destination="CUZ",
        ok=True,
        changed=True,
        dates=331,
        priced=329,
        cheapest=40.97,
        cheapest_on="2026-12-18",
        currency="USD",
        requests=2,
    )
    _, fake = stub_pass(results=[result])
    monkeypatch.setattr(calendar_job, "collect_calendars", fake)

    with TestClient(app) as client:
        client.post("/api/fares/calendar/collect", json=PAIR)
        finished = wait_for_the_pass(client)

    assert finished["completed"] == 1
    assert finished["collected"] == 1 and finished["changed"] == 1 and finished["failed"] == 0
    assert finished["results"] == [
        {
            "origin": "LIM",
            "destination": "CUZ",
            "ok": True,
            "changed": True,
            "dates": 331,
            "priced": 329,
            "cheapest": 40.97,
            "cheapestOn": "2026-12-18",
            "currency": "USD",
            "requests": 2,
            "errorCode": None,
            "errorMessage": None,
        }
    ]
    assert finished["error"] is None


def test_a_pair_collected_within_the_day_is_skipped_as_not_due_and_says_so(monkeypatch, tmp_path):
    """
    The schedule is run rather than bypassed, and the declining is reported.

    A fare eleven months out moves by a median 1.7% a day, so a second look ten
    minutes after the first would spend two requests to confirm the first. The
    row saying `not-due` is what stops a declined press from looking like a
    broken one — 8.8 and 8.41, on the endpoint rather than in the collector.
    """
    store = FareCalendar(tmp_path)
    store.record_check(
        "LIM",
        "CUZ",
        at=datetime.now(UTC).replace(microsecond=0).isoformat(),
        outcome="unchanged",
        dates=331,
    )
    monkeypatch.setattr(fare_collector, "CALENDAR", store)

    def refuse_to_be_asked(request: httpx.Request) -> httpx.Response:
        raise AssertionError("a pair that is not due must cost no requests")

    mock_upstream(monkeypatch, refuse_to_be_asked)

    with TestClient(app) as client:
        assert client.post("/api/fares/calendar/collect", json=PAIR).status_code == 202
        finished = wait_for_the_pass(client)

    assert finished["state"] == "finished"
    assert finished["results"] == []
    assert finished["skipped"] == [{"what": "LIM-CUZ", "reason": "not-due"}]


def test_a_provider_refusal_finishes_the_pass_and_carries_the_reason(monkeypatch, tmp_path):
    """
    A refused pair is not a failed pass, and the difference is what a reader
    does next: one is Google saying no to this route today, the other is this
    machine being broken. So the pass finishes, `failed` counts the pair, and
    the code travels on the row.
    """
    monkeypatch.setattr(fare_collector, "CALENDAR", FareCalendar(tmp_path))
    mock_upstream(monkeypatch, lambda request: httpx.Response(429))

    with TestClient(app) as client:
        client.post("/api/fares/calendar/collect", json=PAIR)
        finished = wait_for_the_pass(client)

    assert finished["state"] == "finished"
    assert finished["error"] is None
    assert finished["collected"] == 0 and finished["failed"] == 1
    assert finished["results"][0]["ok"] is False
    assert finished["results"][0]["errorCode"] == "rate-limited"
    assert finished["results"][0]["errorMessage"]
    # The heartbeat is written even so, which is what keeps a gap in the archive
    # readable as a recorded failure rather than as a stretch nobody can account
    # for.
    assert [row["outcome"] for row in FareCalendar(tmp_path).checks("LIM", "CUZ")] == ["error"]


def test_a_pass_that_falls_over_says_so_rather_than_running_forever(monkeypatch):
    """
    A background task that raises hands its exception to the event loop, where a
    caller polling for progress would see a pass that is running and always
    will be. A failure that is not reported is worse than one that is.
    """

    async def broken_collect_calendars(watched, **kwargs):
        raise RuntimeError("the archive volume went away")

    monkeypatch.setattr(calendar_job, "collect_calendars", broken_collect_calendars)

    with TestClient(app) as client:
        client.post("/api/fares/calendar/collect", json=PAIR)
        finished = wait_for_the_pass(client)

    assert finished["state"] == "failed"
    assert "the archive volume went away" in finished["error"]
    assert finished["finishedAt"] is not None


def test_a_second_press_while_a_pass_runs_is_answered_with_that_pass(monkeypatch):
    """
    The gap in `fare_collector` paces one loop, so two loops would halve it with
    nobody having decided to. The second press is answered with the pass that is
    already going, and `watching` is what says so: a caller whose own pair is
    missing from it knows it was answered rather than served.
    """
    started = asyncio.Event()
    release = asyncio.Event()
    calls: list[list] = []

    async def slow_collect_calendars(watched, **kwargs):
        calls.append(watched)
        started.set()
        await release.wait()
        return CalendarReport(
            started_at="2026-08-19T14:00:00+00:00",
            finished_at="2026-08-19T14:00:03+00:00",
            source="google-flights",
            results=[],
            skipped=[],
        )

    monkeypatch.setattr(calendar_job, "collect_calendars", slow_collect_calendars)

    with TestClient(app) as client:
        first = client.post("/api/fares/calendar/collect", json=PAIR)
        assert first.status_code == 202
        # Give the task a turn on the loop, so the second press meets a pass
        # that has genuinely begun rather than one still queued.
        deadline = time.monotonic() + 5.0
        while not started.is_set() and time.monotonic() < deadline:
            client.get("/api/fares/calendar/collect")
            time.sleep(0.01)
        assert started.is_set()

        second = client.post(
            "/api/fares/calendar/collect",
            json={"origin": "ARI", "destination": "SCL"},
        )
        assert second.status_code == 202
        # Somebody else's pass, and the document says whose.
        assert second.json()["state"] == "running"
        assert second.json()["watching"] == ["LIM-CUZ"]

        release.set()
        wait_for_the_pass(client)

    assert len(calls) == 1


def test_the_codes_are_normalised_and_the_currency_defaults_before_the_pass(monkeypatch):
    """
    What the caller typed is normalised once, here, rather than by whichever
    store happens to be written to first — a pair stored as `lim-cuz` would sit
    beside `LIM-CUZ` in the archive as a second route nobody watches.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(calendar_job, "collect_calendars", fake)

    with TestClient(app) as client:
        answer = client.post(
            "/api/fares/calendar/collect",
            json={"origin": "lim", "destination": "cuz"},
        )
        assert answer.json()["watching"] == ["LIM-CUZ"]
        wait_for_the_pass(client)

    watch = seen["watched"][0]
    assert (watch.origin, watch.destination) == ("LIM", "CUZ")
    assert watch.currency == "USD"


def test_the_currency_the_caller_names_travels_to_the_collector(monkeypatch):
    """A curve is a column of numbers, and a column in two currencies is a lie."""
    seen, fake = stub_pass()
    monkeypatch.setattr(calendar_job, "collect_calendars", fake)

    with TestClient(app) as client:
        client.post("/api/fares/calendar/collect", json={**PAIR, "currency": "pen"})
        wait_for_the_pass(client)

    assert seen["watched"][0].currency == "PEN"


def test_a_code_that_is_not_three_letters_is_a_422_and_not_a_pass(monkeypatch):
    """
    Refused before anything starts, so a typo costs nothing and says what it
    was — the same validation the board collect body applies.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(calendar_job, "collect_calendars", fake)

    with TestClient(app) as client:
        answer = client.post("/api/fares/calendar/collect", json={**PAIR, "destination": "CUZCO"})
        assert answer.status_code == 422
        assert client.get("/api/fares/calendar/collect").json()["state"] == "idle"

    assert "watched" not in seen


def test_an_unknown_provider_is_refused_rather_than_quietly_collected_from(monkeypatch):
    """Same 400 as the board endpoint: there is nothing sensible to fall back to."""
    seen, fake = stub_pass()
    monkeypatch.setattr(calendar_job, "collect_calendars", fake)

    with TestClient(app) as client:
        answer = client.post("/api/fares/calendar/collect?provider=kayak", json=PAIR)
        assert answer.status_code == 400
        assert client.get("/api/fares/calendar/collect").json()["state"] == "idle"

    assert "watched" not in seen


def test_collecting_a_curve_and_reading_one_are_two_different_endpoints(monkeypatch, tmp_path):
    """
    `/calendar` and `/calendar/collect` are both literal paths, so the shorter
    one never swallows the longer. Pinned because the day somebody adds a
    parameterised route under `/calendar` the failure would be a 422 about a
    route code rather than a missing endpoint.
    """
    monkeypatch.setattr(fares_router, "CALENDAR", FareCalendar(tmp_path))

    with TestClient(app) as client:
        read = client.get("/api/fares/calendar?origin=LIM&destination=CUZ")
        assert read.status_code == 200
        assert read.json()["latest"] is None
        assert client.get("/api/fares/calendar/collect").json()["state"] == "idle"
