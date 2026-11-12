"""Pi collector boundary backed by server-only Neon Postgres connections."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.services.collector_cloud import (
    _TABLES,
    CollectorCloud,
    CollectorCloudRejected,
    CollectorCloudUnavailable,
)

_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]*$")
_RPC = {
    "claim_seace_refresh_request": (
        "SELECT to_jsonb(public.claim_seace_refresh_request(%s::uuid)) AS value",
        ("p_owner_id",),
    ),
    "claim_collector_request": (
        "SELECT to_jsonb(public.claim_collector_request(%s::uuid,%s::text[])) AS value",
        ("p_owner_id", "p_operations"),
    ),
    "complete_collector_request": (
        "SELECT to_jsonb(public.complete_collector_request(%s::uuid,%s::jsonb)) AS value",
        ("p_request_id", "p_result"),
    ),
    "fail_collector_request": (
        "SELECT to_jsonb(public.fail_collector_request(%s::uuid,%s::text)) AS value",
        ("p_request_id", "p_error_code"),
    ),
    "merge_market_quote_ticks": (
        "SELECT to_jsonb(public.merge_market_quote_ticks(%s::uuid,%s::jsonb)) AS value",
        ("p_owner_id", "p_rows"),
    ),
    "update_collector_request_progress": (
        "SELECT to_jsonb(public.update_collector_request_progress(%s::uuid,%s::jsonb)) AS value",
        ("p_request_id", "p_progress"),
    ),
}


def _value(value: object) -> object:
    return Jsonb(value) if isinstance(value, dict) else value


class NeonCollectorCloud(CollectorCloud):
    """Keep the collector method contract while replacing service-role HTTP."""

    def __init__(self, database_url: str, owner_id: UUID) -> None:
        parsed = urlsplit(database_url)
        if parsed.scheme not in {"postgres", "postgresql"} or not (parsed.hostname or "").endswith(
            ".neon.tech"
        ):
            raise ValueError("Neon collector DATABASE_URL must be a Neon Postgres URL")
        self._database_url = database_url
        self._owner_id = owner_id

    @classmethod
    def from_environment(cls) -> NeonCollectorCloud:
        try:
            owner_id = UUID(os.environ["EDICIUS_OWNER_ID"])
        except (KeyError, ValueError):
            raise ValueError("EDICIUS_OWNER_ID must be a UUID") from None
        url = os.getenv("DATABASE_URL", "").strip()
        if not url:
            raise ValueError("DATABASE_URL must be configured for Neon collectors")
        return cls(url, owner_id)

    def _execute(
        self, statement: sql.SQL | sql.Composed | str, values: Sequence[object] = ()
    ) -> list[dict[str, Any]]:
        try:
            with (
                psycopg.connect(
                    self._database_url, connect_timeout=15, row_factory=dict_row
                ) as conn,
                conn.cursor() as cursor,
            ):
                cursor.execute(statement, tuple(_value(value) for value in values))
                return list(cursor.fetchall()) if cursor.description else []
        except (psycopg.OperationalError, psycopg.InterfaceError):
            raise CollectorCloudUnavailable("Neon collector connection is unavailable") from None
        except psycopg.Error as error:
            raise CollectorCloudRejected(
                f"Neon collector query was rejected ({error.sqlstate or 'unknown'})"
            ) from None

    def _select(self, table: str, filters: Mapping[str, str]) -> list[dict[str, Any]]:
        if table != "app_documents":
            raise CollectorCloudRejected("invalid Neon collector selection")
        selector = filters.get("document_key", "")
        if selector.startswith("eq."):
            keys = [selector[3:]]
        elif selector.startswith("in.(") and selector.endswith(")"):
            keys = selector[4:-1].split(",")
        else:
            raise CollectorCloudRejected("invalid Neon document filter")
        return self._execute(
            "SELECT document_key,payload FROM public.app_documents "
            "WHERE owner_id=%s::uuid AND document_key = ANY(%s::text[])",
            (str(self._owner_id), keys),
        )

    def _insert(self, table: str, row: dict[str, Any]) -> object:
        if table != "collector_runs" or row.get("owner_id") != str(self._owner_id):
            raise CollectorCloudRejected("invalid Neon collector run")
        result = self._execute(
            "INSERT INTO public.collector_runs(owner_id,collector,status) "
            "VALUES (%s::uuid,%s,%s) RETURNING run_id",
            (str(self._owner_id), row["collector"], row["status"]),
        )
        return result

    def _upsert(self, table: str, rows: Sequence[dict[str, Any]], conflict: str) -> int:
        if not rows:
            return 0
        if table not in _TABLES:
            raise CollectorCloudRejected("invalid Neon collector table")
        owned = [self._owner_row(row) for row in rows]
        columns = tuple(owned[0])
        if any(set(row) != set(columns) for row in owned):
            raise CollectorCloudRejected("Neon collector batch has inconsistent fields")
        keys = tuple(conflict.split(","))
        if not keys or any(key not in columns or not _IDENTIFIER.fullmatch(key) for key in keys):
            raise CollectorCloudRejected("invalid Neon conflict target")
        updates = tuple(column for column in columns if column not in keys)
        if not updates:
            raise CollectorCloudRejected("Neon collector upsert has no update fields")
        placeholders = sql.SQL(",").join(
            sql.SQL("(") + sql.SQL(",").join(sql.Placeholder() for _ in columns) + sql.SQL(")")
            for _ in owned
        )
        statement = sql.SQL(
            "INSERT INTO public.{} ({}) VALUES {} ON CONFLICT ({}) DO UPDATE SET {}"
        ).format(
            sql.Identifier(table),
            sql.SQL(",").join(map(sql.Identifier, columns)),
            placeholders,
            sql.SQL(",").join(map(sql.Identifier, keys)),
            sql.SQL(",").join(
                sql.SQL("{}=EXCLUDED.{}").format(sql.Identifier(column), sql.Identifier(column))
                for column in updates
            ),
        )
        self._execute(statement, [row[column] for row in owned for column in columns])
        return len(owned)

    def _update(self, table: str, run_id: UUID, body: dict[str, Any]) -> None:
        allowed = {
            "status",
            "heartbeat_at",
            "completed_at",
            "error_code",
            "records_seen",
            "records_written",
            "records_failed",
        }
        if table != "collector_runs" or not body or not set(body) <= allowed:
            raise CollectorCloudRejected("invalid Neon collector run update")
        assignments = []
        values: list[object] = []
        for key, value in body.items():
            if key in {"heartbeat_at", "completed_at"}:
                assignments.append(
                    sql.SQL("{}=GREATEST(now(),started_at)").format(sql.Identifier(key))
                )
            else:
                assignments.append(sql.SQL("{}=%s").format(sql.Identifier(key)))
                values.append(value)
        statement = sql.SQL(
            "UPDATE public.collector_runs SET {} WHERE run_id=%s::uuid AND owner_id=%s::uuid AND status='running'"
        ).format(sql.SQL(",").join(assignments))
        self._execute(statement, (*values, str(run_id), str(self._owner_id)))

    def _rpc(self, name: str, body: dict[str, Any]) -> object:
        query: str
        names: tuple[str, ...]
        if name == "claim_collector_request" and "p_excluded_pairs" in body:
            query = "SELECT to_jsonb(public.claim_collector_request(%s::uuid,%s::text[],%s::text[])) AS value"
            names = ("p_owner_id", "p_operations", "p_excluded_pairs")
        else:
            try:
                query, names = _RPC[name]
            except KeyError:
                raise CollectorCloudRejected("invalid Neon collector RPC") from None
        if set(body) != set(names):
            raise CollectorCloudRejected("invalid Neon collector RPC arguments")
        result = self._execute(
            query,
            [Jsonb(body[name]) if name == "p_rows" else body[name] for name in names],
        )
        return result[0]["value"] if result else None

    def list_cached_bars(self) -> list[dict[str, Any]]:
        return self._execute(
            "SELECT symbol,timeframe,extended,fetched_at,expires_at FROM public.market_bars "
            "WHERE owner_id=%s::uuid ORDER BY expires_at,symbol,timeframe,extended",
            (str(self._owner_id),),
        )

    def prune_operational_history(self, *, apply: bool, batch_size: int) -> dict[str, Any]:
        """Invoke the bounded retention RPC through the server connection."""
        if not 1 <= batch_size <= 500:
            raise ValueError("invalid Neon retention batch size")
        rows = self._execute(
            "SELECT public.prune_operational_history(%s::boolean,%s::integer) AS value",
            (apply, batch_size),
        )
        value = rows[0]["value"] if rows else None
        if not isinstance(value, dict):
            raise CollectorCloudRejected("invalid Neon retention response")
        return value

    def broadcast_quote_ticks(self, ticks: Sequence[Mapping[str, Any]]) -> int:
        return 0  # Browser quotes use bounded polling in Neon mode.

    def broadcast_live_bars(self, bars: Sequence[Mapping[str, Any]]) -> int:
        return 0

    def close(self) -> None:
        pass  # Connections are scoped to each operation.
