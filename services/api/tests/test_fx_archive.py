"""Resumable FX migration uses immutable local rows and complete remote keys."""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest

from app.services.fx.archive_rows import normalize_row, row_key
from app.services.fx.models import SOURCES
from app.services.fx.store import Store

OWNER = UUID("11111111-1111-1111-1111-111111111111")
START = datetime(2026, 10, 1, 5, tzinfo=UTC)


def row(index: int, *, source: str = "kambista", buy: str = "3.4") -> dict:
    observed = START + timedelta(minutes=index)
    return {
        "owner_id": str(OWNER),
        "source": source,
        "effective_at": START.isoformat(),
        "observed_at": observed.isoformat(),
        "buy": buy,
        "sell": "3.5",
        "context": {},
    }


class FakeCloud:
    owner_id = OWNER
    _project_url = "https://example.supabase.co"

    def __init__(self, rows=()):
        self.rows = {row_key(item): normalize_row(item, OWNER) for item in rows}
        self.short_ack = False

    def list_fx(self, *, after=None, limit=500):
        return [
            value
            for key, value in sorted(self.rows.items())
            if (after is None or key > after) and value["effective_at"] >= START.isoformat()
        ][:limit]

    def upsert_fx(self, rows):
        if self.short_ack:
            return len(rows) - 1
        self.rows.update((row_key(item), normalize_row(item, OWNER)) for item in rows)
        return len(rows)


def test_import_restart_after_commit_before_checkpoint(tmp_path: Path, monkeypatch):
    from app.services.fx import archive

    cloud = FakeCloud([row(i) for i in range(5)])
    checkpoint = tmp_path / "import.json"
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        original = archive._save_checkpoint
        calls = 0

        def fail_once(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("checkpoint disk failure")
            return original(*args, **kwargs)

        monkeypatch.setattr(archive, "_save_checkpoint", fail_once)
        with pytest.raises(OSError):
            archive.import_history(store, cloud, checkpoint=checkpoint, batch_size=2)
        monkeypatch.setattr(archive, "_save_checkpoint", original)
        assert archive.import_history(store, cloud, checkpoint=checkpoint, batch_size=2) == 3
        assert len(store.archive_page(limit=100)) == 5
        assert store.pending() == []
        assert store.status("kambista")["last_attempt"] is None


def test_replay_restart_and_short_ack(tmp_path: Path, monkeypatch):
    from app.services.fx import archive

    cloud = FakeCloud()
    checkpoint = tmp_path / "replay.json"
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        store.import_rows([row(i) for i in range(4)])
        cloud.short_ack = True
        with pytest.raises(RuntimeError, match="incomplete"):
            archive.replay_history(store, cloud, checkpoint=checkpoint, batch_size=2)
        assert not checkpoint.exists()
        cloud.short_ack = False
        original = archive._save_checkpoint

        def fail_after_remote(*args, **kwargs):
            raise OSError("checkpoint disk failure")

        monkeypatch.setattr(archive, "_save_checkpoint", fail_after_remote)
        with pytest.raises(OSError):
            archive.replay_history(store, cloud, checkpoint=checkpoint, batch_size=2)
        assert len(cloud.rows) == 2
        monkeypatch.setattr(archive, "_save_checkpoint", original)
        assert archive.replay_history(store, cloud, checkpoint=checkpoint, batch_size=2) == 4
        assert len(cloud.rows) == 4


def test_checkpoint_rejects_owner_operation_or_endpoint(tmp_path: Path):
    from app.services.fx.archive import import_history, replay_history

    cloud = FakeCloud([row(0)])
    checkpoint = tmp_path / "checkpoint.json"
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        import_history(store, cloud, checkpoint=checkpoint)
        with pytest.raises(ValueError, match="checkpoint"):
            replay_history(store, cloud, checkpoint=checkpoint)
        cloud._project_url = "https://other.supabase.co"
        with pytest.raises(ValueError, match="checkpoint"):
            import_history(store, cloud, checkpoint=checkpoint)
        cloud._project_url = "https://example.supabase.co"
        cloud.owner_id = UUID(int=9)
        with pytest.raises(ValueError, match="owner"):
            import_history(store, cloud, checkpoint=checkpoint)


def test_compare_detects_content_and_missing_keys(tmp_path: Path):
    from app.services.fx.archive import compare_history

    cloud = FakeCloud([row(0), row(1)])
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        store.import_rows([row(0), row(1)])
        equal = compare_history(store, cloud, batch_size=1)
        assert set(SOURCES).issubset(equal)
        assert all(equal[source]["matches"] for source in SOURCES)
        cloud.rows[row_key(row(0))] = {
            **row(0),
            "buy": "3.400",
            "observed_at": "2026-10-01T00:00:00-05:00",
        }
        assert compare_history(store, cloud, batch_size=1)["kambista"]["matches"]
        cloud.rows[row_key(row(1))] = normalize_row(row(1, buy="3.41"), OWNER)
        changed = compare_history(store, cloud, batch_size=1)
        assert not changed["kambista"]["matches"]
        assert changed["kambista"]["local_count"] == changed["kambista"]["remote_count"]
        cloud.rows.pop(row_key(row(1)))
        missing = compare_history(store, cloud, batch_size=1)
        assert not missing["kambista"]["matches"]
