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
import re
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import fares as fares_router
from app.services import calendar_job, fare_collector
from app.services.fare_calendar import CalendarCurve, CalendarPrice, FareCalendar
from app.services.fare_collector import CalendarReport, CalendarResult, FareWatch

PAIR = {"origin": "LIM", "destination": "CUZ"}

#: The two captures next door, borrowed rather than re-recorded: a real answer
#: and the same endpoint refusing a range. Only one test here needs a pass that
#: actually parses something, and it needs both.
FIXTURES = Path(__file__).parent / "fixtures"
CAPTURE = "google_flights_calendar_lim_cuz.txt"
REFUSAL = "google_flights_calendar_refused.txt"


def read_calendar_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


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


def a_store_holding_one_curve(tmp_path, monkeypatch, *, with_curve=True):
    """
    A calendar store both the collector and the endpoint reach.

    Both have to be pointed at it: the collector reads it to decide whether a
    pair is due, and the endpoint reads it to decide whether the pair has
    anything on disk at all. Patching only one leaves the two disagreeing about
    what is stored, which is the arrangement the exception below turns on.
    """
    store = FareCalendar(tmp_path)
    if with_curve:
        store.append(
            CalendarCurve(
                captured_at=datetime.now(UTC).replace(microsecond=0).isoformat(),
                source="google-flights",
                origin="LIM",
                destination="CUZ",
                currency="USD",
                start="2026-08-19",
                end="2026-08-20",
                prices=[CalendarPrice(departure_date="2026-08-19", price=61.5)],
            )
        )
    monkeypatch.setattr(fare_collector, "CALENDAR", store)
    monkeypatch.setattr(fares_router, "CALENDAR", store)
    return store


def test_a_pair_collected_within_the_day_is_skipped_as_not_due_and_says_so(monkeypatch, tmp_path):
    """
    The schedule is run rather than bypassed, and the declining is reported.

    A fare eleven months out moves by a median 1.7% a day, so a second look ten
    minutes after the first would spend two requests to confirm the first. The
    row saying `not-due` is what stops a declined press from looking like a
    broken one — 8.8 and 8.41, on the endpoint rather than in the collector.
    """
    store = a_store_holding_one_curve(tmp_path, monkeypatch)
    store.record_check(
        "LIM",
        "CUZ",
        at=datetime.now(UTC).replace(microsecond=0).isoformat(),
        outcome="unchanged",
        dates=331,
    )

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


def test_the_pass_document_counts_windows_and_requests_separately(monkeypatch, tmp_path):
    """
    What a row draws a bar from, and why it is two numbers rather than one.

    A pass that met a refused far end spends more requests than it prices
    windows — measured live at three requests over twenty seconds for two
    windows. A document that reported only one of those figures could not tell a
    reader whether the extra time was a retry or a hang.
    """
    monkeypatch.setattr(fare_collector, "CALENDAR", FareCalendar(tmp_path))

    def refuse_the_far_end_once(request: httpx.Request) -> httpx.Response:
        body = request.content.decode("utf-8")
        end = re.findall(r"\d{4}-\d{2}-\d{2}", body)[-1]
        horizon = (datetime.now(UTC).date() + timedelta(days=329)).isoformat()
        if end > horizon:
            return httpx.Response(200, text=read_calendar_fixture(REFUSAL))
        return httpx.Response(200, text=read_calendar_fixture(CAPTURE))

    mock_upstream(monkeypatch, refuse_the_far_end_once)

    with TestClient(app) as client:
        client.post("/api/fares/calendar/collect", json=PAIR)
        # Longer than the default wait on purpose: this is the only test here
        # that runs a pass through the real `REQUEST_GAP_SECONDS` three times,
        # which is two paced waits and about six seconds. That pacing is the
        # thing being described, so it is waited out rather than patched away.
        finished = wait_for_the_pass(client, timeout=20.0)

    assert finished["state"] == "finished"
    assert finished["windows"] == 2
    assert finished["windowsPriced"] == 2
    assert finished["requests"] == 3
    assert finished["dates"] > 0


def test_before_anything_has_run_the_progress_figures_are_a_plan_nobody_has_made(monkeypatch):
    """
    `windows` is null while idle, not zero.

    Zero is a settled plan with nothing in it. Null is no plan at all, and a bar
    must be able to tell them apart — the same contract `CollectResponse.polling`
    keeps for the board pass.
    """
    document = TestClient(app).get("/api/fares/calendar/collect").json()
    assert document["state"] == "idle"
    assert document["windows"] is None
    assert (document["windowsPriced"], document["requests"], document["dates"]) == (0, 0, 0)


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
        assert read.json()["horizon"] is None
        assert client.get("/api/fares/calendar/collect").json()["state"] == "idle"


