"""Load the selected Supabase tables into a specified empty Neon branch.

This is an inventory and import rehearsal, not a production migration. It
requires private pg_dump files and an ignored Neon branch env file. It never
prints credentials or row values.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import psycopg
from psycopg import sql

TABLES = frozenset(
    {
        "edicius_owners",
        "app_documents",
        "finance_documents",
        "airfare_documents",
        "airfare_history_revision",
        "airport_catalog",
        "airport_coordinate_reference",
        "fare_airports",
        "fare_calendar_captures",
        "fare_month_projections",
        "fare_flight_projections",
        "fare_projection_dirty_routes",
        "fare_projection_dirty_months",
        "fx_observations",
        "market_bars",
        "market_quotes",
        "seace_exclusions",
        "seace_records",
        "seace_sync_state",
        "sentiment_snapshots",
        "tweet_posts",
    }
)
TABLE_DDL = re.compile(
    r'^CREATE TABLE IF NOT EXISTS "public"\."([a-z_]+)" \(\n.*?\n\);',
    re.MULTILINE | re.DOTALL,
)
KEY_DDL = re.compile(
    r'^ALTER TABLE ONLY "public"\."([a-z_]+)"\n'
    r"\s+ADD CONSTRAINT [^;]* (?:PRIMARY KEY|UNIQUE) [^;]*;",
    re.MULTILINE,
)
COPY_HEADER = re.compile(rb'^COPY "public"\."([a-z_]+)" \(')


def direct_url(env_file: Path) -> str:
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL_UNPOOLED="):
            value = line.split("=", 1)[1].strip()
            if value[:1] in {"'", '"'} and value[-1:] == value[:1]:
                value = value[1:-1]
            if value.startswith(("postgresql://", "postgres://")):
                return value
    raise ValueError("missing direct Neon URL")


def run(schema_dump: Path, data_dump: Path, env_file: Path, target_branch: str) -> None:
    if target_branch not in {"migration-trial-20261111", "production"}:
        raise ValueError("unexpected target branch")
    branch = next(
        (
            line.split("=", 1)[1].strip().strip('"')
            for line in env_file.read_text(encoding="utf-8").splitlines()
            if line.startswith("NEON_BRANCH=")
        ),
        None,
    )
    if branch != target_branch:
        raise ValueError("Neon branch does not match expected target")
    if target_branch == "production" and env_file.name != ".env.local":
        raise ValueError("production import requires the linked local env")
    schema = schema_dump.read_text(encoding="utf-8")
    table_ddl = {match.group(1): match.group(0) for match in TABLE_DDL.finditer(schema)}
    missing = TABLES - table_ddl.keys()
    if missing:
        raise ValueError("missing table definitions")
    # A source default relies on Supabase Auth; all imported rows supply owner_id.
    table_ddl["seace_exclusions"] = table_ddl["seace_exclusions"].replace(
        ' DEFAULT "auth"."uid"()', ""
    )
    keys = [match.group(0) for match in KEY_DDL.finditer(schema) if match.group(1) in TABLES]
    source_counts: dict[str, int] = {}
    with (
        psycopg.connect(direct_url(env_file)) as conn,
        conn.transaction(),
        conn.cursor() as cursor,
    ):
        cursor.execute("select count(*) from pg_tables where schemaname = 'public'")
        public_count = cursor.fetchone()
        if public_count is None or public_count[0] != 0:
            raise ValueError("target public schema is not empty")
        for table in sorted(TABLES):
            cursor.execute(table_ddl[table])
        with data_dump.open("rb") as dump:
            for header in dump:
                match = COPY_HEADER.match(header)
                if not match:
                    continue
                table = match.group(1).decode("ascii")
                if table in TABLES:
                    count = 0
                    with cursor.copy(header.decode("utf-8")) as copy:
                        for row in dump:
                            if row in {b"\\.\n", b"\\.\r\n"}:
                                break
                            copy.write(row)
                            count += 1
                    source_counts[table] = count
                    print(f"loaded={table} rows={count}", flush=True)
                else:
                    for row in dump:
                        if row in {b"\\.\n", b"\\.\r\n"}:
                            break
        if TABLES - source_counts.keys():
            raise ValueError("missing COPY sections")
        for statement in keys:
            cursor.execute(statement)
        for table, count in sorted(source_counts.items()):
            cursor.execute(sql.SQL("SELECT count(*) FROM public.{}").format(sql.Identifier(table)))
            actual_count = cursor.fetchone()
            if actual_count is None or actual_count[0] != count:
                raise ValueError("row count mismatch")
    print(f"validated_tables={len(source_counts)}", flush=True)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 5:
            raise ValueError("expected schema, data, env, and target branch")
        run(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4])
    except Exception as error:  # noqa: BLE001 - redact driver errors and row values
        # Driver exceptions can include connection strings or row values.
        print(f"import_error={type(error).__name__}", flush=True)
        print(f"sqlstate={getattr(error, 'sqlstate', None) or 'none'}", flush=True)
        raise SystemExit(1) from None
