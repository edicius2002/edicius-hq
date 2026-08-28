"""Read-only local archive of captured X posts. Wire fields are camelCase."""

import json
from collections.abc import AsyncIterator
from dataclasses import asdict
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from app.config import tweets_dir
from app.services.sse import KEEP_ALIVE, sse
from app.services.tweet_refresh import RUNNER

router = APIRouter(prefix="/api/tweets", tags=["tweets"])
DEFAULT_HANDLE = "thsottiaux"


def _read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(
                {
                    "id": row.get("id"),
                    "date": row.get("date"),
                    "text": row.get("text", ""),
                    "isReply": row.get("is_reply", False),
                    "inReplyToId": row.get("in_reply_to_id"),
                    "inReplyToUsername": row.get("in_reply_to_username"),
                    "url": row.get("url"),
                }
            )
    return rows


@router.get("/{handle}")
def get_tweets(handle: str, limit: int = Query(default=500, ge=1, le=5000)) -> dict:
    # Empty is normal before the first scrape, so it is a stable empty collection rather than 404.
    rows = _read(tweets_dir() / f"{handle.lstrip('@')}.jsonl")

    # X stores RFC 2822-style dates; parse before slicing so limit means newest.
    def timestamp(row: dict):
        try:
            return parsedate_to_datetime(row["date"])
        except ValueError:
            return datetime.fromisoformat(row["date"]).astimezone()

    rows.sort(key=timestamp, reverse=True)
    return {"handle": handle.lstrip("@"), "tweets": rows[:limit]}


@router.post("/{handle}/refresh", status_code=202)
async def refresh(handle: str) -> dict:
    """
    Start one incremental capture, or answer with the one already running.

    `async` is not decoration. The runner hands its subprocess to
    `asyncio.create_task`, and a sync path operation is run in a threadpool
    where there is no loop to hand it to — the endpoint answered every request
    with `RuntimeError: no running event loop`, which is to say the button
    never worked once.
    """
    return asdict(RUNNER.refresh(handle.lstrip("@")))


@router.get("/{handle}/refresh")
async def refresh_status(handle: str) -> dict:
    """
    How the capture is going, or `idle`.

    Idle rather than 404 for a handle nothing has been started for: the caller
    is a page asking "is anything happening", and "no" is an answer rather than
    an error.
    """
    current = RUNNER.current()
    if current and current.handle == handle.lstrip("@"):
        return asdict(current)
    return {
        "handle": handle.lstrip("@"),
        "state": "idle",
        "scroll": 0,
        "new": 0,
        "error": None,
        "finishedAt": None,
    }


@router.post("/{handle}/watch", status_code=202)
async def start_watch(handle: str) -> dict:
    """Start the local two-minute watcher; it owns the Chromium profile."""
    return asdict(RUNNER.watch(handle.lstrip("@")))


@router.delete("/{handle}/watch", status_code=202)
async def stop_watch(handle: str) -> dict:
    await RUNNER.stop()
    current = RUNNER.current(handle.lstrip("@"))
    if current:
        return asdict(current)
    return {
        "handle": handle.lstrip("@"),
        "state": "idle",
        "scroll": 0,
        "new": 0,
        "error": None,
        "finishedAt": None,
    }


@router.get("/{handle}/stream")
async def stream_tweets(handle: str, request: Request) -> StreamingResponse:
    async def events() -> AsyncIterator[str]:
        with RUNNER.stream.subscribe() as updates:
            current = RUNNER.current(handle.lstrip("@"))
            if current:
                yield sse("watch", asdict(current))
            async for update in updates:
                if await request.is_disconnected():
                    return
                if not update:
                    yield KEEP_ALIVE
                    continue
                if update.moved:
                    current = RUNNER.current(handle.lstrip("@"))
                    if current:
                        yield sse("watch", asdict(current))
                if update.items:
                    yield sse("tweets", {"handle": handle.lstrip("@"), "new": len(update.items)})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
