from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

import httpx

from app.adapters.cnn_sentiment import SentimentPayloadError, SentimentProviderError
from app.adapters.sentiment_models import (
    SentimentClassification,
    SentimentMetric,
    SentimentPoint,
    SentimentSeries,
    SentimentSnapshot,
)
from app.config import UPSTREAM_TIMEOUT_SECONDS

FEAR_GREED_GRAPH_URL = "https://fearandgreedgraph.com/api/fear-greed"
MAX_HISTORY_POINTS = 366


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


def _classification_for_score(score: float) -> SentimentClassification:
    if score < 25:
        return "extreme fear"
    if score < 45:
        return "fear"
    if score < 55:
        return "neutral"
    if score < 75:
        return "greed"
    return "extreme greed"


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


def _date_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise SentimentPayloadError(f"{field} date must use YYYY-MM-DD")
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=UTC)
    except ValueError as exc:
        raise SentimentPayloadError(f"{field} date is invalid") from exc


def _history(
    block: dict[str, Any],
    spec: _SeriesSpec,
    *,
    classify: bool = False,
) -> SentimentSeries:
    dates = block.get("dates")
    values = block.get("values")
    if not isinstance(dates, list) or not dates:
        raise SentimentPayloadError(f"{spec.provider_key}.dates must not be empty")
    if not isinstance(values, list) or len(values) != len(dates):
        raise SentimentPayloadError(f"{spec.provider_key} dates and values must align")

    by_time: dict[datetime, SentimentPoint] = {}
    start = max(0, len(dates) - MAX_HISTORY_POINTS)
    for index in range(start, len(dates)):
        timestamp = _date_timestamp(dates[index], f"{spec.provider_key}.dates[{index}]")
        value = _number(values[index], f"{spec.provider_key}.values[{index}]")
        if classify:
            value = _score(value, f"{spec.provider_key}.values[{index}]")
        by_time[timestamp] = SentimentPoint(
            timestamp=timestamp,
            value=value,
            classification=_classification_for_score(value) if classify else None,
        )
    return SentimentSeries(
        key=spec.key,
        label=spec.label,
        unit=spec.unit,
        points=tuple(by_time[timestamp] for timestamp in sorted(by_time)),
    )


def _indicator(indicators: dict[str, Any], spec: _MetricSpec) -> SentimentMetric:
    block = _object(indicators.get(spec.provider_key), spec.provider_key)
    series: list[SentimentSeries] = []
    for series_spec in spec.series:
        series_block = _object(indicators.get(series_spec.provider_key), series_spec.provider_key)
        _score(series_block.get("score"), f"{series_spec.provider_key}.score")
        _rating(series_block.get("rating"), series_spec.provider_key)
        _epoch_timestamp(series_block.get("asOf"), series_spec.provider_key)
        series.append(_history(series_block, series_spec))
    return SentimentMetric(
        key=spec.key,
        label=spec.label,
        score=_score(block.get("score"), f"{spec.provider_key}.score"),
        classification=_rating(block.get("rating"), spec.provider_key),
        timestamp=_epoch_timestamp(block.get("asOf"), spec.provider_key),
        series=tuple(series),
    )


def parse_feargreedgraph_sentiment(payload: object, *, fetched_at: datetime) -> SentimentSnapshot:
    root = _object(payload, "payload")
    indicators = _object(root.get("indicators"), "indicators")
    if fetched_at.tzinfo is None:
        raise SentimentPayloadError("fetched_at needs a timezone")

    composite_series = _history(
        root,
        _SeriesSpec("fear_and_greed", "fear_and_greed", "Fear & Greed score", "score"),
        classify=True,
    )
    current_score = composite_series.points[-1].value
    as_of = _iso_timestamp(root.get("asOf"), "asOf")
    composite = SentimentMetric(
        key="fear_and_greed",
        label="Fear & Greed Index",
        score=current_score,
        classification=_classification_for_score(current_score),
        timestamp=as_of,
        series=(composite_series,),
    )
    return SentimentSnapshot(
        source="cnn-mirror",
        fetched_at=fetched_at.astimezone(UTC),
        as_of=as_of,
        composite=composite,
        indicators=tuple(_indicator(indicators, spec) for spec in _INDICATORS),
    )


async def fetch_feargreedgraph_sentiment(
    client: httpx.AsyncClient,
    *,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> SentimentSnapshot:
    try:
        response = await client.get(
            FEAR_GREED_GRAPH_URL,
            headers={"Accept": "application/json"},
            timeout=UPSTREAM_TIMEOUT_SECONDS,
        )
    except (httpx.TimeoutException, httpx.RequestError) as exc:
        raise SentimentProviderError(
            "unreachable", "Sentiment mirror is unreachable", transient=True
        ) from exc

    if response.status_code in {403, 418}:
        raise SentimentProviderError(
            "access-refused", "Sentiment mirror refused the request", transient=True
        )
    if response.status_code == 429:
        raise SentimentProviderError(
            "rate-limited", "Sentiment mirror rate-limited the request", transient=True
        )
    if response.status_code >= 500:
        raise SentimentProviderError("upstream-error", "Sentiment mirror failed", transient=True)
    if not response.is_success:
        raise SentimentProviderError(
            "upstream-error",
            f"Sentiment mirror returned HTTP {response.status_code}",
            transient=False,
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise SentimentPayloadError("Sentiment mirror response is not valid JSON") from exc
    return parse_feargreedgraph_sentiment(payload, fetched_at=now())
