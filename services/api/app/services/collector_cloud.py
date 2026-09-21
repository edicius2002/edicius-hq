"""The Pi collectors' only service-role Supabase Data API boundary."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from math import isfinite
from threading import RLock
from types import MappingProxyType
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import httpx

from app.config import CollectorConfig, collector_config

LOGGER = logging.getLogger(__name__)
_PROJECT_HOST = re.compile(r"^[a-z0-9]+\.supabase\.co$")
_ERROR_CODE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_COLLECTORS = frozenset({"airfare", "airfare-requests", "x-posts", "sentiment", "market"})
_OPERATIONS = frozenset({"market-bars", "market-search", "airfare-route"})
_PROGRESS_STAGES = frozenset({"queued", "collecting", "syncing"})
_TABLES = frozenset(
    {
        "app_documents",
        "collector_runs",
        "tweet_posts",
        "sentiment_snapshots",
        "market_quotes",
        "market_bars",
    }
)
_RPCS = frozenset(
    {
        "claim_collector_request",
        "complete_collector_request",
        "fail_collector_request",
        "merge_market_quote_ticks",
        "update_collector_request_progress",
    }
)


class CollectorCloudError(RuntimeError):
    """A sanitized failure at the collector cloud boundary."""


class CollectorCloudUnavailable(CollectorCloudError):
    """A retryable network, rate-limit, or server failure."""


class CollectorCloudRejected(CollectorCloudError):
    """A non-retryable request, response, or state-transition failure."""


@dataclass(frozen=True, slots=True)
class CollectorRequest:
    id: UUID
    owner_id: UUID
    operation: str
    payload: Mapping[str, Any] = field(repr=False)
    expires_at: datetime


def _project_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        raise ValueError("Supabase URL must be an HTTPS project host") from None
    if (
        parsed.scheme != "https"
        or not hostname
        or not _PROJECT_HOST.fullmatch(hostname)
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Supabase URL must be an HTTPS project host")
    return url.rstrip("/")


def _object(value: object, kind: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CollectorCloudRejected(f"Supabase returned an invalid {kind}")
    return value


def _freeze(value: Any) -> Any:
    """Preserve JSON-shaped read access without allowing request mutation."""
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze(child) for key, child in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(child) for child in value)
    return value


def _utc_timestamp() -> str:
    return datetime.now(UTC).isoformat()


class CollectorCloud:
    """Allowlisted, owner-scoped operations used by the Pi collectors only."""

    def __init__(
        self,
        config: CollectorConfig,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        project_url = _project_url(config.url)
        if not config.secret_key:
            raise ValueError("Supabase secret key must not be empty")
        if not isfinite(config.timeout_seconds) or config.timeout_seconds <= 0:
            raise ValueError("Supabase timeout must be positive")
        self._owner_id = config.owner_id
        self._project_url = project_url
        self._client = httpx.Client(
            base_url=f"{project_url}/rest/v1/",
            headers={
                "apikey": config.secret_key,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            timeout=config.timeout_seconds,
            transport=transport,
            follow_redirects=False,
        )

    def document(self, key: str) -> dict[str, Any] | None:
        if not isinstance(key, str) or not key:
            raise CollectorCloudRejected("invalid document key")
        rows = self._select("app_documents", {"document_key": f"eq.{key}"})
        if not rows:
            return None
        return _object(rows[0].get("payload"), "document payload")

    @property
    def owner_id(self) -> UUID:
        """The configured owner for rows emitted through this boundary."""
        return self._owner_id

    def documents(self, keys: Sequence[str]) -> dict[str, dict[str, Any]]:
        return {key: value for key in keys if (value := self.document(key)) is not None}

    def begin_run(self, collector: str) -> UUID:
        if collector not in _COLLECTORS:
            raise CollectorCloudRejected("invalid collector")
        result = self._insert(
            "collector_runs",
            {"owner_id": str(self._owner_id), "collector": collector, "status": "running"},
        )
        row = self._one_row(result, "collector run")
        try:
            return UUID(str(row["run_id"]))
        except (KeyError, ValueError, TypeError):
            raise CollectorCloudRejected("Supabase returned an invalid collector run") from None

    def finish_run(self, run_id: UUID, records: Mapping[str, int]) -> None:
        values = self._record_values(records)
        timestamp = _utc_timestamp()
        self._update(
            "collector_runs",
            run_id,
            {"status": "complete", "heartbeat_at": timestamp, "completed_at": timestamp, **values},
        )

    def heartbeat_run(self, run_id: UUID, records: Mapping[str, int]) -> None:
        """Advance useful-work health without changing the active run state."""
        self._update(
            "collector_runs",
            run_id,
            {"heartbeat_at": _utc_timestamp(), **self._record_values(records)},
        )

    def fail_run(self, run_id: UUID, code: str) -> None:
        self._validate_error_code(code)
        timestamp = _utc_timestamp()
        self._update(
            "collector_runs",
            run_id,
            {
                "status": "failed",
                "error_code": code,
                "heartbeat_at": timestamp,
                "completed_at": timestamp,
            },
        )

    def upsert_tweets(self, rows: Sequence[dict[str, Any]]) -> int:
        return self._upsert("tweet_posts", rows, "owner_id,handle,post_id")

    def upsert_sentiment(self, row: dict[str, Any]) -> None:
        self._upsert("sentiment_snapshots", [row], "owner_id,source,as_of")

    def upsert_quotes(self, rows: Sequence[dict[str, Any]]) -> int:
        return self._upsert("market_quotes", rows, "owner_id,symbol")

    def merge_quote_ticks(self, rows: Sequence[dict[str, Any]]) -> int:
        if not rows:
            return 0
        payload = []
        for row in rows:
            owned = self._owner_row(row)
            payload.append({key: value for key, value in owned.items() if key != "owner_id"})
        result = self._rpc(
            "merge_market_quote_ticks",
            {"p_owner_id": str(self._owner_id), "p_rows": payload},
        )
        if (
            isinstance(result, bool)
            or not isinstance(result, int)
            or not 0 <= result <= len(payload)
        ):
            raise CollectorCloudRejected("Supabase returned an invalid quote tick count")
        LOGGER.info("collector cloud quote ticks=%d", result)
        return result

    def broadcast_quote_ticks(self, ticks: Sequence[Mapping[str, Any]]) -> int:
        if not ticks:
            return 0
        payload = [dict(tick) for tick in ticks]
        self._request(
            "POST",
            f"{self._project_url}/realtime/v1/api/broadcast/"
            f"market-quotes:{self._owner_id}/events/ticks",
            body={"ticks": payload},
            params={"private": "true"},
        )
        LOGGER.info("collector cloud quote broadcasts=%d", len(payload))
        return len(payload)

    def upsert_bars(self, row: dict[str, Any]) -> None:
        self._upsert("market_bars", [row], "owner_id,symbol,timeframe,extended")

    def claim_request(self, operations: Collection[str]) -> CollectorRequest | None:
        requested = tuple(operations)
        if (
            not requested
            or len(set(requested)) != len(requested)
            or any(operation not in _OPERATIONS for operation in requested)
        ):
            raise CollectorCloudRejected("invalid collector request operations")
        allowed = frozenset(requested)
        result = self._rpc(
            "claim_collector_request",
            {"p_owner_id": str(self._owner_id), "p_operations": list(requested)},
        )
        if result is None:
            return None
        row = self._one_row(result, "collector request")
        if row.get("request_id") is None:
            if any(value is not None for value in row.values()):
                raise CollectorCloudRejected("Supabase returned an invalid collector request")
            return None
        try:
            owner_id = UUID(str(row["owner_id"]))
            request = CollectorRequest(
                id=UUID(str(row["request_id"])),
                owner_id=owner_id,
                operation=str(row["operation"]),
                payload=_freeze(_object(row["payload"], "collector request payload")),
                expires_at=datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00")),
            )
        except (KeyError, TypeError, ValueError):
            raise CollectorCloudRejected("Supabase returned an invalid collector request") from None
        if request.owner_id != self._owner_id or request.operation not in allowed:
            raise CollectorCloudRejected("Supabase returned an invalid collector request")
        return request

    def update_request_progress(self, request_id: UUID, progress: Mapping[str, Any]) -> None:
        value = self._progress(progress)
        self._rpc(
            "update_collector_request_progress",
            {"p_request_id": str(self._uuid(request_id)), "p_progress": value},
        )

    def complete_request(self, request_id: UUID, result: Mapping[str, Any]) -> None:
        self._rpc(
            "complete_collector_request",
            {"p_request_id": str(self._uuid(request_id)), "p_result": self._result(result)},
        )

    def fail_request(self, request_id: UUID, code: str) -> None:
        self._validate_error_code(code)
        self._rpc(
            "fail_collector_request",
            {"p_request_id": str(self._uuid(request_id)), "p_error_code": code},
        )

    def close(self) -> None:
        self._client.close()

    def _select(self, table: str, filters: Mapping[str, str]) -> list[dict[str, Any]]:
        result = self._request(
            "GET",
            table,
            params={"select": "payload", "owner_id": f"eq.{self._owner_id}", **filters},
        )
        if not isinstance(result, list) or any(not isinstance(row, dict) for row in result):
            raise CollectorCloudRejected("Supabase returned an invalid selection")
        return result

    def _insert(self, table: str, row: dict[str, Any]) -> object:
        return self._request("POST", table, body=row, headers={"Prefer": "return=representation"})

    def _upsert(self, table: str, rows: Sequence[dict[str, Any]], conflict: str) -> int:
        if table not in _TABLES or not rows:
            if not rows:
                return 0
            raise CollectorCloudRejected("invalid collector table")
        payload = [self._owner_row(row) for row in rows]
        self._request(
            "POST",
            table,
            body=payload,
            params={"on_conflict": conflict},
            headers={"Prefer": "resolution=merge-duplicates"},
        )
        LOGGER.info("collector cloud rows=%d", len(payload))
        return len(payload)

    def _update(self, table: str, run_id: UUID, body: dict[str, Any]) -> None:
        self._request(
            "PATCH",
            table,
            body=body,
            params={
                "run_id": f"eq.{self._uuid(run_id)}",
                "owner_id": f"eq.{self._owner_id}",
                "status": "eq.running",
            },
        )

    def _rpc(self, name: str, body: dict[str, Any]) -> object:
        if name not in _RPCS:
            raise CollectorCloudRejected("invalid collector RPC")
        return self._request("POST", f"rpc/{name}", body=body)

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: object = None,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> object:
        try:
            response = self._client.request(method, path, json=body, params=params, headers=headers)
        except (httpx.TimeoutException, httpx.RequestError):
            raise CollectorCloudUnavailable("Supabase request is unavailable") from None
        if 300 <= response.status_code < 400:
            raise CollectorCloudRejected("Supabase returned an unexpected redirect")
        if response.status_code == 429 or response.status_code >= 500:
            raise CollectorCloudUnavailable(f"Supabase is unavailable ({response.status_code})")
        if response.status_code >= 400:
            raise CollectorCloudRejected(f"Supabase rejected the request ({response.status_code})")
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            raise CollectorCloudRejected("Supabase returned invalid JSON") from None

    def _owner_row(self, row: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(row, dict):
            raise CollectorCloudRejected("invalid collector row")
        owner = row.get("owner_id")
        if owner is not None and str(owner) != str(self._owner_id):
            raise CollectorCloudRejected("collector row has a different owner")
        return {**row, "owner_id": str(self._owner_id)}

    @staticmethod
    def _one_row(value: object, kind: str) -> dict[str, Any]:
        if isinstance(value, list) and len(value) == 1:
            return _object(value[0], kind)
        if isinstance(value, dict):
            return value
        raise CollectorCloudRejected(f"Supabase returned an invalid {kind}")

    @staticmethod
    def _uuid(value: UUID) -> UUID:
        if not isinstance(value, UUID):
            raise CollectorCloudRejected("invalid collector identifier")
        return value

    @staticmethod
    def _record_values(records: Mapping[str, int]) -> dict[str, int]:
        try:
            values: dict[str, int] = {
                "records_seen": records["seen"],
                "records_written": records["written"],
                "records_failed": records["failed"],
            }
        except (KeyError, TypeError):
            raise CollectorCloudRejected("invalid collector records") from None
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in values.values()
        ):
            raise CollectorCloudRejected("invalid collector records")
        return values

    @staticmethod
    def _validate_error_code(code: str) -> None:
        if not isinstance(code, str) or not _ERROR_CODE.fullmatch(code):
            raise CollectorCloudRejected("invalid collector error code")

    @staticmethod
    def _progress(progress: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(progress, Mapping) or set(progress) != {"stage", "completed", "total"}:
            raise CollectorCloudRejected("invalid collector progress")
        stage = progress["stage"]
        completed = progress["completed"]
        total = progress["total"]
        if (
            stage not in _PROGRESS_STAGES
            or isinstance(completed, bool)
            or not isinstance(completed, int)
            or completed < 0
            or (
                total is not None
                and (isinstance(total, bool) or not isinstance(total, int) or total < completed)
            )
        ):
            raise CollectorCloudRejected("invalid collector progress")
        return {"stage": stage, "completed": completed, "total": total}

    @staticmethod
    def _result(result: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(result, Mapping) or not all(isinstance(key, str) for key in result):
            raise CollectorCloudRejected("invalid collector result")
        try:
            copied = dict(result)
            json.dumps(copied)
        except (TypeError, ValueError):
            raise CollectorCloudRejected("invalid collector result") from None
        return copied


_configured_cloud: CollectorCloud | None = None
_configured_cloud_lock = RLock()


def configured_collector_cloud() -> CollectorCloud:
    """Create the process-wide collector cloud client from fail-closed configuration."""
    global _configured_cloud
    with _configured_cloud_lock:
        if _configured_cloud is None:
            _configured_cloud = CollectorCloud(collector_config())
        return _configured_cloud
