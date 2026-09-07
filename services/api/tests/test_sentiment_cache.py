import asyncio
import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.adapters.cnn_sentiment import (
    SentimentPayloadError,
    SentimentProviderError,
    parse_sentiment,
)
from app.config import MAX_STALE_SENTIMENT_SECONDS, SENTIMENT_TTL_SECONDS
from app.services.sentiment_cache import SentimentCache

FIXTURE = Path(__file__).parent / "fixtures" / "cnn_sentiment_synthetic.json"
NOW = datetime(2026, 1, 3, 1, tzinfo=UTC)


def a_snapshot():
    return parse_sentiment(json.loads(FIXTURE.read_text(encoding="utf-8")), fetched_at=NOW)


def age(path: Path, seconds: float) -> None:
    then = time.time() - seconds
    os.utime(path, (then, then))


def test_reuses_a_fresh_snapshot_without_calling_upstream(tmp_path):
    cache = SentimentCache(tmp_path)
    calls = 0

    async def factory():
        nonlocal calls
        calls += 1
        return a_snapshot()

    first = asyncio.run(cache.fetch(factory))
    second = asyncio.run(cache.fetch(factory))

    assert first.stale is False
    assert second == first
    assert calls == 1


def test_refreshes_after_four_hours(tmp_path):
    cache = SentimentCache(tmp_path)
    calls = 0

    async def factory():
        nonlocal calls
        calls += 1
        return a_snapshot()

    asyncio.run(cache.fetch(factory))
    age(cache.path, SENTIMENT_TTL_SECONDS + 1)
    asyncio.run(cache.fetch(factory))

    assert calls == 2


def test_snapshot_survives_a_new_cache_instance(tmp_path):
    async def factory():
        return a_snapshot()

    written = asyncio.run(SentimentCache(tmp_path).fetch(factory))

    async def must_not_run():
        raise AssertionError("a fresh disk snapshot must be reused")

    assert asyncio.run(SentimentCache(tmp_path).fetch(must_not_run)) == written


def test_a_corrupt_file_is_a_miss_not_an_answer(tmp_path):
    cache = SentimentCache(tmp_path)
    cache.path.parent.mkdir(parents=True, exist_ok=True)
    cache.path.write_text("not json", encoding="utf-8")

    async def factory():
        return a_snapshot()

    assert asyncio.run(cache.fetch(factory)).composite.score == 62.5


def test_coalesces_concurrent_refreshes(tmp_path):
    cache = SentimentCache(tmp_path)
    calls = 0

    async def factory():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0)
        return a_snapshot()

    async def run():
        return await asyncio.gather(*(cache.fetch(factory) for _ in range(8)))

    answers = asyncio.run(run())

    assert [answer.composite.score for answer in answers] == [62.5] * 8
    assert calls == 1


def test_serves_bounded_stale_data_after_a_transient_failure(tmp_path):
    cache = SentimentCache(tmp_path)

    async def success():
        return a_snapshot()

    asyncio.run(cache.fetch(success))
    age(cache.path, SENTIMENT_TTL_SECONDS + 1)

    async def refused():
        raise SentimentProviderError("access-refused", "refused", transient=True)

    answer = asyncio.run(cache.fetch(refused))

    assert answer.stale is True
    assert answer.as_of == a_snapshot().as_of


def test_will_not_serve_a_snapshot_older_than_seven_days(tmp_path):
    cache = SentimentCache(tmp_path)

    async def success():
        return a_snapshot()

    asyncio.run(cache.fetch(success))
    age(cache.path, MAX_STALE_SENTIMENT_SECONDS + 1)

    async def refused():
        raise SentimentProviderError("unreachable", "offline", transient=True)

    with pytest.raises(SentimentProviderError, match="offline"):
        asyncio.run(cache.fetch(refused))


def test_malformed_refresh_does_not_fall_back_to_stale_data(tmp_path):
    cache = SentimentCache(tmp_path)

    async def success():
        return a_snapshot()

    asyncio.run(cache.fetch(success))
    age(cache.path, SENTIMENT_TTL_SECONDS + 1)

    async def malformed():
        raise SentimentPayloadError("broken schema")

    with pytest.raises(SentimentPayloadError, match="broken schema"):
        asyncio.run(cache.fetch(malformed))
