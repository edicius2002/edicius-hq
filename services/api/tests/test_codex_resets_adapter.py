import asyncio
from datetime import UTC, datetime

import httpx
import pytest

from app.adapters.codex_resets import (
    CodexResetsProviderError,
    fetch_codex_resets,
)

NOW = datetime(2026, 9, 14, 15, tzinfo=UTC)


def reset(reset_id: str, announced_at: str, reset_type: str = "regular"):
    return {
        "id": reset_id,
        "reset_type": reset_type,
        "announced_at": announced_at,
        "text": f"Reset {reset_id}",
        "source": {
            "type": "x_post",
            "author": "thsottiaux",
            "url": f"https://x.com/thsottiaux/status/{reset_id}",
        },
    }


def status(latest):
    return {
        "data": {
            "latest_reset": latest,
            "scheduled_reset": {
                **reset("scheduled", "2026-09-15T03:00:00Z"),
                "status": "scheduled",
                "scheduled_for": "2026-09-16T03:00:00Z",
            },
            "active_watch": None,
            "stats": {
                "total": 3,
                "last_reset_at": latest["announced_at"],
                "days_since_last": 2.3,
                "avg_interval_days": 4.5,
            },
        },
        "meta": {"api_version": "v1", "generated_at": "2026-09-14T14:59:00Z"},
    }


def page(rows, has_more=False, cursor=None):
    return {
        "data": rows,
        "pagination": {"has_more": has_more, "next_cursor": cursor},
        "meta": {"api_version": "v1", "generated_at": "2026-09-14T14:59:00Z"},
    }


def test_fetches_every_page_deduplicates_and_never_forwards_authorization():
    first = reset("one", "2026-09-01T04:30:00Z")
    second = reset("two", "2026-09-03T05:30:00Z", "banked")
    third = reset("three", "2026-09-10T05:30:00Z")
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json=status(third), headers={"ETag": '"status-1"'})
        if request.url.params.get("cursor") == "next_page":
            return httpx.Response(200, json=page([second, third]))
        return httpx.Response(200, json=page([first, second], True, "next_page"))

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as client:
            return await fetch_codex_resets(client, now=lambda: NOW)

    snapshot = asyncio.run(run())

    assert [item.id for item in snapshot.resets] == ["one", "two", "three"]
    assert [item.reset_type for item in snapshot.resets] == ["regular", "banked", "regular"]
    assert snapshot.stats.longest_interval_days == pytest.approx(7.0)
    assert snapshot.stats.total == 3
    assert snapshot.latest_reset.id == "three"
    assert all("authorization" not in request.headers for request in seen)
    assert seen[1].url.params["limit"] == "100"
    assert seen[1].url.params["order"] == "asc"
    assert seen[2].url.params["cursor"] == "next_page"
    assert all(item.id != "scheduled" for item in snapshot.resets)


def test_a_status_304_revalidates_the_previous_complete_snapshot_without_listing_again():
    latest = reset("three", "2026-09-10T05:30:00Z")
    calls = 0

    def initial(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json=status(latest), headers={"ETag": '"status-1"'})
        return httpx.Response(200, json=page([latest]))

    async def first_fetch():
        async with httpx.AsyncClient(transport=httpx.MockTransport(initial)) as client:
            return await fetch_codex_resets(client, now=lambda: NOW)

    previous = asyncio.run(first_fetch())

    def unchanged(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.url.path.endswith("/status")
        assert request.headers["If-None-Match"] == '"status-1"'
        return httpx.Response(304)

    async def second_fetch():
        async with httpx.AsyncClient(transport=httpx.MockTransport(unchanged)) as client:
            return await fetch_codex_resets(
                client,
                previous=previous,
                now=lambda: datetime(2026, 9, 14, 16, tzinfo=UTC),
            )

    refreshed = asyncio.run(second_fetch())

    assert calls == 1
    assert refreshed.resets == previous.resets
    assert refreshed.fetched_at == datetime(2026, 9, 14, 16, tzinfo=UTC)
    assert refreshed.stale is False


def test_retry_after_is_preserved_on_rate_limits():
    def limited(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "75"})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(limited)) as client:
            return await fetch_codex_resets(client, now=lambda: NOW)

    with pytest.raises(CodexResetsProviderError) as raised:
        asyncio.run(run())

    assert raised.value.code == "rate-limited"
    assert raised.value.retry_after_seconds == 75
    assert raised.value.transient is True
