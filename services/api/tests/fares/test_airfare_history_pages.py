import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path

import pytest
from history_replica import FILTERS, LocalReplica, Session, clear_fixtures, seed, wait_blocked

from app.services.airfare_history_pages import assemble_history
from app.services.airfare_supabase import (
    AirfareHistoryRevisionChanged,
    AirfareRemoteRejected,
    AirfareRemoteUnavailable,
)

FIXTURE_PATH = Path(__file__).resolve().parents[4] / "fixtures/airfare-history-pagination/v1.json"


def fixture():
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


class ScriptedRpc:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = []

    async def __call__(self, name, params):
        self.calls.append((name, dict(params)))
        reply = next(self.replies)
        if isinstance(reply, Exception):
            raise reply
        return copy.deepcopy(reply)


def replies(data):
    return [
        copy.deepcopy(data["meta"]),
        *copy.deepcopy(data["snapshotPages"]),
        *copy.deepcopy(data["baselinePages"]),
        copy.deepcopy(data["meta"]),
    ]


def run(rpc, data, *, check_cancelled=lambda: None, sleep=asyncio.sleep):
    return asyncio.run(
        assemble_history(rpc, data["filters"], check_cancelled=check_cancelled, sleep=sleep)
    )


def test_complete_history_preserves_shared_payloads_ties_and_bigints():
    data = fixture()
    rpc = ScriptedRpc(replies(data))
    assert run(rpc, data) == data["expected"]
    assert [name for name, _ in rpc.calls] == [
        "read_airfare_history_meta",
        "read_airfare_history_page",
        "read_airfare_history_page",
        "read_airfare_history_page",
        "read_airfare_history_meta",
    ]
    assert rpc.calls[-1][1]["p_expected_revision"] == data["meta"]["revision"]
    assert rpc.calls[2][1]["p_cursor"] == data["snapshotPages"][0]["nextCursor"]


@pytest.mark.parametrize(
    ("response", "path", "bad"),
    [
        (0, ["revision"], 9007199254740993),
        (0, ["revision"], "9223372036854775808"),
        (0, ["counts", "snapshots"], "04"),
        (0, ["counts", "snapshots"], "9007199254740993"),
        (0, ["counts", "snapshots"], "3"),
        (0, ["counts", "baseline"], True),
        (0, ["origin"], "XXX"),
        (0, ["protocolVersion"], True),
        (1, ["queryKey"], "wrong"),
        (1, ["revision"], "1"),
        (1, ["dataset"], "baseline"),
        (1, ["items"], []),
        (1, ["items", 0, "order", 1], 9007199254740992),
        (1, ["items", 0, "order", 1], "9223372036854775808"),
        (1, ["items", 0, "order", 2], "0" * 64),
        (1, ["items", 0, "payload"], []),
        (1, ["nextCursor", "after", 1], "9007199254740993"),
        (1, ["nextCursor", "dataset"], "baseline"),
        (1, ["nextCursor"], None),
        (2, ["items", 0, "order", 1], "1"),
        (2, ["items", 0, "recordId"], "1" * 64),
        (2, ["nextCursor"], {}),
        (3, ["items", 0, "order", 0], "2026-02-30"),
        (4, ["health", "checks"], 99),
        (4, ["counts", "snapshots"], "5"),
    ],
)
def test_malformed_or_incomplete_response_never_publishes(response, path, bad):
    data = fixture()
    wire = replies(data)
    target = wire[response]
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = bad
    with pytest.raises(AirfareRemoteRejected):
        run(ScriptedRpc(wire), data)


def test_duplicate_identity_is_rejected_even_with_plausible_cursor():
    data = fixture()
    wire = replies(data)
    wire[2]["items"][0] = copy.deepcopy(wire[1]["items"][0])
    with pytest.raises(AirfareRemoteRejected):
        run(ScriptedRpc(wire), data)


def test_final_revision_conflict_discards_every_accumulated_page():
    data = fixture()
    wire = replies(data)
    wire[-1] = AirfareHistoryRevisionChanged("changed")
    rpc = ScriptedRpc(wire + replies(data))
    delays = []

    async def sleep(seconds):
        delays.append(seconds)

    assert run(rpc, data, sleep=sleep) == data["expected"]
    assert delays == [0.1]
    assert len(rpc.calls) == 10


def test_revision_churn_stops_after_three_attempts():
    data = fixture()
    rpc = ScriptedRpc([AirfareHistoryRevisionChanged("changed")] * 4)
    delays = []

    async def sleep(seconds):
        delays.append(seconds)

    with pytest.raises(AirfareRemoteUnavailable, match="changed repeatedly"):
        run(rpc, data, sleep=sleep)
    assert len(rpc.calls) == 3
    assert delays == [0.1, 0.25]


