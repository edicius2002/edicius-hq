import json
import sqlite3
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

import pytest

from app.services.fx.models import Observation
from app.services.fx.store import Store

OWNER = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
OTHER = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
NOW = datetime(2026, 10, 2, 18, tzinfo=UTC)


def observation(now=NOW, buy="3.4", effective=None):
    return Observation("kambista", now, effective or now, Decimal(buy), Decimal("3.5"))


def row(now=NOW, owner=OWNER, buy="3.4", effective=None):
    return {**observation(now, buy, effective).wire(), "owner_id": str(owner)}


def test_ack_leaves_archive(tmp_path):
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        store.save("kambista", [observation()], NOW, attempted_at=NOW)
        store.acknowledge(store.pending())
        assert len(store.archive_page()) == 1
        assert store.pending() == []


def test_legacy_outbox_migration_is_idempotent(tmp_path):
    path = tmp_path / "fx.sqlite"
    old = row(NOW - timedelta(days=10))  # Preserve even pre-history-boundary rows.
    with sqlite3.connect(path) as db:
        db.execute(
            "create table outbox(owner text, source text, effective text, observed text, payload text not null, primary key(owner,source,effective,observed))"
        )
        db.execute(
            "insert into outbox values(?,?,?,?,?)",
            (str(OWNER), old["source"], old["effective_at"], old["observed_at"], json.dumps(old)),
        )
    with Store(path, OWNER, readonly=True) as store:
        assert (
            store.db.execute("select name from sqlite_master where name='observations'").fetchone()
            is None
        )
    for _ in range(2):
        with Store(path, OWNER) as store:
            assert len(store.archive_page()) == 1
            assert len(store.pending()) == 1
    with Store(path, OWNER) as store:
        store.acknowledge([old])
        assert store.pending() == []
        assert len(store.archive_page()) == 1


def test_save_rollback_is_atomic(tmp_path):
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        store.db.execute(
            "create trigger fail_outbox before insert on outbox begin select raise(abort, 'injected'); end"
        )
        with pytest.raises(sqlite3.IntegrityError, match="injected"):
            store.save("kambista", [observation()], NOW, attempted_at=NOW)
        assert store.archive_page() == []
        assert store.pending() == []
        assert store.due("kambista", NOW)
        assert store.status("kambista")["last_attempt"] is None


def test_existing_key_is_immutable(tmp_path):
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        assert store.import_rows([row()]) == 1
        assert store.import_rows([row(buy="3.45")]) == 0
        assert store.archive_page()[0]["buy"] == "3.4"
        assert store.pending() == []
        assert store.status("kambista")["next_due"] is None
        assert store.status("kambista")["last_attempt"] is None
        store.save("kambista", [observation(buy="3.45")], NOW)
        assert store.pending()[0]["buy"] == "3.4"


def test_owner_isolation_and_import_validation(tmp_path):
    path = tmp_path / "fx.sqlite"
    with Store(path, OWNER) as store:
        store.import_rows([row()])
    with Store(path, OTHER) as store:
        assert store.archive_page() == []
        assert store.latest("kambista") is None
        with pytest.raises(ValueError):
            store.import_rows([row(owner=OTHER), row()])
        assert store.archive_page() == []
        store.import_rows([row(owner=OTHER, buy="3.45")])
    with Store(path, OWNER) as store:
        assert store.archive_page()[0]["buy"] == "3.4"


def test_two_page_traversal_and_latest(tmp_path):
    from app.services.fx.archive_rows import row_key

    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        store.import_rows(
            [row(NOW + timedelta(minutes=2), effective=NOW), row(), row(NOW + timedelta(minutes=1))]
        )
        first = store.archive_page(limit=2)
        second = store.archive_page(after=row_key(first[-1]), limit=2)
        assert len(first) == 2 and len(second) == 1
        assert [r["observed_at"] for r in first + second] == [
            "2026-10-02T18:00:00.000000+00:00",
            "2026-10-02T18:02:00.000000+00:00",
            "2026-10-02T18:01:00.000000+00:00",
        ]
        assert store.latest("kambista")["observed_at"] == "2026-10-02T18:02:00.000000+00:00"
        assert (
            store.latest("kambista", effective_at=NOW + timedelta(minutes=1))["observed_at"]
            == "2026-10-02T18:01:00.000000+00:00"
        )
        assert store.archive_page(after=row_key(second[-1])) == []


def test_live_backup_integrity_and_destination_guards(tmp_path):
    path, backup = tmp_path / "fx.sqlite", tmp_path / "backup.sqlite"
    with Store(path, OWNER) as store:
        store.save("kambista", [observation()], NOW, attempted_at=NOW)
        with pytest.raises(ValueError):
            store.backup(path)
        store.backup(backup)
        with pytest.raises(ValueError):
            store.backup(backup)
    with Store(backup, OWNER, readonly=True) as restored:
        assert restored.db.execute("pragma integrity_check").fetchone()[0] == "ok"
        assert len(restored.archive_page()) == 1
        assert len(restored.pending()) == 1
        assert restored.status("kambista")["last_success"] == NOW
