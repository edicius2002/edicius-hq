from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

import httpx

from app.adapters.sentiment_models import (
    SentimentClassification,
    SentimentMetric,
    SentimentPoint,
    SentimentSeries,
    SentimentSnapshot,
)
from app.config import UPSTREAM_TIMEOUT_SECONDS

CNN_SENTIMENT_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"


class SentimentProviderError(Exception):
    def __init__(self, code: str, message: str, *, transient: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.transient = transient


class SentimentPayloadError(SentimentProviderError):
    def __init__(self, message: str) -> None:
        super().__init__("invalid-payload", message, transient=False)


@dataclass(frozen=True, slots=True)
class _SeriesSpec:
    provider_key: str
    key: str
    label: str
    unit: str


@dataclass(frozen=True, slots=True)
class _MetricSpec:
    provider_key: str
    key: str
    label: str
    series: tuple[_SeriesSpec, ...]


_INDICATORS = (
    _MetricSpec(
        "market_momentum_sp500",
        "market_momentum",
        "Market Momentum",
        (
            _SeriesSpec("market_momentum_sp500", "sp500", "S&P 500", "index points"),
            _SeriesSpec(
                "market_momentum_sp125",
                "sp500_125_day_average",
                "125-day average",
                "index points",
            ),
        ),
    ),
    _MetricSpec(
        "stock_price_strength",
        "stock_price_strength",
        "Stock Price Strength",
        (
            _SeriesSpec(
                "stock_price_strength",
                "new_highs_vs_lows",
                "New highs vs new lows",
                "ratio",
            ),
        ),
    ),
    _MetricSpec(
        "stock_price_breadth",
        "stock_price_breadth",
        "Stock Price Breadth",
        (
            _SeriesSpec(
                "stock_price_breadth",
                "mcclellan_volume_summation",
                "McClellan volume summation",
                "index value",
            ),
        ),
    ),
    _MetricSpec(
        "put_call_options",
        "put_call_options",
        "Put and Call Options",
        (_SeriesSpec("put_call_options", "put_call_ratio", "Put/call ratio", "ratio"),),
    ),
    _MetricSpec(
        "market_volatility_vix",
        "market_volatility",
        "Market Volatility",
        (
            _SeriesSpec("market_volatility_vix", "vix", "VIX", "VIX points"),
            _SeriesSpec(
                "market_volatility_vix_50",
                "vix_50_day_average",
                "50-day average",
                "VIX points",
            ),
        ),
    ),
    _MetricSpec(
        "safe_haven_demand",
        "safe_haven_demand",
        "Safe Haven Demand",
        (
            _SeriesSpec(
                "safe_haven_demand",
                "stock_bond_return_spread",
                "Stock vs bond return spread",
                "percentage points",
            ),
        ),
    ),
    _MetricSpec(
        "junk_bond_demand",
        "junk_bond_demand",
        "Junk Bond Demand",
        (
            _SeriesSpec(
                "junk_bond_demand",
                "yield_spread",
                "High-yield spread",
                "percentage points",
            ),
        ),
    ),
)


def _object(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SentimentPayloadError(f"{field} must be an object")
    return cast(dict[str, Any], value)


def _number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise SentimentPayloadError(f"{field} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise SentimentPayloadError(f"{field} must be finite")
    return result


def _score(value: object, field: str) -> float:
    result = _number(value, field)
    if not 0 <= result <= 100:
        raise SentimentPayloadError(f"{field} must be between 0 and 100")
    return result


def _rating(value: object, field: str) -> SentimentClassification:
    allowed = {"extreme fear", "fear", "neutral", "greed", "extreme greed"}
    if not isinstance(value, str) or value.casefold().strip() not in allowed:
        raise SentimentPayloadError(f"{field} rating is invalid")
    return cast(SentimentClassification, value.casefold().strip())


def _iso_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise SentimentPayloadError(f"{field} timestamp must be ISO 8601")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SentimentPayloadError(f"{field} timestamp is invalid") from exc
    if parsed.tzinfo is None:
        raise SentimentPayloadError(f"{field} timestamp needs a timezone")
    return parsed.astimezone(UTC)


def _epoch_timestamp(value: object, field: str) -> datetime:
    milliseconds = _number(value, f"{field} timestamp")
    try:
        return datetime.fromtimestamp(milliseconds / 1000, tz=UTC)
    except (OverflowError, OSError, ValueError) as exc:
        raise SentimentPayloadError(f"{field} timestamp is invalid") from exc


def _history(payload: dict[str, Any], spec: _SeriesSpec) -> SentimentSeries:
    block = _object(payload.get(spec.provider_key), spec.provider_key)
    rows = block.get("data")
    if not isinstance(rows, list) or not rows:
        raise SentimentPayloadError(f"{spec.provider_key} history must not be empty")

    by_time: dict[datetime, SentimentPoint] = {}
    for index, raw in enumerate(rows):
        row = _object(raw, f"{spec.provider_key}.data[{index}]")
        timestamp = _epoch_timestamp(row.get("x"), f"{spec.provider_key}.data[{index}]")
        by_time[timestamp] = SentimentPoint(
            timestamp=timestamp,
            value=_number(row.get("y"), f"{spec.provider_key}.data[{index}].value"),
            classification=_rating(
                row.get("rating"), f"{spec.provider_key}.data[{index}]"
            ),
        )
    return SentimentSeries(
        key=spec.key,
        label=spec.label,
        unit=spec.unit,
        points=tuple(by_time[timestamp] for timestamp in sorted(by_time)),
    )


def _indicator(payload: dict[str, Any], spec: _MetricSpec) -> SentimentMetric:
    block = _object(payload.get(spec.provider_key), spec.provider_key)
    return SentimentMetric(
        key=spec.key,
        label=spec.label,
        score=_score(block.get("score"), f"{spec.provider_key}.score"),
        classification=_rating(block.get("rating"), spec.provider_key),
        timestamp=_epoch_timestamp(block.get("timestamp"), spec.provider_key),
        series=tuple(_history(payload, series) for series in spec.series),
    )


def parse_sentiment(payload: object, *, fetched_at: datetime) -> SentimentSnapshot:
    root = _object(payload, "payload")
    headline = _object(root.get("fear_and_greed"), "fear_and_greed")
    historical = _object(root.get("fear_and_greed_historical"), "fear_and_greed_historical")
    if fetched_at.tzinfo is None:
        raise SentimentPayloadError("fetched_at needs a timezone")

    composite = SentimentMetric(
        key="fear_and_greed",
        label="Fear & Greed Index",
        score=_score(headline.get("score"), "fear_and_greed.score"),
        classification=_rating(headline.get("rating"), "fear_and_greed"),
        timestamp=_iso_timestamp(headline.get("timestamp"), "fear_and_greed"),
        series=(
            _history(
                root,
                _SeriesSpec(
                    "fear_and_greed_historical",
                    "fear_and_greed",
                    "Fear & Greed score",
                    "score",
                ),
            ),
        ),
    )
    _score(historical.get("score"), "fear_and_greed_historical.score")
    _rating(historical.get("rating"), "fear_and_greed_historical")
    _epoch_timestamp(historical.get("timestamp"), "fear_and_greed_historical")

    return SentimentSnapshot(
        source="cnn",
        fetched_at=fetched_at.astimezone(UTC),
        as_of=composite.timestamp,
        composite=composite,
        indicators=tuple(_indicator(root, spec) for spec in _INDICATORS),
    )


async def fetch_sentiment(
    client: httpx.AsyncClient,
    *,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> SentimentSnapshot:
    try:
        response = await client.get(
            CNN_SENTIMENT_URL,
            headers={"Accept": "application/json"},
            timeout=UPSTREAM_TIMEOUT_SECONDS,
        )
    except (httpx.TimeoutException, httpx.RequestError) as exc:
        raise SentimentProviderError(
            "unreachable", "CNN sentiment data is unreachable", transient=True
        ) from exc

    if response.status_code in {403, 418}:
        raise SentimentProviderError(
            "access-refused", "CNN refused the sentiment request", transient=True
        )
    if response.status_code == 429:
        raise SentimentProviderError(
            "rate-limited", "CNN rate-limited the sentiment request", transient=True
        )
    if response.status_code >= 500:
        raise SentimentProviderError(
            "upstream-error", "CNN sentiment service failed", transient=True
        )
    if not response.is_success:
        raise SentimentProviderError(
            "upstream-error",
            f"CNN sentiment service returned HTTP {response.status_code}",
            transient=False,
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise SentimentPayloadError("CNN sentiment response is not valid JSON") from exc
    return parse_sentiment(payload, fetched_at=now())
