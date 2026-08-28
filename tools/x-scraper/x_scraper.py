"""Shared, dependency-light helpers for the Playwright X timeline scripts."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any


def _walk(value: Any) -> Iterator[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _unwrap_tweet(result: dict[str, Any]) -> dict[str, Any]:
    while isinstance(result.get("tweet"), dict):
        result = result["tweet"]
    return result


def extract_tweets(payload: dict[str, Any], username: str) -> list[dict[str, Any]]:
    """Extract the target's Tweet objects from an X GraphQL response."""
    wanted = username.lstrip("@").lower()
    tweets: list[dict[str, Any]] = []
    seen: set[str] = set()

    for candidate in _walk(payload):
        if not isinstance(candidate.get("legacy"), dict) or not candidate.get(
            "rest_id"
        ):
            continue
        tweet = _unwrap_tweet(candidate)
        legacy = tweet.get("legacy")
        core = tweet.get("core")
        if not isinstance(legacy, dict) or not isinstance(core, dict):
            continue
        user_result = core.get("user_results", {}).get("result", {})
        # X moved the handle out of the user's `legacy` block and into `core`.
        # Both are read, newest first, so a payload of either shape parses and
        # the day it moves back nothing breaks.
        author = user_result.get("core", {}).get("screen_name") or user_result.get(
            "legacy", {}
        ).get("screen_name")
        tweet_id = str(tweet.get("rest_id", ""))
        if (
            not tweet_id
            or not isinstance(author, str)
            or author.lower() != wanted
            or tweet_id in seen
        ):
            continue

        reply_to_id = legacy.get("in_reply_to_status_id_str")
        tweets.append(
            {
                "id": tweet_id,
                "date": legacy.get("created_at"),
                "text": tweet.get("note_tweet", {}).get("note_tweet_results", {}).get("result", {}).get("text") or legacy.get("full_text", ""),
                "is_reply": bool(reply_to_id),
                "in_reply_to_id": reply_to_id,
                "in_reply_to_username": legacy.get("in_reply_to_screen_name"),
                "url": f"https://x.com/{author}/status/{tweet_id}",
            }
        )
        seen.add(tweet_id)
    return tweets


def bottom_cursors(payload: dict[str, Any]) -> list[str]:
    """Return bottom cursors exactly as X supplied them, including an empty one."""
    cursors: list[str] = []
    for candidate in _walk(payload):
        entry_id = candidate.get("entryId")
        content = candidate.get("content")
        if not isinstance(entry_id, str) or not entry_id.startswith("cursor-bottom-"):
            continue
        if isinstance(content, dict):
            value = content.get("value", "")
            cursors.append(value if isinstance(value, str) else "")
    return cursors


class CursorTracker:
    """Recognise a terminal timeline cursor without confusing a slow fetch for EOF."""

    def __init__(self, repeat_limit: int = 2) -> None:
        self.repeat_limit = repeat_limit
        self.last: str | None = None
        self.repeats = 0

    def observe(self, cursors: list[str]) -> bool:
        if not cursors:
            return False
        current = cursors[-1]
        if not current:
            return True
