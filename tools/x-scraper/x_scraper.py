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
                "text": legacy.get("full_text", ""),
                "is_reply": bool(reply_to_id),
                "in_reply_to_id": reply_to_id,
                "in_reply_to_username": legacy.get("in_reply_to_screen_name"),
                "like_count": legacy.get("favorite_count", 0),
                "retweet_count": legacy.get("retweet_count", 0),
                "reply_count": legacy.get("reply_count", 0),
                "url": f"https://x.com/{author}/status/{tweet_id}",
            }
        )
        seen.add(tweet_id)
    return tweets
