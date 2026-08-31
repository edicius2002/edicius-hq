import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def load_script():
    path = REPO_ROOT / "scripts" / "fares-viapoints-backfill.py"
    spec = importlib.util.spec_from_file_location("fares_viapoints_backfill", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MISSING = object()


def offer(
    flight_number: str,
    *,
    via_points: list[str] | object | None = MISSING,
    transfers: int = 1,
) -> dict[str, object]:
    row: dict[str, object] = {
        "airline": "LA",
        "flightNumber": flight_number,
        "departureAt": "2026-10-16T08:00",
        "arrivalAt": "2026-10-16T14:00",
        "transfers": transfers,
        "durationMinutes": 360,
        "price": 125.0,
        "currency": "USD",
    }
    if via_points is not MISSING:
        row["viaPoints"] = via_points
    return row


def snapshot(*offers: dict[str, object]) -> dict[str, object]:
    return {
        "capturedAt": "2026-08-28T12:00:00+00:00",
        "source": "google-flights",
        "origin": "LIM",
        "destination": "SCL",
        "flightDate": "2026-10-16",
        "returnDate": None,
        "currency": "USD",
        "insights": None,
        "offers": list(offers),
    }


def write_rows(directory: Path, *rows: dict[str, object]) -> tuple[Path, str]:
    path = directory / "LIM-SCL.jsonl"
    directory.mkdir(parents=True, exist_ok=True)
    text = "".join(json.dumps(row) + "\n" for row in rows)
    path.write_text(text, encoding="utf-8")
    return path, text


def rows(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_dry_run_reports_match_unmatched_and_ambiguous_without_writing(
    tmp_path, monkeypatch, capsys
):
    script = load_script()
    path, before = write_rows(
        tmp_path,
        snapshot(offer("74", via_points=["BOG"])),
        snapshot(offer("74", via_points=None)),
        snapshot(offer("75")),
        snapshot(offer("77", via_points=["YUL"])),
        snapshot(offer("76", via_points=["BOG"])),
        snapshot(offer("76", via_points=["YUL"])),
        snapshot(offer("76")),
    )

    report = script.backfill(tmp_path)

    assert (report.matched, report.unmatched, report.ambiguous) == (1, 1, 1)
    assert path.read_text(encoding="utf-8") == before
    assert not list(tmp_path.glob("*.bak"))

    monkeypatch.setattr(sys, "argv", ["fares-viapoints-backfill.py", "--directory", str(tmp_path)])
    assert script.main() == 0
    assert capsys.readouterr().out == (
        "would fill 1 offer(s); 1 without match; 1 skipped as ambiguous; 1 file(s) affected\n"
        "dry run; nothing was written\n"
    )


def test_write_fills_only_missing_match_and_preserves_jsonl_order_and_format(tmp_path):
    script = load_script()
    path, before = write_rows(
        tmp_path,
        snapshot(offer("74", via_points=["BOG"])),
        snapshot(offer("74", via_points=None)),
        snapshot(offer("75")),
        snapshot(offer("77", via_points=["YUL"])),
    )

    report = script.backfill(tmp_path, write=True)

    saved = rows(path)
    assert report.matched == 1
    assert saved[1]["offers"][0]["viaPoints"] == ["BOG"]
    assert "viaPoints" not in saved[2]["offers"][0]
    assert saved[3]["offers"][0]["viaPoints"] == ["YUL"]
    assert list(saved[1]["offers"][0])[-1] == "viaPoints"
    assert (
        path.with_name("LIM-SCL.jsonl.viapoints-backfill.bak").read_text(encoding="utf-8") == before
    )

    after = path.read_text(encoding="utf-8")
    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)
    assert after_lines[0] == before_lines[0]
    assert after_lines[1].replace('"viaPoints": ["BOG"]', '"viaPoints": null') == before_lines[1]
    assert after_lines[2:] == before_lines[2:]


def test_second_write_is_idempotent_and_keeps_the_single_backup(tmp_path):
    script = load_script()
    path, _ = write_rows(tmp_path, snapshot(offer("74", via_points=["BOG"])), snapshot(offer("74")))

    script.backfill(tmp_path, write=True)
    once = path.read_text(encoding="utf-8")
    second = script.backfill(tmp_path, write=True)

    assert second.matched == 0
    assert path.read_text(encoding="utf-8") == once
    assert [backup.name for backup in tmp_path.glob("*.bak")] == [
        "LIM-SCL.jsonl.viapoints-backfill.bak"
    ]
