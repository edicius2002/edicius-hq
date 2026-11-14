"""The supervised run resumes after a failed remote phase without data loss."""

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

from app.services.airfare_retention_runner import RetentionRunner
from app.services.airfare_sync import AirfareSync

OLD = "2020-01-01"
FUTURE = "2020-01-31"
RUN_AT = datetime(2020, 1, 3, tzinfo=UTC)
TABLES = {
    "snapshots": "fare_snapshots",
    "baseline": "fare_baseline_points",
    "calendar": "fare_calendar_captures",
    "board_checks": "fare_checks",
    "calendar_checks": "fare_checks",
    "airports": "fare_airports",
    "documents": "airfare_documents",
    "summaries": "fare_departure_summaries",
}


def source(root: Path) -> None:
    def write(relative: str, rows: list[dict]) -> None:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

    def snapshot(day: str, price: int) -> dict:
        return {
            "capturedAt": "2019-12-01T01:00:00Z",
            "source": "test",
            "origin": "AQP",
            "destination": "LIM",
            "flightDate": day,
            "currency": "USD",
            "offers": [
                {
                    "airline": "LA",
                    "departureAt": f"{day}T12:00:00",
                    "transfers": 0,
                    "price": price,
                    "currency": "USD",
                }
            ],
        }

    write("fares/AQP-LIM.jsonl", [snapshot(OLD, 10), snapshot(FUTURE, 30)])
    write(
        "fares/baseline/AQP-LIM.jsonl",
        [
            {
                "flightDate": day,
                "date": "2019-12-01",
                "price": price,
                "currency": "USD",
                "source": "test",
            }
            for day, price in ((OLD, 10), (FUTURE, 30))
        ],
    )
    write(
        "fares/checks/AQP-LIM.jsonl",
        [
            {"at": "2019-12-01T02:00:00Z", "flightDate": day, "outcome": "changed", "offers": 1}
            for day in (OLD, FUTURE)
        ],
    )
    write(
        "fares/calendar/AQP-LIM.jsonl",
        [
            {
                "capturedAt": "2019-12-01T01:00:00Z",
                "source": "test",
                "origin": "AQP",
                "destination": "LIM",
                "currency": "USD",
                "from": OLD,
                "to": FUTURE,
                "prices": {OLD: 10, FUTURE: 30},
            }
        ],
    )


class Replica:
    def __init__(self, root: Path):
        self.replica_id = ""
        self.state = {"cutoff": None, "target_cutoff": None, "phase": "verified", "run_id": None}
        self.rows: dict[str, dict[str, dict]] = {table: {} for table in TABLES.values()}
        self.fail_once: str | None = None
        for dataset, records in AirfareSync(root).logical_records().items():
            table = TABLES[dataset]
            for row in records:
                key = row.get("record_id", row.get("code", row.get("key", row.get("digest"))))
                self.rows[table][str(key)] = row

    def upsert(self, table: str, rows: list[dict], *, on_conflict: str):
        if table == "airfare_import_runs":
            return None
        for row in rows:
            key = row.get("record_id", row.get("code", row.get("key", row.get("digest"))))
            self.rows[table][str(key)] = row
        return None

    def select_all(self, table: str, columns: tuple[str, ...], *, key: str):
        return [{column: row[column] for column in columns} for row in self.rows[table].values()]

    def _groups(self):
        groups: dict[tuple[str, str], list[str]] = {}
        for dataset, table in TABLES.items():
            if dataset in {"airports", "documents"}:
                continue
            for row in self.rows[table].values():
                if table == "fare_checks" and row["kind"] != dataset.removesuffix("_checks"):
                    continue
                route = f"{row['origin']}-{row['destination']}"
                groups.setdefault((dataset, route), []).append(
                    row.get("record_id", row.get("digest"))
                )
        return [
            {
                "dataset": dataset,
                "route": route,
                "count": len(ids),
                "digest": hashlib.sha256("\n".join(sorted(ids)).encode()).hexdigest(),
            }
            for (dataset, route), ids in sorted(groups.items())
        ]

    def rpc(self, name: str, params: dict, *, timeout_seconds: float | None = None):
        if self.fail_once == name:
            self.fail_once = None
            raise OSError("simulated remote outage")
        if name == "airfare_dataset_manifest":
            return [*self._groups(), {"dataset": "retention", "route": "*", **self.state}]
        if name == "begin_airfare_retention":
            if self.state["run_id"] is None:
                self.state.update(
                    run_id=params["p_run_id"], target_cutoff=params["p_cutoff"], phase="summarized"
                )
            assert self.state["run_id"] == params["p_run_id"]
            return dict(self.state)
        if name == "publish_airfare_departure_summary":
            body = params["p_payload"]
            self.rows["fare_departure_summaries"][params["p_digest"]] = {
                "origin": body["origin"],
                "destination": body["destination"],
                "flight_date": body["flight_date"],
                "digest": params["p_digest"],
                "payload": body,
            }
            return None
        if name == "replace_airfare_retention_calendar":
            old = self.rows["fare_calendar_captures"].pop(params["p_record_id"], None)
            new = params["p_replacement"]
            assert old or new is None or new["record_id"] in self.rows["fare_calendar_captures"]
            if new is not None:
                self.rows["fare_calendar_captures"][new["record_id"]] = new
            return None
        if name == "prune_airfare_departure":
            for table in ("fare_snapshots", "fare_baseline_points", "fare_checks"):
                self.rows[table] = {
                    key: row
                    for key, row in self.rows[table].items()
                    if not (
                        row.get("flight_date") == params["p_flight_date"]
                        and row.get("origin") == params["p_origin"]
                        and row.get("destination") == params["p_destination"]
                    )
                }
            self.state["phase"] = "pruned"
            return None
        if name == "list_fare_projection_dirty_routes":
            return []
        if name == "refresh_fare_route_projection":
            return 0
        if name == "finish_airfare_retention":
            assert params["p_manifest"] == self._groups()
            self.state.update(cutoff=self.state["target_cutoff"], phase="verified")
            return dict(self.state)
        raise AssertionError(name)


