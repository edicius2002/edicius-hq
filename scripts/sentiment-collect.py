"""Fetch one normalized sentiment snapshot and acknowledge it to Supabase."""

from __future__ import annotations

import asyncio
import logging
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

from app.adapters.cnn_sentiment import SentimentProviderError, fetch_sentiment
from app.adapters.sentiment_models import SentimentSnapshot
from app.config import UPSTREAM_TIMEOUT_SECONDS
from app.services.collector_cloud import CollectorCloud, configured_collector_cloud

FetchSentiment = Callable[[httpx.AsyncClient], Awaitable[SentimentSnapshot]]
LOGGER = logging.getLogger(__name__)


def sentiment_row(owner_id: UUID, snapshot: SentimentSnapshot) -> dict[str, Any]:
    """Create the one durable row from the established normalized wire payload."""
    wire = snapshot.to_wire()
    return {
        "owner_id": str(owner_id),
        "source": snapshot.source,
        "as_of": wire["asOf"],
        "score": snapshot.composite.score,
        "classification": snapshot.composite.classification,
        "fetched_at": wire["fetchedAt"],
        "payload": wire,
    }


def sentiment_error_code(error: Exception) -> str:
    if isinstance(error, SentimentProviderError):
        return error.code
    return "cloud-upsert-failed"


async def collect_once(
    cloud: CollectorCloud, *, fetch: FetchSentiment = fetch_sentiment
) -> int:
    """Return success only after the snapshot and its collector run are acknowledged."""
    try:
        run_id = cloud.begin_run("sentiment")
    except Exception:  # noqa: BLE001 - a failed run cannot make the command succeed
        LOGGER.error("sentiment collector could not begin its run")
        return 1

    try:
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS) as client:
            snapshot = await fetch(client)
        cloud.upsert_sentiment(sentiment_row(cloud.owner_id, snapshot))
        cloud.finish_run(run_id, {"seen": 1, "written": 1, "failed": 0})
        return 0
    except Exception as error:  # noqa: BLE001 - provider and cloud failures share one run state
        try:
            cloud.fail_run(run_id, sentiment_error_code(error))
        except Exception:  # noqa: BLE001 - the original failure still decides the exit status
            LOGGER.error("sentiment collector could not mark its run failed")
        return 1


def main() -> int:
    return asyncio.run(collect_once(configured_collector_cloud()))


if __name__ == "__main__":
    raise SystemExit(main())
