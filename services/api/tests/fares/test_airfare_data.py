"""The deep AirfareData seam, across local and Supabase-backed reads."""

import logging
import threading
from pathlib import Path

import pytest

from app.adapters.fares.models import Airport, CalendarPrice, FareOffer, FareSnapshot, PricePoint
from app.services.airfare_data import AirfareData, HistoryQuery
from app.services.airfare_supabase import AirfareRemoteRejected, AirfareRemoteUnavailable
from app.services.airfare_sync import AirfareSync, SyncReport
from app.services.fare_calendar import CalendarCurve, FareCalendar
from app.services.fare_history import FareHistory

MARCH_CAPTURE = "2026-09-15T00:00:00+00:00"
APRIL_CAPTURE = "2026-09-16T00:00:00+00:00"


def snapshot(
    *,
    captured_at: str = MARCH_CAPTURE,
    flight_date: str = "2027-03-01",
    price: float | None = 100,
) -> FareSnapshot:
    return FareSnapshot(
        captured_at=captured_at,
        source="google-flights",
        origin="AQP",
        destination="LIM",
        flight_date=flight_date,
        return_date=None,
        currency="USD",
        offers=[
            FareOffer(
                airline="LA",
                airline_name="LATAM",
                flight_number="LA123",
                departure_at=f"{flight_date}T12:00:00",
                arrival_at=f"{flight_date}T13:30:00",
                transfers=0,
                duration_minutes=90,
                price=price,
                currency="USD",
                via_points=None,
            )
        ],
    )


def snapshot_row(item: FareSnapshot) -> dict[str, object]:
    offer = item.offers[0]
    return {
        "capturedAt": item.captured_at,
        "source": item.source,
        "origin": item.origin,
        "destination": item.destination,
        "flightDate": item.flight_date,
        "returnDate": item.return_date,
        "currency": item.currency,
        "insights": None,
        "offers": [
            {
                "airline": offer.airline,
                "airlineName": offer.airline_name,
                "flightNumber": offer.flight_number,
                "departureAt": offer.departure_at,
                "arrivalAt": offer.arrival_at,
                "transfers": offer.transfers,
                "durationMinutes": offer.duration_minutes,
                "price": offer.price,
                "currency": offer.currency,
                # This field is deliberately absent in old archive documents.
            }
        ],
    }


class FakeRemote:
    def __init__(
        self,
        *,
        history: object = None,
        calendar: object = None,
        airports: list[dict[str, object]] | None = None,
    ) -> None:
        self.history = history
        self.calendar = calendar
        self.airport_rows = [] if airports is None else airports
        self.rpc_calls: list[tuple[str, dict[str, object]]] = []
        self.select_calls: list[tuple[str, tuple[str, ...], str]] = []

    def rpc(self, name: str, params: dict[str, object]) -> object:
        self.rpc_calls.append((name, params))
        result = self.history if name == "read_airfare_history" else self.calendar
        if isinstance(result, Exception):
            raise result
        return result

    def select_all(
        self, table: str, columns: tuple[str, ...], *, key: str
    ) -> list[dict[str, object]]:
        self.select_calls.append((table, columns, key))
        return self.airport_rows


@pytest.fixture
def archive(tmp_path: Path) -> tuple[Path, FareHistory, FareCalendar]:
    fares = tmp_path / "fares"
    history = FareHistory(fares)
    calendar = FareCalendar(fares / "calendar")
    history.append(snapshot())
    history.append(snapshot(captured_at=APRIL_CAPTURE, flight_date="2027-04-01", price=300))
    history.merge_baseline(
        "AQP",
        "LIM",
        "2027-03-01",
        [PricePoint(date="2026-09-01", price=150)],
        source="google-flights",
        currency="USD",
    )
    history.merge_baseline(
        "AQP",
        "LIM",
        "2027-04-01",
        [PricePoint(date="2026-09-01", price=350)],
        source="google-flights",
        currency="USD",
    )
    history.record_check("AQP", "LIM", "2027-03-01", at=MARCH_CAPTURE, outcome="changed", offers=1)
    history.record_check(
        "AQP", "LIM", "2027-04-01", at=APRIL_CAPTURE, outcome="error", error_code="refused"
    )
    history.merge_airports(
        [
            Airport("AQP", "Rodríguez Ballón", "Arequipa", "Peru", -16.34, -71.58),
            Airport("LIM", "Jorge Chávez", "Lima", "Peru", -12.02, -77.11),
        ]
    )
    calendar.append(
        CalendarCurve(
            captured_at=MARCH_CAPTURE,
            source="google-flights",
            origin="AQP",
            destination="LIM",
            currency="USD",
            start="2027-03-01",
            end="2027-03-03",
            prices=[
                CalendarPrice("2027-03-01", None),
                CalendarPrice("2027-03-03", 90),
            ],
        )
    )
    calendar.record_check("AQP", "LIM", at=MARCH_CAPTURE, outcome="error", error_code="refused")
    return tmp_path, history, calendar


