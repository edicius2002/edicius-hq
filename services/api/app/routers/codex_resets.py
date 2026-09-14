from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, HTTPException, status

from app.adapters.codex_resets import CodexResetsProviderError, fetch_codex_resets
from app.config import UPSTREAM_TIMEOUT_SECONDS
from app.services.codex_resets_cache import CodexResetsCache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/codex-resets", tags=["codex-resets"])
CACHE = CodexResetsCache()
_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    """A dedicated external client: application bearer headers never reach upstream."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS, follow_redirects=True)
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _as_http_error(exc: CodexResetsProviderError) -> HTTPException:
    logger.warning("Codex Resets request failed: %s (%s)", exc.code, exc.message)
    statuses = {
        "rate-limited": status.HTTP_429_TOO_MANY_REQUESTS,
        "unreachable": status.HTTP_503_SERVICE_UNAVAILABLE,
        "invalid-payload": status.HTTP_502_BAD_GATEWAY,
    }
    headers = (
        {"Retry-After": str(exc.retry_after_seconds)}
        if exc.retry_after_seconds is not None
        else None
    )
    return HTTPException(
        statuses.get(exc.code, status.HTTP_502_BAD_GATEWAY),
        {"code": exc.code, "message": exc.message},
        headers=headers,
    )


@router.get("")
async def get_codex_resets() -> dict[str, object]:
    try:
        snapshot = await CACHE.fetch(
            lambda previous: fetch_codex_resets(get_client(), previous=previous)
        )
    except CodexResetsProviderError as exc:
        raise _as_http_error(exc) from exc
    return snapshot.to_wire()