def test_dry_run_and_verified_apply_preserve_future_detail(tmp_path: Path):
    source(tmp_path)
    remote = Replica(tmp_path)
    runner = RetentionRunner(tmp_path, remote)  # type: ignore[arg-type]
    before = (tmp_path / "fares/AQP-LIM.jsonl").read_bytes()
    dry = runner.run(now=RUN_AT)
    assert dry.expired_rows["snapshots"] == 1
    assert (tmp_path / "fares/AQP-LIM.jsonl").read_bytes() == before
    assert not (tmp_path / "fares/retention/state.json").exists()

    applied = runner.run(now=RUN_AT, dry_run=False)
    assert applied.verified, applied.error
    assert applied.phase == "verified"
    assert OLD.encode() not in (tmp_path / "fares/AQP-LIM.jsonl").read_bytes()
    assert FUTURE.encode() in (tmp_path / "fares/AQP-LIM.jsonl").read_bytes()
    assert len(remote.rows["fare_departure_summaries"]) == 1
    assert all(row["flight_date"] == FUTURE for row in remote.rows["fare_snapshots"].values())
    assert len(remote.rows["fare_calendar_captures"]) == 1
    assert next(iter(remote.rows["fare_calendar_captures"].values()))["payload"]["prices"] == {
        FUTURE: 30
    }
    replay = AirfareSync(tmp_path, remote).apply("full")  # type: ignore[arg-type]
    assert replay.status == "complete", replay.error
    assert all(row["flight_date"] == FUTURE for row in remote.rows["fare_snapshots"].values())
    assert len(remote.rows["fare_departure_summaries"]) == 1


def test_second_apply_same_cutoff_verifies_without_creating_a_run(tmp_path: Path):
    source(tmp_path)
    remote = Replica(tmp_path)
    runner = RetentionRunner(tmp_path, remote)  # type: ignore[arg-type]
    first = runner.run(now=RUN_AT, dry_run=False)
    assert first.verified, first.error
    second = runner.run(now=RUN_AT, dry_run=False)
    assert second.verified, second.error
    assert second.run_id == first.run_id
    assert second.expired_rows["snapshots"] == 0
    assert len(remote.rows["fare_departure_summaries"]) == 1


def test_remote_failure_keeps_gate_and_resume_verifies(tmp_path: Path):
    source(tmp_path)
    remote = Replica(tmp_path)
    remote.fail_once = "prune_airfare_departure"
    runner = RetentionRunner(tmp_path, remote)  # type: ignore[arg-type]
    failed = runner.run(now=RUN_AT, dry_run=False)
    assert not failed.verified
    assert failed.phase == "compacted"
    assert failed.run_id is not None
    pending_plan = runner.run(now=RUN_AT)
    assert not pending_plan.verified
    assert "retention:pending" in pending_plan.mismatches
    resumed = RetentionRunner(tmp_path, remote).run(now=RUN_AT, dry_run=False)  # type: ignore[arg-type]
    assert resumed.verified, resumed.error
    assert resumed.run_id == failed.run_id
    assert len(remote.rows["fare_departure_summaries"]) == 1


def test_remote_finish_survives_lost_local_acknowledgement(tmp_path: Path, monkeypatch):
    source(tmp_path)
    remote = Replica(tmp_path)
    runner = RetentionRunner(tmp_path, remote)  # type: ignore[arg-type]
    original = runner.store.write_state
    failed_once = False

    def lose_verified_state(state):
        nonlocal failed_once
        if state["phase"] == "verified" and not failed_once:
            failed_once = True
            raise OSError("simulated power loss after remote finish")
        original(state)

    monkeypatch.setattr(runner.store, "write_state", lose_verified_state)
    failed = runner.run(now=RUN_AT, dry_run=False)
    assert not failed.verified
    assert failed.phase == "pruned"
    assert remote.state["phase"] == "verified"
    resumed = RetentionRunner(tmp_path, remote).run(now=RUN_AT, dry_run=False)  # type: ignore[arg-type]
    assert resumed.verified, resumed.error
    assert resumed.run_id == failed.run_id