def history_document() -> dict[str, object]:
    item = snapshot()
    return {
        "origin": "AQP",
        "destination": "LIM",
        "snapshots": [snapshot_row(item)],
        "baseline": [
            {
                "flightDate": "2027-03-01",
                "date": "2026-09-01",
                "price": 150,
                "currency": "USD",
                "source": "google-flights",
            }
        ],
        "health": {"lastCheckedAt": MARCH_CAPTURE, "checks": 1, "changes": 1, "errors": 0},
        "airports": [
            {
                "code": "AQP",
                "name": "Rodríguez Ballón",
                "city": "Arequipa",
                "country": "Peru",
                "latitude": -16.34,
                "longitude": -71.58,
            },
            {
                "code": "LIM",
                "name": "Jorge Chávez",
                "city": "Lima",
                "country": "Peru",
                "latitude": -12.02,
                "longitude": -77.11,
            },
        ],
        "pairReference": {"value": 200, "dates": 2},
    }


def calendar_document() -> dict[str, object]:
    return {
        "origin": "AQP",
        "destination": "LIM",
        "horizon": {
            "capturedAt": MARCH_CAPTURE,
            "source": "google-flights",
            "currency": "USD",
            "fromDate": "2027-03-01",
            "toDate": "2027-03-03",
            "prices": [
                {"departureDate": "2027-03-01", "price": None, "observedAt": MARCH_CAPTURE},
                {"departureDate": "2027-03-03", "price": 90, "observedAt": MARCH_CAPTURE},
            ],
        },
        "health": {"lastCheckedAt": MARCH_CAPTURE, "checks": 1, "changes": 0, "errors": 1},
    }


def test_local_and_supabase_adapters_return_the_same_domain_answers(archive):
    root, history, calendar = archive
    remote = FakeRemote(
        history=history_document(),
        calendar=calendar_document(),
        airports=[
            {"code": "AQP", "payload": history_document()["airports"][0]},
            {"code": "LIM", "payload": history_document()["airports"][1]},
        ],
    )
    query = HistoryQuery(
        "AQP",
        "LIM",
        departure="2027-03",
        snapshot_months=("2027-03",),
        since="2026-09",
        until="2026-09-15T23",
    )
    local = AirfareData(history, calendar, backend="local", source_root=root)
    hosted = AirfareData(history, calendar, remote=remote, backend="supabase", source_root=root)

    assert local.history(query) == hosted.history(query)
    assert local.calendar("AQP", "LIM") == hosted.calendar("AQP", "LIM")
    assert local.airports(["AQP", "LIM"]) == hosted.airports(["AQP", "LIM"])
    assert remote.rpc_calls == [
        (
            "read_airfare_history",
            {
                "p_origin": "AQP",
                "p_destination": "LIM",
                "p_departure": "2027-03",
                "p_snapshot_months": ["2027-03"],
                "p_since": "2026-09",
                "p_until": "2026-09-15T23",
            },
        ),
        ("read_airfare_calendar", {"p_origin": "AQP", "p_destination": "LIM"}),
    ]
    assert remote.select_calls == [("fare_airports", ("code", "payload"), "code")]


