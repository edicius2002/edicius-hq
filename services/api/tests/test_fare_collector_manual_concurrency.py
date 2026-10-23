"""Manual board collection overlaps slow dates without changing pass accounting."""

import asyncio
from datetime import UTC, datetime
from itertools import pairwise

import httpx
import pytest

from app.adapters.fares.models import FareQuery
from app.services import fare_collector
from app.services.fare_budget import PassLock, RequestLedger, daily_budget
from app.services.fare_collector import RouteResult


def queries(count: int) -> list[FareQuery]:
    return [
        FareQuery("LIM", "CUZ", f"2026-11-{day:02d}", None, "USD") for day in range(1, count + 1)
    ]


def allowance(tmp_path, ceiling: int):
    ledger = RequestLedger(tmp_path / "spend")
    budget = daily_budget(ceiling=ceiling, ledger=ledger, now=datetime(2026, 8, 21, tzinfo=UTC))
    return budget, ledger


def result(query: FareQuery, *, ok: bool = True) -> RouteResult:
    return RouteResult(
        query.origin,
        query.destination,
        query.flight_date,
        query.return_date,
        ok,
        error_code=None if ok else "upstream-error",
    )


def test_manual_collection_bounds_flights_and_keeps_report_in_departure_order(
    monkeypatch, tmp_path
):
    entered = [asyncio.Event() for _ in range(3)]
    release = [asyncio.Event() for _ in range(3)]
    completed: list[str] = []

    async def fetch(_session, query, _provider, _store):
        index = int(query.flight_date[-2:]) - 1
        entered[index].set()
        await release[index].wait()
        return result(query), None

    class Observer:
        def collected(self, value, _snapshot):
            completed.append(value.flight_date)

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    budget, ledger = allowance(tmp_path, 3)

    async def scenario():
        async with httpx.AsyncClient() as client:
            task = asyncio.create_task(
                fare_collector.collect(
                    queries(3),
                    client=client,
                    history=object(),
                    gap_seconds=0,
                    observer=Observer(),
                    budget=budget,
                    max_in_flight=2,
                )
            )
            await asyncio.wait_for(asyncio.gather(entered[0].wait(), entered[1].wait()), 1)
            assert not entered[2].is_set()
            assert ledger.spent(budget.day) == 2  # reserved before either provider reply
            release[1].set()
            await asyncio.wait_for(entered[2].wait(), 1)
            release[2].set()
            await asyncio.sleep(0)
            release[0].set()
            return await asyncio.wait_for(task, 1)

    report = asyncio.run(scenario())
    assert [item.flight_date for item in report.results] == [
        "2026-11-01",
        "2026-11-02",
        "2026-11-03",
    ]
    assert completed[0] == "2026-11-02"
    assert ledger.spent(budget.day) == 3


def test_manual_collection_retains_per_date_failure_and_skips_unreserved_dates(
    monkeypatch, tmp_path
):
    async def fetch(_session, query, _provider, _store):
        return result(query, ok=query.flight_date != "2026-11-02"), None

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    budget, ledger = allowance(tmp_path, 2)

    async def scenario():
        async with httpx.AsyncClient() as client:
            return await fare_collector.collect(
                queries(4),
                client=client,
                history=object(),
                gap_seconds=0,
                budget=budget,
                max_in_flight=2,
            )

    report = asyncio.run(scenario())
    assert [(item.flight_date, item.ok, item.error_code) for item in report.results] == [
        ("2026-11-01", True, None),
        ("2026-11-02", False, "upstream-error"),
    ]
    assert report.skipped == [
        ("LIM-CUZ 2026-11-03", "over-budget"),
        ("LIM-CUZ 2026-11-04", "over-budget"),
    ]
    assert ledger.spent(budget.day) == 2


