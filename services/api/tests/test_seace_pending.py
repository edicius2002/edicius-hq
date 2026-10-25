"""Discovered notices survive partial enrichment and publication failures."""

import asyncio
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "seace"))

import incremental
import refresh


@pytest.fixture(autouse=True)
def notice_clock(monkeypatch):
    # The sample notice closes on October 25; keep it open regardless of when
    # this suite runs. Tests that exercise retry timing set their own clock.
    class Clock(refresh.datetime):
        current = refresh.datetime(2026, 10, 23, 8, tzinfo=refresh.PERU_TIME)

        @classmethod
        def now(cls, tz=None):
            return cls.current if tz is None else cls.current.astimezone(tz)

    monkeypatch.setattr(refresh, "datetime", Clock)
    return Clock


def notice(identifier="103550", **fields):
    return {
        "idContrato": identifier,
        "fecPublica": "22/10/2026 08:00:00",
        "fecFinCotizacion": "25/10/2026 08:00:00",
        "nomEstadoContrato": "Vigente",
        **fields,
    }


class Session:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    async def call_tool(self, name, args):
        assert name == "detalles_convocatorias_menores"
        self.calls.append(args)
        if isinstance(self.payload, Exception):
            raise self.payload
        return SimpleNamespace(isError=False, structuredContent=self.payload)


def queue(path):
    return refresh.PendingNotices(path)


def test_detail_403_and_duplicates_survive_restart_and_closure(tmp_path):
    path = tmp_path / "pending.sqlite3"
    pending = queue(path)
    pending.discover("Arequipa", 2026, [notice(), notice()])
    failed = Session(
        {
            "ok": True,
            "detalles": {},
            "faltas": [
                {"id": "103550", "phase": "detail", "error": "HTTP 403"},
            ],
        }
    )
    rows = asyncio.run(pending.enrich(failed, "Arequipa", 2026))
    assert len(rows) == 1
    assert rows[0]["enrichment"] == {"detail": "pending", "files": "pending"}

    restarted = queue(path)
    restarted.discover("Arequipa", 2026, [notice(nomEstadoContrato="Culminado")])
    recovered = Session(
        {
            "ok": True,
            "detalles": {
                "103550": {
                    "items": [{"descripcionItem": "Repuesto"}],
                    "documentos": [],
                }
            },
            "faltas": [],
        }
    )
    rows = asyncio.run(restarted.enrich(recovered, "Arequipa", 2026))
    assert recovered.calls[0]["ids"] == ["103550"]
    assert rows[0]["state"] == "Culminado"
    assert rows[0]["items"] == ["Repuesto"]
    assert rows[0]["enrichment"] == {"detail": "complete", "files": "complete"}


def test_files_failure_preserves_detail_and_waits_for_publish_ack(tmp_path):
    path = tmp_path / "pending.sqlite3"
    pending = queue(path)
    pending.discover("Arequipa", 2026, [notice()])
    partial = Session(
        {
            "ok": True,
            "detalles": {
                "103550": {
                    "items": [{"descripcionItem": "Repuesto"}],
                    "fases_completadas": ["detail"],
                }
            },
            "faltas": [{"id": "103550", "fase": "files", "error": "HTTP 403"}],
        }
    )
    rows = asyncio.run(pending.enrich(partial, "Arequipa", 2026))
    assert rows[0]["items"] == ["Repuesto"]
    assert rows[0]["enrichment"] == {"detail": "complete", "files": "pending"}
    pending.acknowledge("Arequipa", 2026)

    restarted = queue(path)
    files = Session(
        {
            "ok": True,
            "detalles": {
                "103550": {
                    "documentos": [{"nombre": "Bases", "url": "https://example.test/bases.pdf"}],
                }
            },
            "faltas": [],
        }
    )
    rows = asyncio.run(restarted.enrich(files, "Arequipa", 2026))
    assert files.calls == [{"ids": ["103550"], "fase": "files"}]
    assert rows[0]["items"] == ["Repuesto"]
    assert rows[0]["documents"] == [{"name": "Bases", "url": "https://example.test/bases.pdf"}]
    assert rows[0]["enrichment"] == {"detail": "complete", "files": "complete"}

    # A crash before remote acknowledgement replays the saved response without HTTP.
    replay = queue(path)
    no_network = Session(AssertionError("already fetched"))
    assert asyncio.run(replay.enrich(no_network, "Arequipa", 2026)) == rows
    assert no_network.calls == []
    replay.acknowledge("Arequipa", 2026)
    assert asyncio.run(queue(path).enrich(no_network, "Arequipa", 2026)) == []