def test_local_mode_never_calls_the_remote_adapter(archive):
    root, history, calendar = archive
    remote = FakeRemote(
        history=AssertionError("remote read"), calendar=AssertionError("remote read")
    )
    data = AirfareData(history, calendar, remote=remote, backend="local", source_root=root)

    data.history(HistoryQuery("AQP", "LIM"))
    data.calendar("AQP", "LIM")
    data.airports([])

    assert remote.rpc_calls == []
    assert remote.select_calls == []


def test_empty_snapshot_month_filter_is_sent_as_sql_null(archive):
    root, history, calendar = archive
    remote = FakeRemote(history=history_document(), calendar=calendar_document())
    data = AirfareData(history, calendar, remote=remote, backend="supabase", source_root=root)

    data.history(HistoryQuery("AQP", "LIM"))

    assert remote.rpc_calls[0][1]["p_snapshot_months"] is None


def test_unavailable_remote_history_falls_back_once_with_a_bounded_store_warning(archive, caplog):
    root, history, calendar = archive
    remote = FakeRemote(history=AirfareRemoteUnavailable("token=never-log-this"))
    data = AirfareData(history, calendar, remote=remote, backend="supabase", source_root=root)

    with caplog.at_level(logging.WARNING):
        answer = data.history(HistoryQuery("AQP", "LIM"))

    assert answer.snapshots == tuple(history.read("AQP", "LIM"))
    warnings = [record.message for record in caplog.records if record.name.endswith("airfare_data")]
    assert warnings == [
        "Airfare history fell back to local archive for AQP-LIM after Supabase unavailable"
    ]
    assert "never-log-this" not in caplog.text


@pytest.mark.parametrize(
    "document",
    [
        [],
        {"origin": "AQP", "destination": "LIM", "snapshots": []},
        {**history_document(), "origin": "LIM"},
        {
            **history_document(),
            "snapshots": [{**snapshot_row(snapshot()), "offers": [{"price": "100"}]}],
        },
    ],
)
def test_rejected_remote_history_never_uses_local_as_a_mask(document, archive):
    root, _, calendar = archive

    class UnreadableHistory(FareHistory):
        def read(self, *args, **kwargs):
            raise AssertionError("local fallback must not hide malformed remote data")

    data = AirfareData(
        UnreadableHistory(root / "fares"),
        calendar,
        remote=FakeRemote(history=document),
        backend="supabase",
        source_root=root,
    )

    with pytest.raises(AirfareRemoteRejected):
        data.history(HistoryQuery("AQP", "LIM"))


def test_empty_remote_history_is_a_successful_empty_answer(archive):
    root, history, calendar = archive
    remote = FakeRemote(
        history={
            "origin": "AQP",
            "destination": "LIM",
            "snapshots": [],
            "baseline": [],
            "health": {"lastCheckedAt": None, "checks": 0, "changes": 0, "errors": 0},
            "airports": [],
            "pairReference": None,
        }
    )
    data = AirfareData(history, calendar, remote=remote, backend="supabase", source_root=root)

    assert data.history(HistoryQuery("AQP", "LIM")).snapshots == ()


def test_remote_history_rejects_a_snapshot_for_a_different_route(archive):
    root, history, calendar = archive
    document = history_document()
    document["snapshots"] = [{**snapshot_row(snapshot()), "origin": "LIM"}]
    data = AirfareData(
        history,
        calendar,
        remote=FakeRemote(history=document),
        backend="supabase",
        source_root=root,
    )

    with pytest.raises(AirfareRemoteRejected, match="snapshot route"):
        data.history(HistoryQuery("AQP", "LIM"))


def test_remote_history_rejects_snapshots_outside_the_requested_months(archive):
    root, history, calendar = archive
    document = history_document()
    document["snapshots"] = [snapshot_row(snapshot(flight_date="2027-04-01"))]
    data = AirfareData(
        history,
        calendar,
        remote=FakeRemote(history=document),
        backend="supabase",
        source_root=root,
    )

    with pytest.raises(AirfareRemoteRejected, match="snapshot month filter"):
        data.history(HistoryQuery("AQP", "LIM", snapshot_months=("2027-03",)))


