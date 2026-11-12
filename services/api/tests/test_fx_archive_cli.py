"""The archive operator command stays offline for backup and locks writers."""

import os
import runpy
import sqlite3
import subprocess
import sys
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

from app.services.fx.archive_rows import row_key
from app.services.fx.store import Store

OWNER = UUID("11111111-1111-1111-1111-111111111111")
SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "fx-archive.py"


def _row(i):
    observed = datetime(2026, 10, 1, 5, tzinfo=UTC) + timedelta(minutes=i)
    return dict(
        owner_id=str(OWNER),
        source="kambista",
        effective_at="2026-10-01T05:00:00+00:00",
        observed_at=observed.isoformat(),
        buy="3.4",
        sell="3.5",
        context={},
    )


def test_offline_backup_requires_only_local_owner(tmp_path: Path):
    root = tmp_path / "data"
    with Store(root / "fx" / "outbox.sqlite", OWNER) as store:
        store.import_rows([_row(0)])
    output = tmp_path / "fx-backup.sqlite"
    env = {**os.environ, "LOCAL_DATA_DIR": str(root), "EDICIUS_OWNER_ID": str(OWNER)}
    env.pop("SUPABASE_SECRET_KEY", None)
    env.pop("SUPABASE_URL", None)
    run = subprocess.run(
        [sys.executable, str(SCRIPT), "backup", "--output", str(output)],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert run.returncode == 0, run.stderr
    with sqlite3.connect(output) as backup:
        assert backup.execute("select count(*) from observations").fetchone()[0] == 1
    again = subprocess.run(
        [sys.executable, str(SCRIPT), "backup", "--output", str(output)],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert again.returncode == 1
    assert "3.4" not in again.stderr


def test_cli_import_replay_drain_lock_and_compare(tmp_path: Path, monkeypatch, capsys):
    module = runpy.run_path(str(SCRIPT))
    globals_ = module["main"].__globals__

    class Cloud:
        owner_id = OWNER
        _project_url = "https://example.supabase.co"

        def __init__(self):
            self.rows = {row_key(row): row for row in [_row(0), _row(1)]}

        def list_fx(self, *, after=None, limit=500):
            return [row for key, row in sorted(self.rows.items()) if after is None or key > after][
                :limit
            ]

        def upsert_fx(self, rows):
            self.rows.update((row_key(row), row) for row in rows)
            return len(rows)

        def close(self):
            pass

    cloud = Cloud()
    locks = []

    @contextmanager
    def locked(name):
        locks.append(name)
        yield

    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))
    monkeypatch.setitem(globals_, "CollectorCloud", lambda _: cloud)
    monkeypatch.setitem(globals_, "collector_config", lambda: object())
    monkeypatch.setitem(globals_, "exclusive_process_lock", locked)
    main = module["main"]
    assert main(["import", "--checkpoint", str(tmp_path / "import.json"), "--batch-size", "1"]) == 0
    assert locks == ["fx", "fx"]
    assert main(["replay", "--checkpoint", str(tmp_path / "replay.json")]) == 0
    assert main(["drain"]) == 0
    assert locks == ["fx", "fx", "fx", "fx"]
    assert main(["compare"]) == 0
    assert "matches" in capsys.readouterr().out


def test_cli_invalid_checkpoint_has_no_payload_or_secret(tmp_path: Path, monkeypatch, capsys):
    module = runpy.run_path(str(SCRIPT))
    globals_ = module["main"].__globals__

    class Cloud:
        owner_id = OWNER
        _project_url = "https://example.supabase.co"

        def close(self):
            pass

    with Store(tmp_path / "fx" / "outbox.sqlite", OWNER):
        pass
    checkpoint = tmp_path / "foreign.json"
    checkpoint.write_text('{"secret":"private-fx-payload"}', encoding="utf-8")
    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))
    monkeypatch.setitem(globals_, "CollectorCloud", lambda _: Cloud())
    monkeypatch.setitem(globals_, "collector_config", lambda: object())
    assert module["main"](["import", "--checkpoint", str(checkpoint)]) == 1
    output = capsys.readouterr()
    assert "private-fx-payload" not in output.out + output.err
    assert "example.supabase.co" not in output.out + output.err