@pytest.mark.parametrize(
    "payload",
    [
        RuntimeError("MCP disconnected"),
        {"ok": True, "detalles": {}, "faltas": []},
        {"ok": True, "detalles": {"103550": {}}, "faltas": []},
    ],
)
def test_missing_or_invalid_response_never_completes_work(tmp_path, payload):
    pending = queue(tmp_path / "pending.sqlite3")
    pending.discover("Arequipa", 2026, [notice()])
    rows = asyncio.run(pending.enrich(Session(payload), "Arequipa", 2026))
    assert rows[0]["enrichment"] == {"detail": "pending", "files": "pending"}
    pending.acknowledge("Arequipa", 2026)
    assert len(asyncio.run(pending.enrich(Session(payload), "Arequipa", 2026))) == 1


class CollectorSession(Session):
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def initialize(self):
        pass

    async def call_tool(self, name, args):
        if name == "buscar_convocatorias_menores":
            return SimpleNamespace(
                isError=False,
                structuredContent={
                    "ok": True,
                    "filas": [notice()],
                    "total": 1,
                },
            )
        return await super().call_tool(name, args)


def collector(monkeypatch, tmp_path, session):
    @asynccontextmanager
    async def stdio(*args):
        yield None, None

    async def empty(*args, **kwargs):
        return {"records": []}

    async def no_updates(*args, **kwargs):
        return []

    monkeypatch.setattr(refresh, "STATE_DIR", tmp_path)
    monkeypatch.setattr(refresh, "stdio_client", stdio)
    monkeypatch.setattr(refresh, "ClientSession", lambda *args: session)
    monkeypatch.setattr(incremental, "stdio_client", stdio)
    monkeypatch.setattr(incremental, "ClientSession", lambda *args: session)
    monkeypatch.setattr(refresh, "fetch", empty)
    monkeypatch.setattr(refresh, "fetch_minor_contracts", empty)
    monkeypatch.setattr(incremental, "process_updates", no_updates)
    monkeypatch.setattr(incremental, "contract_updates", no_updates)
    sources = tuple(
        (tmp_path / f"{kind}.js", variable, kind) for _, variable, kind in incremental.SOURCES
    )
    monkeypatch.setattr(incremental, "SOURCES", sources)
    return sources


def test_queue_write_failure_stops_before_detail_and_checkpoint(tmp_path, monkeypatch):
    session = CollectorSession(AssertionError("must not fetch"))
    sources = collector(monkeypatch, tmp_path, session)

    def disk_full(*args):
        raise OSError("disk full")

    monkeypatch.setattr(refresh.PendingNotices, "discover", disk_full)
    with pytest.raises(OSError, match="disk full"):
        asyncio.run(incremental.refresh_region("Arequipa", 2026))
    assert session.calls == []
    assert not any(path.exists() for path, _, _ in sources)