def test_manual_collection_rechecks_budget_after_waiting_for_shared_pacer(monkeypatch, tmp_path):
    waiting = asyncio.Event()
    release = asyncio.Event()
    fetched: list[str] = []

    class Pacer:
        calls = 0

        async def wait(self, *, gap_seconds, before_start):
            assert gap_seconds == 3
            self.calls += 1
            if self.calls == 2:
                waiting.set()
                await release.wait()
            return before_start()

    async def fetch(_session, query, _provider, _store):
        fetched.append(query.flight_date)
        return result(query), None

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    budget, ledger = allowance(tmp_path, 2)

    async def scenario():
        async with httpx.AsyncClient() as client:
            task = asyncio.create_task(
                fare_collector.collect(
                    queries(2),
                    client=client,
                    history=object(),
                    gap_seconds=3,
                    pacer=Pacer(),
                    budget=budget,
                    max_in_flight=2,
                )
            )
            await asyncio.wait_for(waiting.wait(), 1)
            ledger.spend(budget.day, kind="calendar", what="another pass")
            release.set()
            return await asyncio.wait_for(task, 1)

    report = asyncio.run(scenario())
    assert fetched == ["2026-11-01"]
    assert [item.flight_date for item in report.results] == ["2026-11-01"]
    assert report.skipped == [("LIM-CUZ 2026-11-02", "over-budget")]
    assert ledger.spent(budget.day) == 2


def test_slow_budget_write_cannot_compress_google_start_gap(monkeypatch, tmp_path):
    class Clock:
        now = 0.0

        def monotonic(self):
            return self.now

        async def sleep(self, seconds):
            self.now += seconds

    clock = Clock()
    starts: list[float] = []

    async def fetch(_session, query, _provider, _store):
        starts.append(clock.now)
        return result(query), None

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    budget, _ledger = allowance(tmp_path, 2)
    original_take = budget.take

    def slow_take(*, kind, what, pass_id=None):
        clock.now += 4.0  # Synchronous ledger work between a pace slot and a fetch.
        original_take(kind=kind, what=what, pass_id=pass_id)

    budget.take = slow_take

    async def scenario():
        async with httpx.AsyncClient() as client:
            await fare_collector.collect(
                queries(2),
                client=client,
                history=object(),
                gap_seconds=3,
                pacer=fare_collector.DeadlinePacer(clock=clock.monotonic, sleep=clock.sleep),
                budget=budget,
                max_in_flight=2,
            )

    asyncio.run(scenario())
    assert len(starts) == 2
    assert starts[1] - starts[0] >= 3.0


def test_one_slow_budget_write_cannot_compress_50ms_http_starts(monkeypatch, tmp_path):
    class Clock:
        now = 0.0

        def monotonic(self):
            return self.now

        async def sleep(self, seconds):
            self.now += seconds

    clock = Clock()
    starts: list[float] = []

    async def fetch(_session, query, _provider, _store):
        starts.append(clock.now)
        return result(query), None

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    budget, _ledger = allowance(tmp_path, 2)
    original_take = budget.take
    calls = 0

    def uneven_take(*, kind, what, pass_id=None):
        nonlocal calls
        calls += 1
        if calls == 1:
            clock.now += 0.2
        original_take(kind=kind, what=what, pass_id=pass_id)

    budget.take = uneven_take

    async def scenario():
        async with httpx.AsyncClient() as client:
            await fare_collector.collect(
                queries(2),
                client=client,
                history=object(),
                gap_seconds=0.05,
                pacer=fare_collector.DeadlinePacer(clock=clock.monotonic, sleep=clock.sleep),
                budget=budget,
                max_in_flight=16,
            )

    asyncio.run(scenario())
    assert len(starts) == 2
    assert starts[1] - starts[0] >= 0.05 - 1e-9


