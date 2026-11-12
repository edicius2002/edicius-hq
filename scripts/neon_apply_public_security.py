"""Apply the reviewed RLS and PostgREST compatibility SQL to Neon production.

This command prints only structural counts. It never echoes a URL or row.
"""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import urlparse

import psycopg

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env.local"
MIGRATIONS = (
    ROOT / "neon/migrations/20261111_trial_rls.sql",
    ROOT / "neon/migrations/20261111_public_compat.sql",
)


def connection_url() -> str:
    values = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip("\"'")
    if values.get("NEON_BRANCH") != "production":
        raise ValueError("expected Neon production branch")
    url = values.get("DATABASE_URL_UNPOOLED", "")
    parsed = urlparse(url)
    if parsed.scheme not in {"postgres", "postgresql"} or not (parsed.hostname or "").endswith(
        ".neon.tech"
    ):
        raise ValueError("expected direct Neon connection")
    if "-pooler" in (parsed.hostname or ""):
        raise ValueError("schema migrations require direct connection")
    return url


def count(cursor: psycopg.Cursor, statement: str) -> int:
    cursor.execute(statement)
    row = cursor.fetchone()
    assert row is not None
    return int(row[0])


def main() -> None:
    url = connection_url()
    with psycopg.connect(url, connect_timeout=15) as connection, connection.cursor() as cursor:
        tables = count(cursor, "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
        policies = count(cursor, "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")
        if tables != 21 or policies != 0:
            raise ValueError(
                f"unexpected production preflight: tables={tables}, policies={policies}"
            )
        print(f"preflight_tables={tables} preflight_policies={policies}")
        for migration in MIGRATIONS:
            cursor.execute(migration.read_text(encoding="utf-8"))
        protected = count(
            cursor,
            "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity",
        )
        policies = count(cursor, "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")
        if protected != 27 or policies != 13:
            raise ValueError(
                f"security postflight mismatch: protected={protected}, policies={policies}"
            )
        print(f"postflight_rls_tables={protected} postflight_policies={policies}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - redact SQL and connection details
        print(
            f"security_migration_failed={type(error).__name__},sqlstate={getattr(error, 'sqlstate', None)}"
        )
        sys.exit(1)