def test_failed_publish_restarts_from_saved_phases_and_preserves_old_fields(tmp_path, monkeypatch):
    session = CollectorSession(
        {
            "ok": True,
            "detalles": {
                "103550": {
                    "items": [{"descripcionItem": "Repuesto"}],
                    "fases_completadas": ["detail"],
                }
            },
            "faltas": [{"id": "103550", "fase": "files", "error": "403"}],
        }
    )
    sources = collector(monkeypatch, tmp_path, session)
    notices_path, variable, _ = sources[1]
    prior = refresh.minor_notice_record(
        notice(),
        "Arequipa",
        {
            "documentos": [{"nombre": "Previous", "url": "https://example.test/old.pdf"}],
        },
    )
    incremental.write_snapshot(
        notices_path,
        variable,
        {
            "region": "Arequipa",
            "year": 2026,
            "fetchedAt": "2026-10-22T09:00:00-05:00",
            "records": [prior],
        },
    )
    original = notices_path.read_bytes()
    published = []

    def fail_publisher(kind, rows, *args):
        if kind == "notices":
            published.extend(rows)
            raise RuntimeError("upload failed")

    with pytest.raises(RuntimeError, match="upload failed"):
        asyncio.run(incremental.refresh_region("Arequipa", 2026, publisher=fail_publisher))
    assert notices_path.read_bytes() == original
    assert published[0]["items"] == ["Repuesto"]
    assert published[0]["documents"] == prior["documents"]

    # Only files are fetched on restart; a second partial failure cannot erase detail.
    session.calls.clear()
    session.payload = {
        "ok": True,
        "detalles": {},
        "faltas": [
            {"id": "103550", "fase": "files", "error": "403"},
        ],
    }
    published.clear()

    def publisher(kind, rows, *args):
        if kind == "notices":
            published.extend(rows)

    asyncio.run(incremental.refresh_region("Arequipa", 2026, publisher=publisher))
    assert session.calls == [{"ids": ["103550"], "fase": "files"}]
    assert published[0]["items"] == ["Repuesto"]
    assert published[0]["documents"] == prior["documents"]
    assert published[0]["enrichment"]["files"] == "pending"
    assert (
        incremental.checkpoint(
            incremental.read_snapshot(notices_path), "Arequipa", 2026
        ).isoformat()
        != "2026-10-22T09:00:00-05:00"
    )


def test_full_search_records_discovery_before_later_page_failure(tmp_path, monkeypatch):
    class SearchFailure(CollectorSession):
        async def call_tool(self, name, args):
            if name == "buscar_convocatorias_menores":
                if args["pagina"] > 1:
                    raise RuntimeError("search disconnected")
                return SimpleNamespace(
                    isError=False,
                    structuredContent={
                        "ok": True,
                        "filas": [notice()],
                        "total": 2,
                    },
                )
            return await super().call_tool(name, args)

    collector(monkeypatch, tmp_path, SearchFailure(None))
    with pytest.raises(RuntimeError, match="search disconnected"):
        asyncio.run(refresh.fetch_minor_notices("Arequipa", 2026, with_open_details=True))
    persisted = queue(tmp_path / "notice-pending.sqlite3").records("Arequipa", 2026)
    assert [row["id"] for row in persisted] == ["103550"]
    assert persisted[0]["enrichment"] == {"detail": "pending", "files": "pending"}


def test_lost_queue_rebuilds_closed_notice_without_erasing_saved_data(tmp_path):
    record = refresh.minor_notice_record(
        notice(nomEstadoContrato="Culminado"),
        "Arequipa",
        {
            "items": [{"descripcionItem": "Known item"}],
            "documentos": [{"nombre": "Known file", "url": "https://example.test/known.pdf"}],
        },
    )
    record["enrichment"] = {"detail": "complete", "files": "pending"}
    pending = queue(tmp_path / "rebuilt.sqlite3")
    pending.seed("Arequipa", 2026, [record, record])
    failed = Session(
        {
            "ok": True,
            "detalles": {},
            "faltas": [
                {"id": "103550", "fase": "detail", "error": "403"},
            ],
        }
    )
    rows = asyncio.run(pending.enrich(failed, "Arequipa", 2026))
    assert len(rows) == 1
    assert rows[0]["items"] == ["Known item"]
    assert rows[0]["documents"] == record["documents"]
    assert rows[0]["state"] == "Culminado"
    assert rows[0]["enrichment"] == {"detail": "pending", "files": "pending"}