@pytest.mark.parametrize(
    "error", [AirfareRemoteUnavailable("network"), AirfareRemoteRejected("denied")]
)
def test_late_nonrevision_failure_is_not_retried_or_returned_as_partial(error):
    data = fixture()
    wire = replies(data)
    wire[2] = error
    rpc = ScriptedRpc(wire)
    with pytest.raises(type(error)):
        run(rpc, data)
    assert len(rpc.calls) == 3


def test_zero_counts_skip_pages_but_not_final_validation():
    data = fixture()
    data["meta"]["counts"] = {"snapshots": "0", "baseline": "0"}
    data["expected"].update(snapshots=[], baseline=[])
    rpc = ScriptedRpc([data["meta"], data["meta"]])
    assert run(rpc, data) == data["expected"]
    assert len(rpc.calls) == 2


def test_legacy_airports_may_omit_optional_name_city_country():
    data = fixture()
    for document in (data["meta"], data["expected"]):
        for airport in document["airports"]:
            for key in ("name", "city", "country"):
                airport.pop(key)
    assert run(ScriptedRpc(replies(data)), data) == data["expected"]


def test_oversized_health_integer_is_protocol_rejection_not_overflow():
    data = fixture()
    data["meta"]["health"]["checks"] = 10**400
    with pytest.raises(AirfareRemoteRejected):
        run(ScriptedRpc(replies(data)), data)


@pytest.mark.parametrize("cancel_after", [0, 1, 2, 4, 5])
def test_cancellation_before_fetch_between_pages_and_before_publication(cancel_after):
    data = fixture()
    rpc = ScriptedRpc(replies(data))

    def check():
        if len(rpc.calls) >= cancel_after:
            raise AirfareRemoteUnavailable("cancelled")

    with pytest.raises(AirfareRemoteUnavailable, match="cancelled"):
        run(rpc, data, check_cancelled=check)
    assert len(rpc.calls) == cancel_after


def test_cancellation_during_backoff_prevents_restart():
    data = fixture()
    rpc = ScriptedRpc([AirfareHistoryRevisionChanged("changed")])
    cancelled = False

    def check():
        if cancelled:
            raise AirfareRemoteUnavailable("cancelled")

    async def sleep(seconds):
        nonlocal cancelled
        cancelled = True

    with pytest.raises(AirfareRemoteUnavailable, match="cancelled"):
        run(rpc, data, check_cancelled=check, sleep=sleep)
    assert len(rpc.calls) == 1


@pytest.fixture
def local_replica_sessions():
    database = os.environ.get("AIRFARE_TEST_DATABASE")
    if not database:
        pytest.skip("Opt-in Docker concurrency suite; use the PowerShell runner")
    sessions = []
    try:
        for _ in range(3):
            sessions.append(Session(database))
        seed(sessions[0])
        yield sessions
    finally:
        for session in reversed(sessions):
            session.close()
        if len(sessions) == 3:
            cleanup_session = Session(database)
            try:
                clear_fixtures(cleanup_session)
            finally:
                cleanup_session.close()


BEHIND_CURSOR = """insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,payload)
values (repeat('5',64),'CON','DST','2026-11-01','2026-09-19','2026-09-19T00:00:00Z',1,'test','USD','{"point":0}');
"""
INSERTS = {
    "fare_snapshots": BEHIND_CURSOR,
    "fare_baseline_points": """insert into public.fare_baseline_points
      (record_id,origin,destination,flight_date,price_date,price,currency,source,payload)
      values (repeat('6',64),'CON','DST','2026-11-01','2026-09-02',20,'USD','test','{"price":20}');""",
    "fare_checks": """insert into public.fare_checks
      (record_id,kind,origin,destination,flight_date,checked_at,outcome,payload)
      values (repeat('7',64),'board','CON','DST','2026-11-01','2026-09-20','error','{}');""",
    "fare_airports": """insert into public.fare_airports(code,latitude,longitude,payload)
      values ('DST',1,1,'{"code":"DST","latitude":1,"longitude":1}');""",
}
MUTATIONS = [
    (f"{table}:{operation}", table, operation, sql)
    for table in INSERTS
    for operation, sql in (
        ("insert", INSERTS[table]),
        ("update", f"update public.{table} set payload=payload || '{{\"updated\":true}}';"),
        ("delete", f"delete from public.{table};"),
        ("truncate", f"truncate public.{table};"),
    )
] + [
    (
        "source-line-backward",
        "fare_snapshots",
        "update",
        "update public.fare_snapshots set source_line=1 where record_id=repeat('2',64);",
    ),
    (
        "baseline-replacement",
        "fare_baseline_points",
        "update",
        """insert into public.fare_baseline_points
       (record_id,origin,destination,flight_date,price_date,price,currency,source,payload)
       values (repeat('8',64),'CON','DST','2026-11-01','2026-09-01',99,'USD','test','{"price":99}')
       on conflict(origin,destination,flight_date,price_date)
       do update set record_id=excluded.record_id,price=excluded.price,payload=excluded.payload;""",
    ),
    ("health-update", "fare_checks", "update", "update public.fare_checks set outcome='error';"),
    ("airport-update", "fare_airports", "update", "update public.fare_airports set latitude=10;"),
]