def test_one_remaining_budget_slot_does_not_reserve_an_unused_pacer_slot(monkeypatch, tmp_path):
    class Pacer:
        calls = 0

        async def wait(self, *, gap_seconds, before_start):
            del gap_seconds
            self.calls += 1
            return before_start()

    async def fetch(_session, query, _provider, _store):
        return result(query), None

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    budget, ledger = allowance(tmp_path, 1)
    pacer = Pacer()

    async def scenario():
        async with httpx.AsyncClient() as client:
            return await fare_collector.collect(
                queries(2),
                client=client,
                history=object(),
                gap_seconds=0,
                pacer=pacer,
                budget=budget,
                max_in_flight=2,
            )

    report = asyncio.run(scenario())
    assert pacer.calls == 1
    assert ledger.spent(budget.day) == 1
    assert [item.flight_date for item in report.results] == ["2026-11-01"]
    assert report.skipped == [("LIM-CUZ 2026-11-02", "over-budget")]


@pytest.mark.parametrize("slots", [2, 16])
def test_cancelling_manual_collection_drains_in_flight_dates(monkeypatch, tmp_path, slots):
    entered = asyncio.Event()
    cancelled: list[str] = []
    active = 0

    async def fetch(_session, query, _provider, _store):
        nonlocal active
        active += 1
        if active == slots:
            entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.append(query.flight_date)
            raise
        finally:
            active -= 1

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    ledger = RequestLedger(tmp_path / "spend")
    pass_lock = PassLock(tmp_path / "pass.lock")
    clients = []

    class Client:
        def __init__(self, *, timeout):
            del timeout
            self.closed = False
            clients.append(self)

        async def aclose(self):
            self.closed = True

    monkeypatch.setattr(fare_collector.httpx, "AsyncClient", Client)
    monkeypatch.setattr(
        fare_collector,
        "daily_budget",
        lambda **kwargs: daily_budget(
            ceiling=slots + 1,
            ledger=ledger,
            now=datetime(2026, 8, 21, tzinfo=UTC),
            lock=kwargs["lock"],
        ),
    )

    async def scenario():
        task = asyncio.create_task(
            fare_collector.collect(
                queries(slots + 1),
                history=object(),
                gap_seconds=0,
                lock=pass_lock,
                max_in_flight=slots,
            )
        )
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert active == 0
    assert set(cancelled) == {q.flight_date for q in queries(slots)}
    assert ledger.spent(datetime(2026, 8, 21, tzinfo=UTC).date()) == slots
    assert clients[0].closed
    assert not pass_lock.held()
    assert not pass_lock.path.exists()


def test_default_collection_stays_sequential(monkeypatch, tmp_path):
    entered = asyncio.Event()
    release = asyncio.Event()
    starts: list[str] = []

    async def fetch(_session, query, _provider, _store):
        starts.append(query.flight_date)
        entered.set()
        if len(starts) == 1:
            await release.wait()
        return result(query), None

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    budget, _ledger = allowance(tmp_path, 2)

    async def scenario():
        async with httpx.AsyncClient() as client:
            task = asyncio.create_task(
                fare_collector.collect(
                    queries(2), client=client, history=object(), gap_seconds=0, budget=budget
                )
            )
            await asyncio.wait_for(entered.wait(), 1)
            await asyncio.sleep(0)
            assert starts == ["2026-11-01"]
            release.set()
            return await asyncio.wait_for(task, 1)

    report = asyncio.run(scenario())
    assert [item.flight_date for item in report.results] == ["2026-11-01", "2026-11-02"]


def test_sixteen_manual_slots_are_bounded_and_accounted(monkeypatch, tmp_path):
    entered = asyncio.Event()
    release = asyncio.Event()
    active = peak = 0

    async def fetch(_session, query, _provider, _store):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        if active == 16:
            entered.set()
        try:
            await release.wait()
        finally:
            active -= 1
        return result(query), None

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    budget, ledger = allowance(tmp_path, 18)

    async def scenario():
        async with httpx.AsyncClient() as client:
            task = asyncio.create_task(
                fare_collector.collect(
                    queries(18),
                    client=client,
                    history=object(),
                    gap_seconds=0,
                    budget=budget,
                    max_in_flight=16,
                )
            )
            await asyncio.wait_for(entered.wait(), 1)
            assert peak == 16
            assert ledger.spent(budget.day) == 16
            release.set()
            return await asyncio.wait_for(task, 1)

    report = asyncio.run(scenario())
    assert active == 0
    assert peak == 16
    assert [item.flight_date for item in report.results] == [q.flight_date for q in queries(18)]
    assert ledger.spent(budget.day) == 18


