"""Opt-in, local-only psql test utilities. No production connection or credentials."""

import base64
import json
import queue
import re
import subprocess
import threading
import time
from uuid import uuid4

from app.services.airfare_supabase import AirfareHistoryRevisionChanged


class Session:
    def __init__(self, database):
        if not re.fullmatch(r"airfare_pagination_test_[a-f0-9]{32}", database):
            raise ValueError("Only an isolated airfare test database is allowed")
        self.process = subprocess.Popen(
            [
                "docker",
                "exec",
                "-i",
                "supabase_db_edicius-hq",
                "psql",
                "-U",
                "postgres",
                "-d",
                database,
                "-X",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.lines = queue.Queue()
        self.reader = threading.Thread(target=self._pump, daemon=True)
        self.reader.start()
        try:
            self.execute(
                f"set application_name='history_test_{uuid4().hex}'; "
                "set statement_timeout='10s'; set lock_timeout='5s'; "
                "set idle_in_transaction_session_timeout='20s'; "
                "set standard_conforming_strings=on;"
            )
            self.pid = int(self.execute("select pg_backend_pid();")[0])
            self.execute("""
                create function pg_temp.capture(q text) returns jsonb language plpgsql as $$
                declare result jsonb;
                begin
                  execute q into result;
                  return jsonb_build_object('data', result);
                exception when sqlstate 'PT409' then
                  if sqlerrm <> 'airfare_history_revision_changed' then raise; end if;
                  return jsonb_build_object('conflict', true);
                end $$;
            """)
        except BaseException:
            self.close()
            raise

    def _pump(self):
        for line in self.process.stdout:
            self.lines.put(line.rstrip("\r\n"))
        self.lines.put(None)

    def send(self, sql):
        marker = "barrier_" + uuid4().hex
        self.process.stdin.write(sql + "\n\\echo " + marker + "\n")
        self.process.stdin.flush()
        return marker

    def receive(self, marker):
        result = []
        deadline = time.monotonic() + 15
        while True:
            line = self.lines.get(timeout=max(0.01, deadline - time.monotonic()))
            if line == marker:
                return result
            if line is None:
                raise AssertionError("Local psql failed: " + "\n".join(result))
            result.append(line)

    def execute(self, sql):
        return self.receive(self.send(sql))

    def json(self, expression):
        return json.loads(self.execute("select " + expression + ";")[-1])

    def bound(self, sql, value):
        # Only base64 crosses psql's metacommand parser; :'input' quotes it again.
        encoded = base64.b64encode(json.dumps(value, ensure_ascii=False).encode()).decode()
        return self.execute("\\set input " + encoded + "\n" + sql)

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.write("rollback;\n\\q\n")
                self.process.stdin.flush()
                self.process.wait(timeout=2)
            except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=5)
        self.process.stdin.close()
        self.reader.join(timeout=2)
        self.process.stdout.close()


JSON_INPUT = "convert_from(decode(:'input','base64'),'UTF8')::jsonb"
TABLES = {
    "fare_snapshots": "record_id origin destination flight_date captured_at captured_at_text source_line source currency cheapest_price payload",
    "fare_baseline_points": "record_id origin destination flight_date price_date price currency source payload",
    "fare_calendar_captures": "record_id origin destination captured_at source_line from_date to_date source currency payload",
    "fare_checks": "record_id kind origin destination flight_date checked_at outcome offers cheapest error_code payload",
    "fare_airports": "code name city country latitude longitude payload",
    "airfare_documents": "key value source_updated_at",
    "airfare_import_runs": "run_id mode started_at completed_at status source_manifest destination_manifest error",
}
CONFLICTS = {table: "record_id" for table in TABLES}
CONFLICTS.update(
    fare_baseline_points="origin,destination,flight_date,price_date",
    fare_airports="code",
    airfare_documents="key",
    airfare_import_runs="run_id",
)
FILTERS = dict(
    p_origin="CON",
    p_destination="DST",
    p_departure=None,
    p_snapshot_months=None,
    p_since=None,
    p_until=None,
)
RPC_TYPES = dict.fromkeys(FILTERS, "text") | {"p_snapshot_months": "text[]"}


class LocalReplica:
    def __init__(self, session):
        self.session = session

    def upsert(self, table, rows, *, on_conflict):
        if table not in TABLES or on_conflict != CONFLICTS[table]:
            raise ValueError("Unapproved test upsert")
        if not rows:
            return
        columns = list(rows[0])
        if not set(columns) <= set(TABLES[table].split()) or any(
            set(r) != set(columns) for r in rows
        ):
            raise ValueError("Unapproved test columns")
        names = ",".join(columns)
        updates = ",".join(f"{c}=excluded.{c}" for c in columns if c not in on_conflict.split(","))
        self.session.bound(
            f"begin; set local role service_role; insert into public.{table} ({names}) "
            f"select {names} from jsonb_populate_recordset(null::public.{table},{JSON_INPUT}) "
            f"on conflict ({on_conflict}) do update set {updates}; commit;",
            rows,
        )

    def rpc(self, name, params):
        types = dict(RPC_TYPES)
        if name == "airfare_dataset_manifest":
            types = {}
        elif name == "read_airfare_history_meta":
            types["p_expected_revision"] = "text"
        elif name == "read_airfare_history_page":
            types.update(
                p_revision="text", p_dataset="text", p_cursor="jsonb", p_page_size="integer"
            )
        elif name != "read_airfare_history":
            raise ValueError("Unapproved test RPC")
        if not set(params) <= types.keys():
            raise ValueError("Unapproved test arguments")
        args = []
        for key, value in params.items():
            # JSON quoting has no physical newlines; PostgreSQL quotes are doubled.
            literal = "'" + json.dumps(value, ensure_ascii=False).replace("'", "''") + "'::jsonb"
            if types[key] == "text[]":
                expression = (
                    "null::text[]"
                    if value is None
                    else f"array(select jsonb_array_elements_text({literal}))"
                )
            elif types[key] == "jsonb":
                expression = "null::jsonb" if value is None else literal
            else:
                expression = f"({literal} #>> '{{}}')::{types[key]}"
            args.append(f"{key}=>{expression}")
        query = f"select public.{name}({','.join(args)})"
        result = self.session.bound(
            f"begin; set local role service_role; select pg_temp.capture({JSON_INPUT} #>> '{{}}'); commit;",
            query,
        )
        response = json.loads(result[-1])
        if response.get("conflict"):
            raise AirfareHistoryRevisionChanged("Airfare history revision changed")
        return response["data"]

    def select_all(self, table, columns, *, key, page_size=500):
        if (
            table not in TABLES
            or not set(columns) <= set(TABLES[table].split())
            or key not in columns
        ):
            raise ValueError("Unapproved test selection")
        names = ",".join(columns)
        rows = self.session.execute(
            f"begin; set local role service_role; select coalesce(jsonb_agg(t),'[]') "
            f"from (select {names} from public.{table} order by {key}) t; commit;"
        )
        return json.loads(rows[-1])


def clear_fixtures(session):
    session.execute("""truncate public.fare_snapshots, public.fare_baseline_points,
      public.fare_checks, public.fare_airports, public.fare_calendar_captures,
      public.airfare_documents, public.airfare_import_runs;""")


def seed(session):
    """A separate test DB owns only these synthetic rows; never reset its counter."""
    clear_fixtures(session)
    session.execute("""
      begin;
      set local role service_role;
      insert into public.fare_snapshots
        (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,payload)
      values (repeat('1',64),'CON','DST','2026-11-01','2026-09-19','2026-09-19T00:00:00Z',2,'test','USD','{"point":1}'),
             (repeat('2',64),'CON','DST','2026-12-01','2026-09-19','2026-09-19T00:00:00Z',3,'test','USD','{"point":2}');
      insert into public.fare_baseline_points
        (record_id,origin,destination,flight_date,price_date,price,currency,source,payload)
      values (repeat('3',64),'CON','DST','2026-11-01','2026-09-01',10,'USD','test','{"price":10}');
      insert into public.fare_checks
        (record_id,kind,origin,destination,flight_date,checked_at,outcome,payload)
      values (repeat('4',64),'board','CON','DST','2026-11-01','2026-09-19','changed','{}');
      insert into public.fare_airports(code,latitude,longitude,payload)
      values ('CON',0,0,'{"code":"CON","latitude":0,"longitude":0}');
      commit;
    """)


def wait_blocked(controller, blocked, blocker):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if controller.json(f"to_jsonb({blocker.pid}=any(pg_blocking_pids({blocked.pid})))"):
            return
    raise AssertionError("Expected lock barrier was not reached")
