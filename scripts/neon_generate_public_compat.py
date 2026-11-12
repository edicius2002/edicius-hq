"""Derive a reviewed Neon compatibility migration from a public-only pg_dump.

The dump contains schema definitions, not table rows. Existing selected tables
are created by neon-migration-trial.py; this adds omitted empty operational and
history tables, functions, indexes, constraints, and triggers. It deliberately
does not import history rows or Supabase role/default-privilege grants.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

OMITTED = {
    "airfare_import_runs",
    "collector_requests",
    "collector_runs",
    "fare_baseline_points",
    "fare_checks",
    "fare_snapshots",
}

TABLE = re.compile(
    r'^CREATE TABLE IF NOT EXISTS "public"\."([a-z_]+)" \(\n.*?\n\);',
    re.MULTILINE | re.DOTALL,
)
KEY = re.compile(
    r'^ALTER TABLE ONLY "public"\."([a-z_]+)"\n'
    r"\s+ADD CONSTRAINT [^;]* (?:PRIMARY KEY|UNIQUE) [^;]*;",
    re.MULTILINE,
)
FOREIGN_KEY = re.compile(
    r'^ALTER TABLE ONLY "public"\."[a-z_]+"\n'
    r"\s+ADD CONSTRAINT [^;]* FOREIGN KEY [^;]*;",
    re.MULTILINE,
)
INDEX = re.compile(r"^CREATE (?:UNIQUE )?INDEX [^\n]+;$", re.MULTILINE)
TRIGGER = re.compile(r"^CREATE OR REPLACE TRIGGER [^\n]+;$", re.MULTILINE)
AUTH_GRANT = re.compile(r'^GRANT ALL ON FUNCTION [^\n]+ TO "authenticated";$', re.MULTILINE)
FUNCTION_NAME = re.compile(r'^CREATE OR REPLACE FUNCTION "public"\."([a-z_]+)"')
BODY_MARKER = re.compile(r"\bAS (\$[A-Za-z_]*\$)")


def functions(schema: str) -> list[str]:
    lines = schema.splitlines(keepends=True)
    found: list[str] = []
    position = 0
    while position < len(lines):
        if not lines[position].startswith('CREATE OR REPLACE FUNCTION "public".'):
            position += 1
            continue
        if not FUNCTION_NAME.match(lines[position]):
            raise ValueError("unexpected function name")
        start = position
        marker = None
        position += 1
        while position < len(lines):
            if marker is None:
                match = BODY_MARKER.search(lines[position])
                if match:
                    marker = match.group(1)
            elif lines[position].rstrip().endswith(marker + ";"):
                found.append("".join(lines[start : position + 1]).strip())
                break
            position += 1
        else:
            raise ValueError("unterminated public function")
        position += 1
    return found


def generate(source: Path, target: Path) -> None:
    schema = source.read_text(encoding="utf-8")
    tables = {match.group(1): match.group(0) for match in TABLE.finditer(schema)}
    if OMITTED - tables.keys():
        raise ValueError("missing omitted table DDL")
    function_sql = [
        statement.replace("auth.uid()", "public.neon_owner_id()") for statement in functions(schema)
    ]
    if len(function_sql) < 40:
        raise ValueError("too few source functions")
    key_sql = [match.group(0) for match in KEY.finditer(schema) if match.group(1) in OMITTED]
    foreign_keys = [
        match.group(0)
        for match in FOREIGN_KEY.finditer(schema)
        if 'REFERENCES "auth"."users"' not in match.group(0)
    ]
    indexes = [match.group(0) for match in INDEX.finditer(schema)]
    triggers = [match.group(0) for match in TRIGGER.finditer(schema)]
    grants = [
        match.group(0).replace("GRANT ALL ON FUNCTION", "GRANT EXECUTE ON FUNCTION")
        for match in AUTH_GRANT.finditer(schema)
    ]
    if len(grants) < 15 or len(indexes) < 15:
        raise ValueError("source schema sections incomplete")

    sections = [
        "-- Generated from the public-only Supabase schema dump. No rows or secrets.",
        "-- The six omitted history/operational tables start empty.",
        "SET check_function_bodies = false;",
        "CREATE OR REPLACE FUNCTION public.neon_owner_id() RETURNS uuid "
        "LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' "
        "AS $$ SELECT NULLIF(auth.user_id(), '')::uuid $$;",
        *[tables[name] for name in sorted(OMITTED)],
        *key_sql,
        *[f"ALTER TABLE public.{name} ENABLE ROW LEVEL SECURITY;" for name in sorted(OMITTED)],
        *function_sql,
        *indexes,
        *foreign_keys,
        *triggers,
        "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;",
        "GRANT EXECUTE ON FUNCTION public.neon_owner_id() TO authenticated;",
        *grants,
    ]
    target.write_text("\n\n".join(sections) + "\n", encoding="utf-8")
    print(f"functions={len(function_sql)}")
    print(f"empty_tables={len(OMITTED)}")
    print(f"indexes={len(indexes)}")
    print(f"foreign_keys={len(foreign_keys)}")
    print(f"triggers={len(triggers)}")
    print(f"browser_function_grants={len(grants)}")


if __name__ == "__main__":
    try:
        generate(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as error:  # noqa: BLE001 - redact source schema details
        print(f"schema_generate_error={type(error).__name__}")
        raise SystemExit(1) from None