def test_batch_keeps_success_and_missing_id_independently(tmp_path):
    pending = queue(tmp_path / "pending.sqlite3")
    pending.discover("Arequipa", 2026, [notice(), notice("103551")])
    partial = Session(
        {
            "ok": True,
            "detalles": {
                "103550": {
                    "items": [],
                    "documentos": [],
                    "fases_completadas": ["detail", "files"],
                }
            },
            "faltas": [{"id": "103551", "fase": "detail", "error": "403"}],
        }
    )
    rows = asyncio.run(pending.enrich(partial, "Arequipa", 2026))
    assert [row["id"] for row in rows] == ["103550", "103551"]
    pending.acknowledge("Arequipa", 2026)
    partial.calls.clear()
    retry = asyncio.run(pending.enrich(partial, "Arequipa", 2026))
    assert partial.calls == [{"ids": ["103551"]}]
    assert [row["id"] for row in retry] == ["103551"]
    assert retry[0]["enrichment"] == {"detail": "pending", "files": "pending"}


def test_snapshot_failure_replays_staged_phases_without_another_http_call(tmp_path, monkeypatch):
    session = CollectorSession(
        {
            "ok": True,
            "detalles": {
                "103550": {
                    "items": [],
                    "documentos": [],
                    "fases_completadas": ["detail", "files"],
                }
            },
            "faltas": [],
        }
    )
    sources = collector(monkeypatch, tmp_path, session)
    original_writer = incremental.write_snapshot

    def disk_full(*args):
        raise OSError("snapshot disk full")

    def publisher(*args):
        pass

    monkeypatch.setattr(incremental, "write_snapshot", disk_full)
    with pytest.raises(OSError, match="snapshot disk full"):
        asyncio.run(incremental.refresh_region("Arequipa", 2026, publisher=publisher))
    monkeypatch.setattr(incremental, "write_snapshot", original_writer)
    session.calls.clear()
    asyncio.run(incremental.refresh_region("Arequipa", 2026, publisher=publisher))
    assert session.calls == []
    assert all(path.exists() for path, _, _ in sources)
    assert queue(tmp_path / "notice-pending.sqlite3").records("Arequipa", 2026)[0][
        "enrichment"
    ] == {
        "detail": "complete",
        "files": "complete",
    }


def test_full_snapshot_reports_pending_files_instead_of_complete(tmp_path, monkeypatch):
    session = CollectorSession(
        {
            "ok": True,
            "detalles": {
                "103550": {
                    "items": [],
                    "fases_completadas": ["detail"],
                }
            },
            "faltas": [{"id": "103550", "fase": "files", "error": "403"}],
        }
    )
    collector(monkeypatch, tmp_path, session)
    snapshot = asyncio.run(refresh.fetch_minor_notices("Arequipa", 2026, with_open_details=True))
    assert snapshot["complete"] is False
    assert snapshot["detailsFetched"] == 1
    assert snapshot["records"][0]["enrichment"]["files"] == "pending"


def test_incremental_retries_discovery_not_yet_snapshotted_after_it_closes(tmp_path):
    class EmptySearch(Session):
        async def call_tool(self, name, args):
            if name == "buscar_convocatorias_menores":
                return SimpleNamespace(
                    isError=False,
                    structuredContent={
                        "ok": True,
                        "filas": [],
                        "total": 0,
                    },
                )
            return await super().call_tool(name, args)

    pending = queue(tmp_path / "pending.sqlite3")
    pending.discover("Arequipa", 2026, [notice()])
    session = EmptySearch(
        {
            "ok": True,
            "detalles": {},
            "faltas": [
                {"id": "103550", "fase": "detail", "error": "403"},
            ],
        }
    )
    rows = asyncio.run(
        incremental.minor_notice_updates(
            session,
            "Arequipa",
            2026,
            refresh.datetime.now(refresh.PERU_TIME),
            [],
            pending=pending,
        )
    )
    assert session.calls == [{"ids": ["103550"]}]
    assert rows[0]["state"] == "Culminado"
    assert rows[0]["enrichment"]["detail"] == "pending"


