"""Server-only Neon replica writer for the authoritative Pi Airfare journals."""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from threading import Event
from typing import Any
from urllib.parse import urlsplit

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.services.airfare_supabase import (
    AirfareRemoteRejected,
    AirfareRemoteUnavailable,
    SupabaseAirfare,
)

_CONFLICT = {
    "airfare_import_runs": ("run_id",),
    "fare_snapshots": ("record_id",),
    "fare_baseline_points": ("origin", "destination", "flight_date", "price_date"),
    "fare_calendar_captures": ("record_id",),
    "fare_checks": ("record_id",),
    "fare_airports": ("code",),
    "airfare_documents": ("key",),
}
_JSON_COLUMNS = frozenset({"payload", "value", "source_manifest", "destination_manifest"})
_VERIFY_COLUMNS = {
    "fare_snapshots": frozenset({"record_id"}),
    "fare_baseline_points": frozenset({"record_id"}),
    "fare_calendar_captures": frozenset({"record_id"}),
    "fare_checks": frozenset({"record_id", "kind"}),
    "fare_airports": frozenset({"code", "payload"}),
    "airfare_documents": frozenset({"key", "value", "source_updated_at"}),
}


class NeonAirfare(SupabaseAirfare):
    """Implement the existing AirfareSync boundary through protected Postgres."""

    def __init__(self, database_url: str) -> None:
        try:
            parsed = urlsplit(database_url)
            host = parsed.hostname or ""
        except ValueError:
            raise ValueError("invalid Neon Airfare database URL") from None
        if parsed.scheme not in {"postgres", "postgresql"} or not host.endswith(".neon.tech"):
            raise ValueError("Neon Airfare requires a Neon Postgres URL")
        self._database_url = database_url
        self._replica_id = host
        self._connection: psycopg.Connection[Any] | None = None
        self._closed = False

    @classmethod
    def from_environment(cls) -> NeonAirfare:
        value = os.getenv("DATABASE_URL", "").strip()
        if not value:
            raise ValueError("DATABASE_URL is required for Neon Airfare sync")
        return cls(value)

    @property
    def replica_id(self) -> str:
        return self._replica_id

    @property
    def is_closed(self) -> bool:
        return self._closed

    def _query(
        self, statement: sql.Composed | sql.SQL | str, values: Sequence[object] = ()
    ) -> list[dict[str, Any]]:
        if self._closed:
            raise AirfareRemoteUnavailable("Neon Airfare connection is closed")
        try:
            connection = self._connection
            if connection is None or connection.closed:
                connection = psycopg.connect(
                    self._database_url,
                    connect_timeout=15,
                    row_factory=dict_row,
                    autocommit=True,
                )
                self._connection = connection
            with connection.cursor() as cursor:
                cursor.execute(statement, tuple(values))
                return list(cursor.fetchall()) if cursor.description else []
        except (psycopg.OperationalError, psycopg.InterfaceError):
            self._discard_connection()
            raise AirfareRemoteUnavailable("Neon Airfare connection is unavailable") from None
        except psycopg.Error as error:
            raise AirfareRemoteRejected(
                f"Neon Airfare query was rejected ({error.sqlstate or 'unknown'})"
            ) from None

    def upsert(
        self, table: str, rows: Sequence[Mapping[str, object]], *, on_conflict: str
    ) -> object:
        keys = _CONFLICT.get(table)
        if keys is None or on_conflict != ",".join(keys):
            raise ValueError("invalid Neon Airfare upsert target")
        if not rows:
            return None
        columns = tuple(rows[0])
        if not columns or any(set(row) != set(columns) for row in rows):
            raise ValueError("inconsistent Neon Airfare batch")
        if not set(keys) <= set(columns):
            raise ValueError("missing Neon Airfare conflict columns")
        updates = tuple(column for column in columns if column not in keys)
        if not updates:
            raise ValueError("Neon Airfare upsert has no update columns")
        placeholders = sql.SQL(",").join(
            sql.SQL("(") + sql.SQL(",").join(sql.Placeholder() for _ in columns) + sql.SQL(")")
            for _ in rows
        )
        statement = sql.SQL(
            "INSERT INTO public.{} AS target ({}) VALUES {} "
            "ON CONFLICT ({}) DO UPDATE SET {} WHERE {}"
        ).format(
            sql.Identifier(table),
            sql.SQL(",").join(map(sql.Identifier, columns)),
            placeholders,
            sql.SQL(",").join(map(sql.Identifier, keys)),
            sql.SQL(",").join(
                sql.SQL("{}=EXCLUDED.{}").format(sql.Identifier(column), sql.Identifier(column))
                for column in updates
            ),
            sql.SQL(" OR ").join(
                sql.SQL("target.{} IS DISTINCT FROM EXCLUDED.{}").format(
                    sql.Identifier(column), sql.Identifier(column)
                )
                for column in updates
            ),
        )
        values = [
            Jsonb(row[column])
            if column in _JSON_COLUMNS and row[column] is not None
            else row[column]
            for row in rows
            for column in columns
        ]
        self._query(statement, values)
        return None

    def rpc(
        self, name: str, params: Mapping[str, object], *, timeout_seconds: float | None = None
    ) -> Any:
        if timeout_seconds is not None and timeout_seconds <= 0:
            raise ValueError("invalid Neon Airfare RPC timeout")
        if name == "airfare_dataset_manifest" and not params:
            rows = self._query("SELECT public.airfare_dataset_manifest() AS value")
            return rows[0]["value"] if rows else None
        if name == "list_fare_projection_dirty_routes" and not params:
            return self._query(
                "SELECT origin,destination FROM public.list_fare_projection_dirty_routes()"
            )
        if name == "refresh_fare_route_projection" and set(params) == {"p_origin", "p_destination"}:
            rows = self._query(
                "SELECT public.refresh_fare_route_projection(%s::text,%s::text) AS value",
                (params["p_origin"], params["p_destination"]),
            )
            return rows[0]["value"] if rows else None
        raise ValueError("invalid Neon Airfare RPC")

    def select_all(
        self, table: str, columns: Sequence[str], *, key: str, page_size: int = 500
    ) -> list[dict[str, Any]]:
        allowed = _VERIFY_COLUMNS.get(table)
        if (
            allowed is None
            or not columns
            or not set(columns) <= allowed
            or key not in columns
            or key not in {"record_id", "code", "key"}
            or isinstance(page_size, bool)
            or not 1 <= page_size <= 500
        ):
            raise ValueError("invalid Neon Airfare verification selection")
        statement = sql.SQL("SELECT {} FROM public.{} ORDER BY {}").format(
            sql.SQL(",").join(map(sql.Identifier, columns)),
            sql.Identifier(table),
            sql.Identifier(key),
        )
        return self._query(statement)

    def read_history(
        self, params: Mapping[str, object], *, cancel_event: Event | None = None
    ) -> dict[str, Any]:
        raise AirfareRemoteRejected("Neon Airfare direct history reads are not configured")

    def _discard_connection(self) -> None:
        connection = self._connection
        self._connection = None
        if connection is not None:
            connection.close()

    def close(self) -> None:
        self._closed = True
        self._discard_connection()