def page_params(meta, cursor=None):
    return FILTERS | dict(
        p_revision=meta["revision"], p_dataset="snapshots", p_cursor=cursor, p_page_size=1
    )


@pytest.mark.parametrize("label,table,operation,mutation", MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_local_replica_mutations_rollback_and_commit(
    local_replica_sessions, label, table, operation, mutation
):
    reader, writer, controller = local_replica_sessions
    replica = LocalReplica(reader)
    meta = replica.rpc("read_airfare_history_meta", FILTERS)
    first = replica.rpc("read_airfare_history_page", page_params(meta))
    assert first["nextCursor"] is not None
    assert (
        reader.json(
            f"to_jsonb(has_table_privilege('service_role','public.{table}','DELETE,TRUNCATE'))"
        )
        is False
    )
    role = "set local role service_role;" if operation in {"insert", "update"} else ""
    writer.execute("begin; " + role + mutation)
    if operation == "truncate":
        # TRUNCATE takes AccessExclusiveLock. It is not a counter-lock regression.
        pending = reader.send(
            "select public.read_airfare_history_meta('CON','DST',null,null,null,null);"
        )
        wait_blocked(controller, reader, writer)
        writer.execute("rollback;")
        assert json.loads(reader.receive(pending)[-1]) == meta
    else:
        assert replica.rpc("read_airfare_history_meta", FILTERS) == meta
        assert replica.rpc("read_airfare_history_page", page_params(meta)) == first
        writer.execute("rollback;")
    assert (
        replica.rpc(
            "read_airfare_history_meta", FILTERS | {"p_expected_revision": meta["revision"]}
        )
        == meta
    )
    writer.execute("begin; " + role + mutation + " commit;")
    for cursor in (None, first["nextCursor"]):
        with pytest.raises(AirfareHistoryRevisionChanged):
            replica.rpc("read_airfare_history_page", page_params(meta, cursor))
    with pytest.raises(AirfareHistoryRevisionChanged):
        replica.rpc(
            "read_airfare_history_meta", FILTERS | {"p_expected_revision": meta["revision"]}
        )
    assert int(replica.rpc("read_airfare_history_meta", FILTERS)["revision"]) > int(
        meta["revision"]
    )


def test_local_replica_harness_detects_unexpected_stale_success(local_replica_sessions):
    reader, _, _ = local_replica_sessions
    meta = LocalReplica(reader).rpc("read_airfare_history_meta", FILTERS)
    # A current revision must make the negative control fail closed, not print PASS.
    with pytest.raises(AssertionError, match="stale read unexpectedly succeeded"):
        reader.execute(f"""do $$ begin
          perform public.read_airfare_history_page('CON','DST',null,null,null,null,
            '{meta["revision"]}','snapshots',null,1);
          raise exception 'stale read unexpectedly succeeded';
        exception when serialization_failure then
          if sqlerrm <> 'airfare_history_revision_changed' then raise; end if;
        end $$;""")


def test_local_replica_long_statement_retains_one_snapshot(local_replica_sessions):
    reader, writer, controller = local_replica_sessions
    replica = LocalReplica(reader)
    before = replica.rpc("read_airfare_history_meta", FILTERS)
    lock_key = reader.pid  # PID is session-unique; release only this owned key.
    controller.execute(f"select pg_advisory_lock(191919,{lock_key});")
    try:
        pending = reader.send(f"""with gate as materialized (
          select pg_current_snapshot(),pg_advisory_xact_lock(191919,{lock_key}))
          select public.read_airfare_history_meta('CON','DST',null,null,null,null) from gate;""")
        wait_blocked(controller, reader, controller)
        writer.execute(BEHIND_CURSOR)
    finally:
        controller.execute(f"select pg_advisory_unlock(191919,{lock_key});")
    assert json.loads(reader.receive(pending)[-1]) == before
    with pytest.raises(AirfareHistoryRevisionChanged):
        replica.rpc(
            "read_airfare_history_meta", FILTERS | {"p_expected_revision": before["revision"]}
        )


def test_local_replica_two_writers_serialize_and_rollback(local_replica_sessions):
    reader, first, second = local_replica_sessions
    before = reader.json("to_jsonb(revision) from public.airfare_history_revision")
    first.execute(
        "begin; set local role service_role; update public.fare_snapshots set source_line=source_line+1;"
    )
    pending = second.send(
        "begin; set local role service_role; update public.fare_checks set outcome='error';"
    )
    wait_blocked(reader, second, first)
    assert reader.json("to_jsonb(revision) from public.airfare_history_revision") == before
    first.execute("commit;")
    second.receive(pending)
    assert reader.json("to_jsonb(revision) from public.airfare_history_revision") == before + 1
    second.execute("commit;")
    assert reader.json("to_jsonb(revision) from public.airfare_history_revision") == before + 2
    first.execute(
        "begin; set local role service_role; update public.fare_checks set outcome='changed'; rollback;"
    )
    assert reader.json("to_jsonb(revision) from public.airfare_history_revision") == before + 2


@pytest.mark.parametrize("mutate_at", ["page", "final"])
@pytest.mark.parametrize("churn", [False, True])
def test_local_replica_actual_rpc_restarts_without_partial_result(
    local_replica_sessions, mutate_at, churn
):
    reader, writer, _ = local_replica_sessions
    replica = LocalReplica(reader)
    starts = 0
    mutations = 0
    wire = []

    async def rpc(name, params):
        nonlocal starts, mutations
        if name.endswith("meta") and "p_expected_revision" not in params:
            starts += 1
        boundary = (
            name.endswith("page") and params.get("p_cursor") is not None
            if mutate_at == "page"
            else "p_expected_revision" in params
        )
        if boundary and (churn or mutations == 0):
            writer.execute(
                "set role service_role; update public.fare_snapshots set source_line=source_line+1; reset role;"
            )
            mutations += 1
        result = replica.rpc(name, params | {"p_page_size": 1} if name.endswith("page") else params)
        wire.append(result)
        return result

    async def no_sleep(_seconds):
        pass

    if churn:
        with pytest.raises(AirfareRemoteUnavailable, match="changed repeatedly"):
            run(rpc, {"filters": FILTERS}, sleep=no_sleep)
        assert starts == mutations == 3
    else:
        result = run(rpc, {"filters": FILTERS}, sleep=no_sleep)
        assert result == replica.rpc("read_airfare_history", FILTERS)
        assert starts == 2 and mutations == 1
        assert len(result["snapshots"]) == 2


def test_local_replica_importer_replay_preserves_ids_and_files(local_replica_sessions, tmp_path):
    from test_airfare_sync import (
        AIRPORT,
        BASELINE,
        BOARD,
        CALENDAR,
        CHECK,
        SNAPSHOT,
        WATCH,
        write_lines,
    )

    from app.services.airfare_sync import AirfareSync

    reader, writer, _ = local_replica_sessions
    # Seed independent, disposable source files. The importer may write its own
    # cursor here, never into retained source/destination archives.
    for path, row in (
        ("fares/AQP-LIM.jsonl", SNAPSHOT),
        ("fares/baseline/AQP-LIM.jsonl", BASELINE),
        ("fares/calendar/AQP-LIM.jsonl", CALENDAR),
        ("fares/checks/AQP-LIM.jsonl", BOARD),
        ("fares/calendar/checks/AQP-LIM.jsonl", CHECK),
    ):
        write_lines(tmp_path, path, [row])
    (tmp_path / "fares/airports.json").write_text(json.dumps({"AQP": AIRPORT}), encoding="utf-8")
    (tmp_path / "kv").mkdir()
    (tmp_path / "kv/airfare-routes.json").write_text(json.dumps(WATCH), encoding="utf-8")
    replica = LocalReplica(writer)
    sync = AirfareSync(tmp_path, remote=replica, batch_size=1)
    files = sync.source_files()
    before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    # Only the isolated replica is cleared; source fixtures remain untouched.
    writer.execute(
        "truncate public.fare_snapshots,public.fare_baseline_points,public.fare_checks,public.fare_airports;"
    )
    first = sync.apply("full")
    assert first.status == "complete"
    assert first.uploaded == dict.fromkeys(
        (
            "snapshots",
            "baseline",
            "calendar",
            "board_checks",
            "calendar_checks",
            "airports",
            "documents",
        ),
        1,
    )
    assert sync.verify(first.source).matches
    revision = LocalReplica(reader).rpc("read_airfare_history_meta", FILTERS)["revision"]
    replay = sync.apply("full")
    assert replay.status == "complete" and replay.uploaded == first.uploaded
    assert replay.source == first.source and sync.verify(replay.source).matches
    assert int(LocalReplica(reader).rpc("read_airfare_history_meta", FILTERS)["revision"]) > int(
        revision
    )
    assert {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in files} == before
