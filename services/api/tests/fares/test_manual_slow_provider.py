"""Repeatable local timing harness; no network requests or production inference."""

import asyncio
import os
from datetime import UTC, datetime
from time import perf_counter

import httpx
from conftest import BOARD, board_queries, read_fixture

from app.services.fare_budget import RequestLedger, daily_budget
from app.services.fare_collector import DeadlinePacer, collect
from app.services.fare_history import FareHistory


def test_slow_provider_timing_harness(tmp_path):
    page = read_fixture(BOARD)
    gap_seconds = float(os.getenv("FARE_HARNESS_GAP_SECONDS", "0.03"))
    measurements: dict[int, tuple[float, int]] = {}

    async def run(max_in_flight: int):
        active = 0
        peak = 0

        async def provider(_request: httpx.Request) -> httpx.Response:
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            try:
                await asyncio.sleep(0.2)
                return httpx.Response(200, text=page)
            finally:
                active -= 1

        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            started = perf_counter()
            report = await collect(
                board_queries()[:4],
                history=FareHistory(tmp_path / f"history-{max_in_flight}"),
                client=client,
                gap_seconds=gap_seconds,
                pacer=DeadlinePacer(),
                budget=daily_budget(
                    ceiling=4,
                    ledger=RequestLedger(tmp_path / f"spend-{max_in_flight}"),
                    now=datetime(2026, 8, 21, tzinfo=UTC),
                ),
                max_in_flight=max_in_flight,
            )
            return perf_counter() - started, peak, report

    for limit in (1, 2):
        elapsed, peak, report = asyncio.run(run(limit))
        measurements[limit] = (elapsed, peak)
        assert report.collected == 4
        assert [item.flight_date for item in report.results] == [
            "2026-10-01",
            "2026-10-02",
            "2026-10-03",
            "2026-10-04",
        ]

    assert measurements[1][1] == 1
    assert measurements[2][1] == (2 if gap_seconds < 0.2 else 1)
    print(
        f"slow-provider harness (4 dates, 200ms/date, {gap_seconds:.2f}s gap): "
        f"sequential={measurements[1][0]:.3f}s, bounded={measurements[2][0]:.3f}s"
    )