@pytest.mark.parametrize("broken_status", [None, "2", "3"])
def test_incomplete_incremental_search_cannot_advance_checkpoint(
    tmp_path, monkeypatch, broken_status
):
    class IncompleteSearch(CollectorSession):
        async def call_tool(self, name, args):
            if name == "buscar_convocatorias_menores":
                return SimpleNamespace(
                    isError=False,
                    structuredContent={
                        "ok": True,
                        "filas": [],
                        "total": int(args.get("estado") == broken_status),
                    },
                )
            return await super().call_tool(name, args)

    sources = collector(monkeypatch, tmp_path, IncompleteSearch(None))
    path, variable, _ = sources[1]
    incremental.write_snapshot(
        path,
        variable,
        {
            "region": "Arequipa",
            "year": 2026,
            "fetchedAt": "2026-10-22T09:00:00-05:00",
            "records": [],
        },
    )
    original = path.read_bytes()
    with pytest.raises(RuntimeError, match=r"search.*(stopped|ended)"):
        asyncio.run(incremental.refresh_region("Arequipa", 2026))
    assert path.read_bytes() == original


@pytest.mark.parametrize("broken_status", [None, "2", "3"])
def test_short_search_page_must_not_hide_remaining_discovered_work(tmp_path, broken_status):
    class ShortSearch(Session):
        async def call_tool(self, name, args):
            if name == "buscar_convocatorias_menores":
                broken = args.get("estado") == broken_status
                return SimpleNamespace(
                    isError=False,
                    structuredContent={
                        "ok": True,
                        "filas": [notice()] if broken and args["pagina"] == 1 else [],
                        "total": 2 if broken else 0,
                    },
                )
            return await super().call_tool(name, args)

    pending = queue(tmp_path / "pending.sqlite3")
    with pytest.raises(RuntimeError, match="search ended"):
        asyncio.run(
            incremental.minor_notice_updates(
                ShortSearch(None),
                "Arequipa",
                2026,
                refresh.datetime.now(refresh.PERU_TIME),
                [],
                pending=pending,
            )
        )
    assert [row["id"] for row in pending.records("Arequipa", 2026)] == ["103550"]


def test_initial_discovery_keeps_thousands_of_closed_notices_out_of_http_backlog(tmp_path):
    pending = queue(tmp_path / "pending.sqlite3")
    historical = [notice(str(index), nomEstadoContrato="Culminado") for index in range(3000)]
    pending.discover("Arequipa", 2026, [*historical, notice("103550"), notice("103551")])
    session = Session({"ok": True, "detalles": {}, "faltas": []})
    rows = asyncio.run(pending.enrich(session, "Arequipa", 2026))
    assert session.calls == [{"ids": ["103550", "103551"]}]
    assert len(rows) == 3002
    assert rows[0]["enrichment"] == {"detail": "deferred", "files": "deferred"}


def test_changed_open_notice_rechecks_completed_phases_and_preserves_old_fields(tmp_path):
    pending = queue(tmp_path / "pending.sqlite3")
    pending.discover("Arequipa", 2026, [notice(desObjetoContrato="Original")])
    complete = Session(
        {
            "ok": True,
            "detalles": {
                "103550": {
                    "items": [{"descripcionItem": "Original item"}],
                    "documentos": [],
                    "fases_completadas": ["detail", "files"],
                }
            },
            "faltas": [],
        }
    )
    asyncio.run(pending.enrich(complete, "Arequipa", 2026))
    pending.acknowledge("Arequipa", 2026)
    pending.discover("Arequipa", 2026, [notice(desObjetoContrato="Original")])
    assert asyncio.run(pending.enrich(Session({"ok": True}), "Arequipa", 2026)) == []
    pending.discover("Arequipa", 2026, [notice(desObjetoContrato="Revised")])
    failed = Session({"ok": True, "detalles": {}, "faltas": []})
    rows = asyncio.run(pending.enrich(failed, "Arequipa", 2026))
    assert failed.calls == [{"ids": ["103550"]}]
    assert rows[0]["items"] == ["Original item"]
    assert rows[0]["enrichment"] == {"detail": "pending", "files": "pending"}


def test_bounded_enrichment_prioritizes_new_ids_and_leaves_others_pending(tmp_path):
    pending = queue(tmp_path / "pending.sqlite3")
    pending.discover("Arequipa", 2026, [notice(str(index)) for index in range(5)])
    session = Session({"ok": True, "detalles": {}, "faltas": []})
    asyncio.run(pending.enrich(session, "Arequipa", 2026, max_ids=2))
    assert session.calls == [{"ids": ["0", "1"]}]
    assert (
        len(
            [
                entry
                for entry in pending._entries("Arequipa", 2026).values()
                if entry["attempts"]["detail"]
            ]
        )
        == 2
    )