def test_two_route_passes_share_one_sixteen_request_limit(monkeypatch, tmp_path):
    reached_limit = asyncio.Event()
    release = asyncio.Event()
    active = peak = 0

    async def fetch(_session, query, _provider, _store):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        if active == 16:
            reached_limit.set()
        try:
            await release.wait()
        finally:
            active -= 1
        return result(query), None

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    first_budget, ledger = allowance(tmp_path, 32)
    second_budget, _ = allowance(tmp_path, 32)

    async def scenario():
        slots = asyncio.Semaphore(16)
        pacer = fare_collector.DeadlinePacer()
        async with httpx.AsyncClient() as client:
            first = asyncio.create_task(
                fare_collector.collect(
                    queries(16),
                    client=client,
                    history=object(),
                    gap_seconds=0,
                    pacer=pacer,
                    budget=first_budget,
                    max_in_flight=16,
                    request_slots=slots,
                )
            )
            second = asyncio.create_task(
                fare_collector.collect(
                    queries(16),
                    client=client,
                    history=object(),
                    gap_seconds=0,
                    pacer=pacer,
                    budget=second_budget,
                    max_in_flight=16,
                    request_slots=slots,
                )
            )
            await asyncio.wait_for(reached_limit.wait(), 1)
            await asyncio.sleep(0)
            assert peak == 16
            release.set()
            return await asyncio.wait_for(asyncio.gather(first, second), 1)

    reports = asyncio.run(scenario())
    assert [report.collected for report in reports] == [16, 16]
    assert peak == 16
    assert ledger.spent(first_budget.day) == 32


def test_parallel_scheduled_pass_stops_launching_at_its_deadline(monkeypatch, tmp_path):
    clock = [0.0]

    async def fetch(_session, query, _provider, _store):
        return result(query), None

    async def pace(seconds):
        clock[0] += seconds

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    monkeypatch.setattr(fare_collector, "perf_counter", lambda: clock[0])
    budget, ledger = allowance(tmp_path, 4)

    async def scenario():
        async with httpx.AsyncClient() as client:
            return await fare_collector.collect(
                queries(4),
                client=client,
                history=object(),
                gap_seconds=0.05,
                pacer=fare_collector.DeadlinePacer(clock=lambda: clock[0], sleep=pace),
                budget=budget,
                max_in_flight=2,
                deadline_seconds=0.04,
            )

    report = asyncio.run(scenario())
    assert report.collected == 1
    assert len(report.skipped) == 3
    assert all(reason == fare_collector.WINDOW_FULL for _, reason in report.skipped)
    assert ledger.spent(budget.day) == 1


def test_sixteen_manual_slots_keep_50ms_start_spacing(monkeypatch, tmp_path):
    class Clock:
        now = 0.0

        def monotonic(self):
            return self.now

        async def sleep(self, seconds):
            self.now += seconds

    clock = Clock()
    starts: list[float] = []

    async def fetch(_session, query, _provider, _store):
        starts.append(clock.now)
        return result(query), None

    monkeypatch.setattr(fare_collector, "_collect_one", fetch)
    budget, _ledger = allowance(tmp_path, 18)

    async def scenario():
        async with httpx.AsyncClient() as client:
            return await fare_collector.collect(
                queries(18),
                client=client,
                history=object(),
                gap_seconds=0.05,
                pacer=fare_collector.DeadlinePacer(clock=clock.monotonic, sleep=clock.sleep),
                budget=budget,
                max_in_flight=16,
            )

    report = asyncio.run(scenario())
    assert report.collected == 18
    assert len(starts) == 18
    assert all(b - a >= 0.05 - 1e-9 for a, b in pairwise(starts))
