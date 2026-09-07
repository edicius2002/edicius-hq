import asyncio
import json
import math
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from app.adapters.cnn_sentiment import (
    CNN_SENTIMENT_URL,
    SentimentPayloadError,
    SentimentProviderError,
    fetch_sentiment,
    parse_sentiment,
)

FIXTURE = Path(__file__).parent / "fixtures" / "cnn_sentiment_synthetic.json"
FETCHED_AT = datetime(2026, 1, 3, 1, tzinfo=UTC)


@pytest.fixture
def synthetic_payload() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_normalizes_all_eight_metrics_and_reference_lines(synthetic_payload):
    snapshot = parse_sentiment(synthetic_payload, fetched_at=FETCHED_AT)

    assert snapshot.source == "cnn"
    assert snapshot.fetched_at == FETCHED_AT
    assert snapshot.as_of == datetime(2026, 1, 2, 23, 59, 55, tzinfo=UTC)
    assert snapshot.composite.key == "fear_and_greed"
    assert snapshot.composite.score == 62.5
    assert snapshot.composite.classification == "greed"
    assert [metric.key for metric in snapshot.indicators] == [
        "market_momentum",
        "stock_price_strength",
        "stock_price_breadth",
        "put_call_options",
        "market_volatility",
        "safe_haven_demand",
        "junk_bond_demand",
    ]
    assert [series.key for series in snapshot.indicators[0].series] == [
        "sp500",
        "sp500_125_day_average",
    ]
    assert [series.key for series in snapshot.indicators[4].series] == [
        "vix",
        "vix_50_day_average",
    ]
    assert snapshot.indicators[0].series[0].unit == "index points"
    assert snapshot.indicators[3].series[0].unit == "ratio"


def test_orders_and_deduplicates_history_by_timestamp(synthetic_payload):
    points = parse_sentiment(synthetic_payload, fetched_at=FETCHED_AT).composite.series[0].points

    assert [point.value for point in points] == [60.0, 62.5]
    assert points[0].timestamp == datetime(2026, 1, 1, tzinfo=UTC)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda data: data.pop("stock_price_breadth"), "stock_price_breadth"),
        (lambda data: data["fear_and_greed"].update(score=math.nan), "score"),
        (lambda data: data["junk_bond_demand"].update(rating="hopeful"), "rating"),
        (lambda data: data["put_call_options"].update(data=[]), "history"),
    ],
)
def test_rejects_incomplete_or_invalid_snapshots(synthetic_payload, change, message):
    broken = deepcopy(synthetic_payload)
    change(broken)

    with pytest.raises(SentimentPayloadError, match=message):
        parse_sentiment(broken, fetched_at=FETCHED_AT)


def test_round_trips_the_normalized_wire_contract(synthetic_payload):
    snapshot = parse_sentiment(synthetic_payload, fetched_at=FETCHED_AT)

    restored = type(snapshot).from_wire(snapshot.to_wire())

    assert restored == snapshot
    assert snapshot.to_wire()["stale"] is False
    assert len(snapshot.to_wire()["indicators"]) == 7


def test_fetch_uses_the_public_json_resource_without_browser_impersonation(synthetic_payload):
    seen: httpx.Request | None = None

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal seen
        seen = request
        return httpx.Response(200, json=synthetic_payload)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await fetch_sentiment(client, now=lambda: FETCHED_AT)

    snapshot = asyncio.run(run())

    assert snapshot.composite.score == 62.5
    assert seen is not None
    assert str(seen.url) == CNN_SENTIMENT_URL
    assert seen.headers["accept"] == "application/json"
    assert "referer" not in seen.headers
    assert "origin" not in seen.headers


@pytest.mark.parametrize(
    ("status_code", "code", "transient"),
    [(418, "access-refused", True), (429, "rate-limited", True), (500, "upstream-error", True)],
)
def test_fetch_reports_upstream_statuses_explicitly(status_code, code, transient):
    async def run():
        transport = httpx.MockTransport(lambda request: httpx.Response(status_code, request=request))
        async with httpx.AsyncClient(transport=transport) as client:
            return await fetch_sentiment(client, now=lambda: FETCHED_AT)

    with pytest.raises(SentimentProviderError) as caught:
        asyncio.run(run())

    assert caught.value.code == code
    assert caught.value.transient is transient


def test_fetch_turns_timeouts_into_an_explicit_transient_error():
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("late", request=request)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(timeout)) as client:
            return await fetch_sentiment(client, now=lambda: FETCHED_AT)

    with pytest.raises(SentimentProviderError) as caught:
        asyncio.run(run())

    assert caught.value.code == "unreachable"
    assert caught.value.transient is True