def test_retry_budget_is_fair_and_survives_notice_closure(tmp_path, notice_clock):
    pending = queue(tmp_path / "pending.sqlite3")
    pending.discover("Arequipa", 2026, [notice(str(index)) for index in range(5)])
    failed = Session({"ok": True, "detalles": {}, "faltas": []})
    asyncio.run(pending.enrich(failed, "Arequipa", 2026))
    pending.discover(
        "Arequipa", 2026, [notice(str(index), nomEstadoContrato="Culminado") for index in range(5)]
    )
    notice_clock.current += refresh.timedelta(seconds=1)
    failed.calls.clear()
    asyncio.run(pending.enrich(failed, "Arequipa", 2026, retry_limit=2))
    assert failed.calls == [{"ids": ["0", "1"]}]
    failed.calls.clear()
    asyncio.run(pending.enrich(failed, "Arequipa", 2026, retry_limit=2))
    assert failed.calls == [{"ids": ["2", "3"]}]
    assert len(pending.records("Arequipa", 2026)) == 5


def test_historical_backfill_requires_explicit_id_activation(tmp_path):
    pending = queue(tmp_path / "pending.sqlite3")
    pending.discover(
        "Arequipa",
        2026,
        [notice("1", nomEstadoContrato="Culminado"), notice("2", nomEstadoContrato="Culminado")],
    )
    session = Session({"ok": True, "detalles": {}, "faltas": []})
    asyncio.run(pending.enrich(session, "Arequipa", 2026))
    assert session.calls == []
    pending.activate("Arequipa", 2026, ["2"])
    asyncio.run(pending.enrich(session, "Arequipa", 2026))
    assert session.calls == [{"ids": ["2"]}]


def test_retry_after_survives_restart_without_blocking_the_other_phase(tmp_path, monkeypatch):
    class Clock(refresh.datetime):
        current = refresh.datetime(2026, 10, 23, 8, tzinfo=refresh.PERU_TIME)

        @classmethod
        def now(cls, tz=None):
            return cls.current.astimezone(tz)

    monkeypatch.setattr(refresh, "datetime", Clock)
    path = tmp_path / "pending.sqlite3"
    pending = queue(path)
    pending.discover("Arequipa", 2026, [notice()])
    failure = Session(
        {
            "ok": True,
            "detalles": {},
            "faltas": [
                {"id": "103550", "fase": "detail", "status": 500, "error": "server error"},
                {
                    "id": "103550",
                    "fase": "files",
                    "status": 429,
                    "error": "rate limited",
                    "retry_after_seconds": 3600,
                },
            ],
        }
    )
    asyncio.run(pending.enrich(failure, "Arequipa", 2026))
    pending.acknowledge("Arequipa", 2026)

    Clock.current += refresh.timedelta(minutes=30)
    detail = Session(
        {
            "ok": True,
            "detalles": {
                "103550": {
                    "items": [],
                    "fases_completadas": ["detail"],
                }
            },
            "faltas": [],
        }
    )
    restarted = queue(path)
    rows = asyncio.run(restarted.enrich(detail, "Arequipa", 2026))
    assert detail.calls == [{"ids": ["103550"], "fase": "detail"}]
    assert rows[0]["enrichment"] == {"detail": "complete", "files": "pending"}
    restarted.acknowledge("Arequipa", 2026)
    waiting = Session(AssertionError("Retry-After has not elapsed"))
    assert asyncio.run(queue(path).enrich(waiting, "Arequipa", 2026)) == []
    assert waiting.calls == []

    Clock.current += refresh.timedelta(minutes=31)
    files = Session(
        {
            "ok": True,
            "detalles": {
                "103550": {
                    "documentos": [],
                    "fases_completadas": ["files"],
                }
            },
            "faltas": [],
        }
    )
    rows = asyncio.run(queue(path).enrich(files, "Arequipa", 2026))
    assert files.calls == [{"ids": ["103550"], "fase": "files"}]
    assert rows[0]["enrichment"] == {"detail": "complete", "files": "complete"}
