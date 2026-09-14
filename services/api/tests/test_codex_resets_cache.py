import asyncio
import os
import time
from datetime import UTC, datetime

from app.adapters.codex_resets import (
    CodexReset,
    CodexResetSource,
    CodexResetsProviderError,
    CodexResetsSnapshot,
    CodexResetStats,
)
from app.config import CODEX_RESETS_TTL_SECONDS
from app.services.codex_resets_cache import CodexResetsCache

NOW = datetime(2026, 9, 14, 15, tzinfo=UTC)


def snapshot() -> CodexResetsSnapshot:
    item = CodexReset(
        id="reset-1",
        reset_type="regular",
        announced_at=datetime(2026, 9, 12, 8, 9, tzinfo=UTC),
        text="Reset done",
        source=CodexResetSource(
            type="x_post",
            author="thsottiaux",
            url="https://x.com/thsottiaux/status/reset-1",
        ),
    )
    return CodexResetsSnapshot(
        fetched_at=NOW,
        generated_at=NOW,
        etag='"v1"',
        stale=False,
        latest_reset=item,
        stats=CodexResetStats(total=1, avg_interval_days=None, longest_interval_days=None),
        resets=(item,),
    )


def age(path, seconds: float) -> None:
    then = time.time() - seconds
    os.utime(path, (then, then))


def test_reuses_fresh_disk_data_and_passes_stale_data_for_conditional_refresh(tmp_path):
    cache = CodexResetsCache(tmp_path)
    seen = []

    async def factory(previous):
        seen.append(previous)
        return snapshot()

    first = asyncio.run(cache.fetch(factory))
    assert asyncio.run(cache.fetch(factory)) == first
    assert seen == [None]

    age(cache.path, CODEX_RESETS_TTL_SECONDS + 1)
    refreshed = asyncio.run(cache.fetch(factory))
    assert seen[-1] == first
    assert refreshed.stale is False


def test_transient_failure_keeps_the_last_valid_snapshot_and_marks_its_age(tmp_path):
    cache = CodexResetsCache(tmp_path)

    async def success(previous):
        return snapshot()

    asyncio.run(cache.fetch(success))
    age(cache.path, CODEX_RESETS_TTL_SECONDS + 1)

    async def refused(previous):
        raise CodexResetsProviderError("unreachable", "offline", transient=True)

    stale = asyncio.run(cache.fetch(refused))

    assert stale.stale is True
    assert stale.fetched_at == NOW
    assert stale.resets[0].id == "reset-1"


def test_failure_without_a_last_valid_snapshot_is_not_reported_as_zero(tmp_path):
    cache = CodexResetsCache(tmp_path)

    async def refused(previous):
        raise CodexResetsProviderError("unreachable", "offline", transient=True)

    try:
        asyncio.run(cache.fetch(refused))
    except CodexResetsProviderError as error:
        assert error.code == "unreachable"
    else:
        raise AssertionError("an unavailable first load must remain an error")
