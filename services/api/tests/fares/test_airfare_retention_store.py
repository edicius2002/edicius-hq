"""Departed fare details are compacted without changing future observations."""

import json
from threading import Event, Thread
from datetime import date
from pathlib import Path

import pytest

from app.services.airfare_retention import summarize_departure

OLD = "2020-01-01"
NEW = "2020-01-31"
AT = "2019-12-01T01:00:00Z"


def write_rows(root: Path, relative: str, rows: list[dict], *, tail: bytes = b"") -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"".join(json.dumps(row).encode() + b"\n" for row in rows) + tail)
    return path


def snapshot(day: str, price: int) -> dict:
    return {
        "capturedAt": AT,
        "source": "google-flights",
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


def fixture(root: Path) -> dict[str, bytes]:
    files = {
        "snapshots": write_rows(
            root, "fares/AQP-LIM.jsonl", [snapshot(OLD, 10), snapshot(NEW, 30)]
        ),
        "baseline": write_rows(
            root,
            "fares/baseline/AQP-LIM.jsonl",
            [
                {
                    "flightDate": OLD,
                    "date": "2019-12-01",
                    "price": 10,
                    "currency": "USD",
                    "source": "google-flights",
                },
                {
                    "flightDate": NEW,
                    "date": "2019-12-01",
                    "price": 30,
                    "currency": "USD",
                    "source": "google-flights",
                },
            ],
        ),
        "checks": write_rows(
            root,
            "fares/checks/AQP-LIM.jsonl",
            [
                {"at": AT, "flightDate": OLD, "outcome": "changed", "offers": 1},
                {"at": AT, "flightDate": NEW, "outcome": "changed", "offers": 1},
            ],
        ),
        "calendar": write_rows(
            root,
            "fares/calendar/AQP-LIM.jsonl",
            [
                {
                    "capturedAt": AT,
                    "source": "google-flights",
                    "origin": "AQP",
                    "destination": "LIM",
                    "currency": "USD",
                    "from": OLD,
                    "to": NEW,
                    "prices": {OLD: 10, NEW: 30},
                }
            ],
        ),
        "calendar_checks": write_rows(
            root,
            "fares/calendar/checks/AQP-LIM.jsonl",
            [{"at": AT, "outcome": "changed", "dates": 2}],
        ),
    }
    return {name: path.read_bytes() for name, path in files.items()}


def test_compact_route_keeps_future_bytes_and_exact_partition(tmp_path: Path):
    from app.services.airfare_retention_store import RetentionStore
    from app.services.airfare_sync import AirfareSync

    before = fixture(tmp_path)
    store = RetentionStore(tmp_path)
    result = store.compact_route("AQP", "LIM", date(2020, 1, 2))
    assert result["summaries"] == 1
    for name, relative in (
        ("snapshots", "fares/AQP-LIM.jsonl"),
        ("baseline", "fares/baseline/AQP-LIM.jsonl"),
        ("checks", "fares/checks/AQP-LIM.jsonl"),
    ):
        after = (tmp_path / relative).read_bytes()
        assert after == before[name].splitlines(keepends=True)[1]
        assert OLD.encode() not in after
    assert (tmp_path / "fares/calendar/checks/AQP-LIM.jsonl").read_bytes() == before[
        "calendar_checks"
    ]
    calendar = json.loads((tmp_path / "fares/calendar/AQP-LIM.jsonl").read_text())
    assert calendar["prices"] == {NEW: 30}
    assert calendar["from"] == "2020-01-02"
    partition = tmp_path / "fares/retention/partitions/AQP-LIM/2020-01-01.json"
    body = json.loads(partition.read_text())
    assert body["price_days"] == {"2019-12-01": [["10", 1]]}
    manifest = AirfareSync(tmp_path).scan("full")
    assert manifest.snapshots.logical_unique == 1
    assert manifest.baseline.logical_unique == 1
    assert manifest.board_checks.logical_unique == 1


def test_conflicting_partition_is_rejected(tmp_path: Path):
    from app.services.airfare_retention_store import RetentionStore

    store = RetentionStore(tmp_path)
    a = summarize_departure("AQP", "LIM", date(2020, 1, 1), [snapshot(OLD, 10)], [], [])
    b = summarize_departure("AQP", "LIM", date(2020, 1, 1), [snapshot(OLD, 11)], [], [])
    assert store.publish(a) == a.digest
    assert store.publish(a) == a.digest
    with pytest.raises(ValueError, match="conflict"):
        store.publish(b)


def test_local_writers_reject_expired_departures_and_pending_maintenance(tmp_path: Path):
    from app.adapters.fares.models import FareSnapshot
    from app.services.airfare_retention_store import RetentionStore
    from app.services.fare_calendar import FareCalendar
    from app.services.fare_history import FareHistory

    store = RetentionStore(tmp_path)
    history = FareHistory(tmp_path / "fares")
    calendar = FareCalendar(tmp_path / "fares/calendar")
    store.write_state({"phase": "verified", "cutoff": "2020-01-02"})
    expired = FareSnapshot(AT, "google-flights", "AQP", "LIM", OLD, None, "USD")
    with pytest.raises(ValueError, match="cutoff"):
        history.append(expired)
    with pytest.raises(ValueError, match="cutoff"):
        history.record_check("AQP", "LIM", OLD, at=AT, outcome="changed")
    with pytest.raises(ValueError, match="cutoff"):
        history.merge_baseline("AQP", "LIM", OLD, [], source="google-flights", currency="USD")
    assert not (tmp_path / "fares/AQP-LIM.jsonl").exists()

    store.write_state({"phase": "pending", "cutoff": "2020-01-02", "target_cutoff": NEW})
    with pytest.raises(ValueError, match="pending"):
        history.record_check("AQP", "LIM", NEW, at=AT, outcome="changed")
    with pytest.raises(ValueError, match="pending"):
        calendar.record_check("AQP", "LIM", at=AT, outcome="changed")


def test_full_sync_refuses_stale_departure_after_cutoff(tmp_path: Path):
    from app.services.airfare_retention_store import RetentionStore
    from app.services.airfare_sync import AirfareSync

    write_rows(tmp_path, "fares/AQP-LIM.jsonl", [snapshot(OLD, 10)])
    RetentionStore(tmp_path).write_state({"phase": "verified", "cutoff": "2020-01-02"})
    with pytest.raises(ValueError, match="below retention cutoff"):
        AirfareSync(tmp_path).scan("full")


def test_pending_state_is_seen_after_waiting_for_maintenance_lock(tmp_path: Path):
    from app.services.airfare_retention_gate import maintenance_lock
    from app.services.airfare_retention_store import RetentionStore
    from app.services.fare_history import FareHistory

    history = FareHistory(tmp_path / "fares")
    entered = Event()
    finished = Event()
    errors: list[Exception] = []

    def write_check() -> None:
        entered.set()
        try:
            history.record_check("AQP", "LIM", NEW, at=AT, outcome="changed")
        except Exception as exc:
            errors.append(exc)
        finally:
            finished.set()

    with maintenance_lock(tmp_path / "fares"):
        writer = Thread(target=write_check)
        writer.start()
        assert entered.wait(1)
        assert not finished.wait(0.05)
        RetentionStore(tmp_path).write_state({"phase": "pending", "target_cutoff": NEW})
    writer.join(2)
    assert finished.is_set()
    assert len(errors) == 1 and "pending" in str(errors[0])
    assert not (tmp_path / "fares/checks/AQP-LIM.jsonl").exists()


def test_truncated_source_blocks_every_replacement(tmp_path: Path):
    from app.services.airfare_retention_store import RetentionStore

    before = fixture(tmp_path)
    path = tmp_path / "fares/checks/AQP-LIM.jsonl"
    path.write_bytes(path.read_bytes() + b'{"at":"incomplete"')
    with pytest.raises(ValueError, match="journal"):
        RetentionStore(tmp_path).compact_route("AQP", "LIM", date(2020, 1, 2))
    assert (tmp_path / "fares/AQP-LIM.jsonl").read_bytes() == before["snapshots"]
    assert not (tmp_path / "fares/retention/partitions/AQP-LIM/2020-01-01.json").exists()


def test_resume_after_one_atomic_replacement(tmp_path: Path, monkeypatch):
    from app.services import airfare_retention_store as module

    before = fixture(tmp_path)
    store = module.RetentionStore(tmp_path)
    original = module.os.replace
    failed = False

    def fail_baseline(source, destination):
        nonlocal failed
        if not failed and Path(destination).parts[-3:] == ("fares", "baseline", "AQP-LIM.jsonl"):
            failed = True
            raise OSError("simulated crash before baseline replacement")
        return original(source, destination)

    monkeypatch.setattr(module.os, "replace", fail_baseline)
    with pytest.raises(OSError):
        store.compact_route("AQP", "LIM", date(2020, 1, 2))
    assert failed
    assert (tmp_path / "fares/baseline/AQP-LIM.jsonl").read_bytes() == before["baseline"]
    monkeypatch.setattr(module.os, "replace", original)
    assert store.compact_route("AQP", "LIM", date(2020, 1, 2))["summaries"] == 1
    assert (tmp_path / "fares/baseline/AQP-LIM.jsonl").read_bytes() == before[
        "baseline"
    ].splitlines(keepends=True)[1]
    assert not (tmp_path / "fares/retention/plans/AQP-LIM.json").exists()


def test_all_expired_calendar_curve_is_removed(tmp_path: Path):
    from app.services.airfare_retention_store import RetentionStore

    fixture(tmp_path)
    path = tmp_path / "fares/calendar/AQP-LIM.jsonl"
    row = json.loads(path.read_text())
    row["to"] = OLD
    row["prices"] = {OLD: 10}
    write_rows(tmp_path, "fares/calendar/AQP-LIM.jsonl", [row])
    RetentionStore(tmp_path).compact_route("AQP", "LIM", date(2020, 1, 2))
    assert path.read_bytes() == b""