def test_remote_airport_selection_rejects_a_payload_with_a_different_code(archive):
    root, history, calendar = archive
    remote = FakeRemote(
        airports=[
            {
                "code": "AQP",
                "payload": {
                    **history_document()["airports"][0],
                    "code": "LIM",
                },
            }
        ]
    )
    data = AirfareData(history, calendar, remote=remote, backend="supabase", source_root=root)

    with pytest.raises(AirfareRemoteRejected, match="mismatched airport code"):
        data.airports([])


def test_unreadable_local_archive_keeps_the_existing_logged_empty_behavior(tmp_path, caplog):
    fares = tmp_path / "fares"
    fares.mkdir()
    (fares / "AQP-LIM.jsonl").write_text('{"bad": true}\n', encoding="utf-8")
    remote = FakeRemote(history=AssertionError("local mode"))
    data = AirfareData(
        FareHistory(fares), FareCalendar(fares / "calendar"), remote=remote, source_root=tmp_path
    )

    with caplog.at_level(logging.ERROR):
        answer = data.history(HistoryQuery("AQP", "LIM"))

    assert answer.snapshots == ()
    assert "format has probably changed" in caplog.text
    assert caplog.text.count("format has probably changed") == 1
    assert remote.rpc_calls == []


def test_import_snapshots_appends_only_new_watch_observations(archive):
    root, history, calendar = archive
    data = AirfareData(history, calendar, source_root=root)
    imported = snapshot(captured_at="2026-09-17T00:00:00+00:00", price=180.0)

    first = data.import_snapshots([imported, imported])
    second = data.import_snapshots([imported])

    assert (first.imported, first.skipped) == (1, 1)
    assert (second.imported, second.skipped) == (0, 1)
    assert [item.captured_at for item in data.iter_snapshots("AQP", "LIM")] == [
        MARCH_CAPTURE,
        APRIL_CAPTURE,
        "2026-09-17T00:00:00+00:00",
    ]


def test_first_batch_sync_failure_preserves_local_source_and_cursor(archive):
    root, history, calendar = archive

    class FailingRemote:
        def upsert(self, *args, **kwargs):
            raise AirfareRemoteUnavailable("secret-that-must-not-escape")

    before = (root / "fares" / "AQP-LIM.jsonl").read_bytes()
    data = AirfareData(
        history,
        calendar,
        source_root=root,
        sync=AirfareSync(root, FailingRemote()),
    )

    report = data.sync_incremental()

    assert report.status == "failed"
    assert "secret-that-must-not-escape" not in (report.error or "")
    assert (root / "fares" / "AQP-LIM.jsonl").read_bytes() == before
    assert not (root / "fares" / "sync" / "cursors.json").exists()


def test_unconfigured_sync_is_a_failed_facade_report_without_secret_leakage(archive):
    root, history, calendar = archive
    data = AirfareData(history, calendar, source_root=root)

    report = data.sync_incremental()

    assert report.status == "failed"
    assert (
        report.error == "Airfare synchronization is unavailable; configure Supabase before retrying"
    )


def test_same_process_sync_calls_block_until_the_current_run_finishes(archive):
    root, history, calendar = archive
    source = AirfareSync(root).scan()
    entered = threading.Event()
    release = threading.Event()
    calls: list[int] = []

    class BlockingSync:
        def apply(self, mode: str) -> SyncReport:
            calls.append(len(calls))
            entered.set()
            release.wait(timeout=5)
            return SyncReport("incremental", "complete", source, {}, None)

    first = AirfareData(history, calendar, source_root=root, sync=BlockingSync())
    second = AirfareData(history, calendar, source_root=root, sync=BlockingSync())
    results: list[SyncReport] = []
    one = threading.Thread(target=lambda: results.append(first.sync_incremental()))
    two = threading.Thread(target=lambda: results.append(second.sync_incremental()))

    one.start()
    assert entered.wait(timeout=2)
    two.start()
    assert not threading.Event().wait(0.1)
    assert calls == [0]
    release.set()
    one.join(timeout=2)
    two.join(timeout=2)

    assert not one.is_alive() and not two.is_alive()
    assert [report.status for report in results] == ["complete", "complete"]
    assert calls == [0, 1]
