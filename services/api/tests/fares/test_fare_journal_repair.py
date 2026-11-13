"""Leading NUL repair preserves valid observations and the exact original backup."""

import importlib.util
from pathlib import Path

import pytest


def _module():
    script = Path(__file__).resolve().parents[4] / "scripts/fares-repair-null-bytes.py"
    spec = importlib.util.spec_from_file_location("fares_repair_null_bytes", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_repairs_only_leading_nul_and_keeps_original_backup(tmp_path):
    repair = _module().repair
    path = tmp_path / "fares/checks/AQP-LIM.jsonl"
    path.parent.mkdir(parents=True)
    original = b'{"at":"2026-10-01"}\n\0\0{"at":"2026-10-02"}\n'
    path.write_bytes(original)
    assert repair(tmp_path, ["checks/AQP-LIM.jsonl"]) == [
        {"path": "checks/AQP-LIM.jsonl", "lines": 1, "nul_bytes": 2}
    ]
    assert path.read_bytes() == original
    backup = tmp_path / "repair-backup"
    repair(tmp_path, ["checks/AQP-LIM.jsonl"], backup_dir=backup)
    assert (backup / "checks/AQP-LIM.jsonl").read_bytes() == original
    assert path.read_bytes() == original.replace(b"\0", b"")
    assert repair(tmp_path, ["checks/AQP-LIM.jsonl"]) == [
        {"path": "checks/AQP-LIM.jsonl", "lines": 0, "nul_bytes": 0}
    ]


def test_rejects_internal_nul_without_editing_file(tmp_path):
    repair = _module().repair
    path = tmp_path / "fares/spend/2026-10-01.jsonl"
    path.parent.mkdir(parents=True)
    original = b'{"a":"x\0y"}\n'
    path.write_bytes(original)
    with pytest.raises(ValueError, match="NUL byte inside"):
        repair(tmp_path, ["spend/2026-10-01.jsonl"], backup_dir=tmp_path / "backup")
    assert path.read_bytes() == original
    assert not (tmp_path / "backup").exists()


def test_validates_all_files_before_replacing_any(tmp_path):
    repair = _module().repair
    checks = tmp_path / "fares/checks/AQP-LIM.jsonl"
    spend = tmp_path / "fares/spend/2026-10-01.jsonl"
    checks.parent.mkdir(parents=True)
    spend.parent.mkdir(parents=True)
    original = b'\0{"at":"2026-10-01"}\n'
    checks.write_bytes(original)
    spend.write_bytes(b'{"a":"x\0y"}\n')
    backup = tmp_path / "backup"
    with pytest.raises(ValueError, match="NUL byte inside"):
        repair(
            tmp_path,
            ["checks/AQP-LIM.jsonl", "spend/2026-10-01.jsonl"],
            backup_dir=backup,
        )
    assert checks.read_bytes() == original
    assert not backup.exists()