def test_a_pair_with_nothing_on_disk_is_collected_even_after_a_look_that_failed(
    monkeypatch, tmp_path
):
    """
    The exception to the cadence, and the reason it exists is a real refusal.

    Staleness is measured from the last *look* and a look that failed counts, so
    the first collection of a brand-new route being refused once left that route
    with nothing to draw and no second attempt for a day. That happened the
    first time this endpoint was pointed at the live provider. A pair with no
    curve on disk has nothing for the cadence to protect, so it is always due —
    and the pass is attempted rather than skipped.
    """
    store = a_store_holding_one_curve(tmp_path, monkeypatch, with_curve=False)
    store.record_check(
        "LIM",
        "CUZ",
        at=datetime.now(UTC).replace(microsecond=0).isoformat(),
        outcome="error",
        error_code="upstream-error",
    )
    assert store.latest("LIM", "CUZ") is None

    asked: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return httpx.Response(429)

    mock_upstream(monkeypatch, answer)

    with TestClient(app) as client:
        assert client.post("/api/fares/calendar/collect", json=PAIR).status_code == 202
        finished = wait_for_the_pass(client)

    assert asked, "a pair with nothing on disk must actually be asked about"
    assert finished["skipped"] == []
    assert [result["ok"] for result in finished["results"]] == [False]


def test_the_exception_is_about_emptiness_and_not_about_pressing_harder(monkeypatch, tmp_path):
    """
    A pair that already has a curve waits for the cadence unless asked to force.

    Otherwise the exception would be a way to spend two requests per press on a
    route whose year of prices moves by under 2% a day, which is the thing the
    cadence exists to refuse. This posts no `force`, which is the ordinary
    request and the one every existing caller sends — the second way in below is
    a flag a caller has to name, not a change to what emptiness means here.
    """
    store = a_store_holding_one_curve(tmp_path, monkeypatch)
    # A curve on disk and a look that wrote it — the ordinary state of a pair
    # collected today, which is what the cadence is measured against.
    store.record_check(
        "LIM",
        "CUZ",
        at=datetime.now(UTC).replace(microsecond=0).isoformat(),
        outcome="changed",
        dates=331,
    )

    def refuse_to_be_asked(request: httpx.Request) -> httpx.Response:
        raise AssertionError("a pair that already has a curve must cost no requests")

    mock_upstream(monkeypatch, refuse_to_be_asked)

    with TestClient(app) as client:
        assert client.post("/api/fares/calendar/collect", json=PAIR).status_code == 202
        finished = wait_for_the_pass(client)

    assert finished["skipped"] == [{"what": "LIM-CUZ", "reason": "not-due"}]


def test_a_forced_press_collects_a_curve_the_cadence_had_already_declined(monkeypatch, tmp_path):
    """
    The second way in, and the one this endpoint had no version of at all.

    `POST /api/fares/collect` has taken `force` since 12.212 —
    `a-press-collects-the-month-it-is-on` — because a control that answers "not
    due" to somebody who has just said they do not believe the last look reads
    as broken. The curve had exactly the shape that decision was about, with one
    escape hatch that only opens for a pair with *nothing* on disk: a pair
    collected an hour ago was `not-due` however it was asked, so a reader
    doubting a twenty-hour-old year of prices had no control at all.

    Nothing else moves. This posts one city pair, which is all the body can
    carry, and the cadence still governs every caller that does not name the
    flag.
    """
    page = read_calendar_fixture(CAPTURE)
    store = a_store_holding_one_curve(tmp_path, monkeypatch)
    store.record_check(
        "LIM",
        "CUZ",
        at=datetime.now(UTC).replace(microsecond=0).isoformat(),
        outcome="changed",
        dates=331,
    )

    asked: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return httpx.Response(200, text=page)

    mock_upstream(monkeypatch, answer)

    with TestClient(app) as client:
        pressed = client.post("/api/fares/calendar/collect", json={**PAIR, "force": True})
        assert pressed.status_code == 202
        finished = wait_for_the_pass(client)

    assert asked, "a forced press must actually reach the provider"
    assert finished["state"] == "finished"
    assert finished["skipped"] == []
    assert [result["ok"] for result in finished["results"]] == [True]


def test_the_pass_a_forced_press_starts_is_the_one_it_is_answered_with(monkeypatch):
    """
    `force` travels to the collector rather than being read and dropped here.

    Asserted on the collector's own keyword because the flag is worth nothing
    until it reaches the line that compares `due` against `CALENDAR_POLL_MINUTES`
    — a router that validated it and then started an ordinary pass would answer
    202 and collect nothing, which is the failure that is hardest to see from
    outside.
    """
    seen, fake = stub_pass()
    forced: dict[str, object] = {}

    async def remember_force(watched, **kwargs):
        forced["force"] = kwargs.get("force")
        return await fake(watched, **kwargs)

    monkeypatch.setattr(calendar_job, "collect_calendars", remember_force)

    with TestClient(app) as client:
        client.post("/api/fares/calendar/collect", json={**PAIR, "force": True})
        wait_for_the_pass(client)

    assert seen["watched"][0].origin == "LIM"
    assert forced["force"] is True


def test_an_unforced_press_is_the_default_and_stays_on_the_schedule(monkeypatch):
    """
    A body with no `force` in it reaches the collector as `False`.

    The load-bearing half of 12.212's shape: the scheduled script, the command
    line and every client written before this flag existed all still run the
    cadence, so what was added is a second way in rather than a weakening of the
    first.
    """
    _, fake = stub_pass()
    forced: dict[str, object] = {}

    async def remember_force(watched, **kwargs):
        forced["force"] = kwargs.get("force")
        return await fake(watched, **kwargs)

    monkeypatch.setattr(calendar_job, "collect_calendars", remember_force)

    with TestClient(app) as client:
        client.post("/api/fares/calendar/collect", json=PAIR)
        wait_for_the_pass(client)

    assert forced["force"] is False
