from __future__ import annotations

import logging
from datetime import datetime

import httpx
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.adapters.cnn_sentiment import SentimentProviderError, fetch_sentiment
from app.config import UPSTREAM_TIMEOUT_SECONDS
from app.services.sentiment_cache import SentimentCache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sentiment", tags=["sentiment"])
CACHE = SentimentCache()

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS, follow_redirects=True)
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


class SentimentPointModel(BaseModel):
    timestamp: datetime
    value: float
    classification: str | None = None


class SentimentSeriesModel(BaseModel):
    key: str
    label: str
    unit: str
    points: list[SentimentPointModel]


class SentimentMetricModel(BaseModel):
    key: str
    label: str
    score: float
    classification: str
    timestamp: datetime
    series: list[SentimentSeriesModel]


class SentimentResponse(BaseModel):
    source: str
    fetchedAt: datetime
    asOf: datetime
    stale: bool
    composite: SentimentMetricModel
    indicators: list[SentimentMetricModel]


def _as_http_error(exc: SentimentProviderError) -> HTTPException:
    logger.warning("CNN sentiment refused: %s (%s)", exc.code, exc.message)
    statuses = {
        "rate-limited": status.HTTP_429_TOO_MANY_REQUESTS,
        "access-refused": status.HTTP_503_SERVICE_UNAVAILABLE,
        "unreachable": status.HTTP_503_SERVICE_UNAVAILABLE,
        "invalid-payload": status.HTTP_502_BAD_GATEWAY,
    }
    return HTTPException(
        statuses.get(exc.code, status.HTTP_502_BAD_GATEWAY),
        {"code": exc.code, "message": exc.message},
    )


@router.get("", response_model=SentimentResponse)
async def get_sentiment() -> SentimentResponse:
    try:
        snapshot = await CACHE.fetch(lambda: fetch_sentiment(get_client()))
    except SentimentProviderError as exc:
        raise _as_http_error(exc) from exc
    return SentimentResponse.model_validate(snapshot.to_wire())
