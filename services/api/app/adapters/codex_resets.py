from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from itertools import pairwise
from typing import Any, Literal, cast

import httpx

from app.config import UPSTREAM_TIMEOUT_SECONDS

CODEX_RESETS_BASE_URL = "https://codex-resets.com/api/v1"
ResetType = Literal["regular", "banked"]
SourceType = Literal["x_post", "observed"]


class CodexResetsProviderError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        transient: bool,
        retry_after_seconds: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.transient = transient
        self.retry_after_seconds = retry_after_seconds


class CodexResetsPayloadError(CodexResetsProviderError):
    def __init__(self, message: str) -> None:
        super().__init__("invalid-payload", message, transient=False)


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _datetime(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise CodexResetsPayloadError(f"{field} must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CodexResetsPayloadError(f"{field} is not a valid timestamp") from exc
    if parsed.tzinfo is None:
        raise CodexResetsPayloadError(f"{field} needs a timezone")
    return parsed.astimezone(UTC)


def _object(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CodexResetsPayloadError(f"{field} must be an object")
    return cast(dict[str, Any], value)


@dataclass(frozen=True, slots=True)
class CodexResetSource:
    type: SourceType
    url: str
    author: str | None = None

    def to_wire(self) -> dict[str, str]:
        result = {"type": self.type, "url": self.url}
        if self.author is not None:
            result["author"] = self.author
        return result

    @classmethod
    def from_wire(cls, value: object) -> CodexResetSource:
        source = _object(value, "source")
        source_type = source.get("type")
        if source_type not in {"x_post", "observed"}:
            raise CodexResetsPayloadError("source.type is invalid")
        url = source.get("url")
        if not isinstance(url, str) or not url.startswith("https://"):
            raise CodexResetsPayloadError("source.url is invalid")
        author = source.get("author")
        if author is not None and not isinstance(author, str):
            raise CodexResetsPayloadError("source.author is invalid")
        return cls(type=cast(SourceType, source_type), url=url, author=author)


@dataclass(frozen=True, slots=True)
class CodexReset:
    id: str
    reset_type: ResetType
    announced_at: datetime
    text: str
    source: CodexResetSource

    def to_wire(self) -> dict[str, object]:
        return {
            "id": self.id,
            "resetType": self.reset_type,
            "announcedAt": _iso(self.announced_at),
            "text": self.text,
            "source": self.source.to_wire(),
        }

    @classmethod
    def from_wire(cls, value: object) -> CodexReset:
        item = _object(value, "reset")
        reset_id = item.get("id")
        text = item.get("text")
        reset_type = item.get("reset_type", item.get("resetType"))
        announced_at = item.get("announced_at", item.get("announcedAt"))
        if not isinstance(reset_id, str) or not reset_id:
            raise CodexResetsPayloadError("reset.id is invalid")
        if reset_type not in {"regular", "banked"}:
            raise CodexResetsPayloadError("reset.reset_type is invalid")
        if not isinstance(text, str):
            raise CodexResetsPayloadError("reset.text is invalid")
        return cls(
            id=reset_id,
            reset_type=cast(ResetType, reset_type),
            announced_at=_datetime(announced_at, "reset.announced_at"),
            text=text,
            source=CodexResetSource.from_wire(item.get("source")),
        )


@dataclass(frozen=True, slots=True)
class CodexResetStats:
    total: int
    avg_interval_days: float | None
    longest_interval_days: float | None

    def to_wire(self) -> dict[str, int | float | None]:
        return {
            "total": self.total,
            "avgIntervalDays": self.avg_interval_days,
            "longestIntervalDays": self.longest_interval_days,
        }

    @classmethod
    def from_wire(cls, value: object) -> CodexResetStats:
        stats = _object(value, "stats")
        total = stats.get("total")
        average = stats.get("avgIntervalDays", stats.get("avg_interval_days"))
        longest = stats.get("longestIntervalDays")
        if isinstance(total, bool) or not isinstance(total, int) or total < 0:
            raise CodexResetsPayloadError("stats.total is invalid")
        for field, number in (("average", average), ("longest", longest)):
            if number is not None and (
                isinstance(number, bool) or not isinstance(number, int | float)
            ):
                raise CodexResetsPayloadError(f"stats.{field} is invalid")
        return cls(
            total=total,
            avg_interval_days=None if average is None else float(average),
            longest_interval_days=None if longest is None else float(longest),
        )


@dataclass(frozen=True, slots=True)
class CodexResetsSnapshot:
    fetched_at: datetime
    generated_at: datetime
    etag: str | None
    stale: bool
    latest_reset: CodexReset | None
    stats: CodexResetStats
    resets: tuple[CodexReset, ...]

    def to_wire(self) -> dict[str, object]:
        return {
            "source": "codex-resets.com",
            "fetchedAt": _iso(self.fetched_at),
            "generatedAt": _iso(self.generated_at),
            "stale": self.stale,
            "etag": self.etag,
            "latestReset": None if self.latest_reset is None else self.latest_reset.to_wire(),
            "stats": self.stats.to_wire(),
            "resets": [item.to_wire() for item in self.resets],
        }

    @classmethod
    def from_wire(cls, value: object) -> CodexResetsSnapshot:
        root = _object(value, "snapshot")
        resets = root.get("resets")
        if not isinstance(resets, list):
            raise CodexResetsPayloadError("snapshot.resets must be an array")
        latest = root.get("latestReset")
        etag = root.get("etag")
        if etag is not None and not isinstance(etag, str):
            raise CodexResetsPayloadError("snapshot.etag is invalid")
        return cls(
            fetched_at=_datetime(root.get("fetchedAt"), "snapshot.fetchedAt"),
            generated_at=_datetime(root.get("generatedAt"), "snapshot.generatedAt"),
            etag=etag,
            stale=bool(root.get("stale", False)),
            latest_reset=None if latest is None else CodexReset.from_wire(latest),
            stats=CodexResetStats.from_wire(root.get("stats")),
            resets=tuple(CodexReset.from_wire(item) for item in resets),
        )


def _retry_after(response: httpx.Response) -> int | None:
    try:
        return max(0, int(response.headers.get("Retry-After", "")))
    except ValueError:
        return None


def _raise_for_provider(response: httpx.Response) -> None:
    if response.status_code == 429:
        raise CodexResetsProviderError(
            "rate-limited",
            "Codex Resets rate-limited the request",
            transient=True,
            retry_after_seconds=_retry_after(response),
        )
    if response.status_code >= 500:
        raise CodexResetsProviderError(
            "upstream-error", "Codex Resets is temporarily unavailable", transient=True
        )
    if not response.is_success:
        raise CodexResetsProviderError(
            "upstream-error",
            f"Codex Resets returned HTTP {response.status_code}",
            transient=False,
        )


async def _get(client: httpx.AsyncClient, path: str, **kwargs: object) -> httpx.Response:
    try:
        return await client.get(
            f"{CODEX_RESETS_BASE_URL}{path}",
            headers=cast(dict[str, str] | None, kwargs.get("headers")),
            params=cast(dict[str, str | int] | None, kwargs.get("params")),
            timeout=UPSTREAM_TIMEOUT_SECONDS,
        )
    except (httpx.TimeoutException, httpx.RequestError) as exc:
        raise CodexResetsProviderError(
            "unreachable", "Codex Resets is unreachable", transient=True
        ) from exc


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        return _object(response.json(), "response")
    except ValueError as exc:
        raise CodexResetsPayloadError("Codex Resets returned invalid JSON") from exc


def _longest_interval(resets: tuple[CodexReset, ...]) -> float | None:
    if len(resets) < 2:
        return None
    ordered = sorted(item.announced_at for item in resets)
    return max((later - earlier).total_seconds() / 86_400 for earlier, later in pairwise(ordered))


async def fetch_codex_resets(
    client: httpx.AsyncClient,
    *,
    previous: CodexResetsSnapshot | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> CodexResetsSnapshot:
    """Read executed resets only; scheduled/watch records never enter the snapshot."""
    headers = {"Accept": "application/json"}
    if previous is not None and previous.etag:
        headers["If-None-Match"] = previous.etag
    status_response = await _get(client, "/status", headers=headers)
    if status_response.status_code == 304:
        if previous is None:
            raise CodexResetsPayloadError("status returned 304 without cached data")
        return replace(previous, fetched_at=now().astimezone(UTC), stale=False)
    _raise_for_provider(status_response)

    status_payload = _json(status_response)
    status_data = _object(status_payload.get("data"), "status.data")
    meta = _object(status_payload.get("meta"), "status.meta")
    latest_value = status_data.get("latest_reset")
    latest = None if latest_value is None else CodexReset.from_wire(latest_value)
    stats_value = _object(status_data.get("stats"), "status.stats")

    by_id: dict[str, CodexReset] = {}
    cursor: str | None = None
    seen_cursors: set[str] = set()
    for _ in range(100):
        params: dict[str, str | int] = {"limit": 100, "order": "asc"}
        if cursor is not None:
            params["cursor"] = cursor
        response = await _get(
            client, "/resets", headers={"Accept": "application/json"}, params=params
        )
        _raise_for_provider(response)
        payload = _json(response)
        rows = payload.get("data")
        if not isinstance(rows, list):
            raise CodexResetsPayloadError("resets.data must be an array")
        for row in rows:
            item = CodexReset.from_wire(row)
            by_id[item.id] = item
        pagination = _object(payload.get("pagination"), "resets.pagination")
        if pagination.get("has_more") is not True:
            break
        next_cursor = pagination.get("next_cursor")
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors:
            raise CodexResetsPayloadError("resets pagination cursor is invalid")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    else:
        raise CodexResetsPayloadError("resets pagination exceeded 100 pages")

    resets = tuple(sorted(by_id.values(), key=lambda item: (item.announced_at, item.id)))
    total = stats_value.get("total")
    average = stats_value.get("avg_interval_days")
    stats = CodexResetStats.from_wire(
        {
            "total": total,
            "avg_interval_days": average,
            "longestIntervalDays": _longest_interval(resets),
        }
    )
    return CodexResetsSnapshot(
        fetched_at=now().astimezone(UTC),
        generated_at=_datetime(meta.get("generated_at"), "status.meta.generated_at"),
        etag=status_response.headers.get("ETag"),
        stale=False,
        latest_reset=latest,
        stats=stats,
        resets=resets,
    )
