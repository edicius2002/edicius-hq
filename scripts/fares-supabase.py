"""Inspect or replicate the local Airfare archive. Dry-run is the default."""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import asdict
from pathlib import Path
from statistics import median
from typing import Any
from urllib.parse import urlsplit

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

from app.config import airfare_supabase_config  # noqa: E402
from app.services.airfare_supabase import (  # noqa: E402
    AirfareRemoteError,
    SupabaseAirfare,
    close_airfare_supabase_client,
    configured_airfare_supabase,
)
from app.services.airfare_sync import AirfareSync, SyncMode, canonical_record_id  # noqa: E402
from app.services.fare_calendar import FareCalendar  # noqa: E402
from app.services.fare_history import FareHistory, _snapshot_from, route_stem  # noqa: E402

_SNAPSHOT_MONTH = re.compile(r"^\d{4}-(?:0[1-9]|1[0-2])$")


def _health(checks: list[dict[str, object]]) -> dict[str, Any]:
    return {
        "lastCheckedAt": str(checks[-1].get("at")) if checks else None,
        "checks": len(checks),
        "changes": sum(row.get("outcome") == "changed" for row in checks),
        "errors": sum(row.get("outcome") == "error" for row in checks),
    }


def _hash(value: object) -> str:
    def normalize(item: object) -> object:
        # JSONB may return 90 where the domain reader emits 90.0. These are
        # equal answers and must have equal comparison digests as well.
        if isinstance(item, int | float) and not isinstance(item, bool):
            return float(item)
        if isinstance(item, dict):
            return {key: normalize(child) for key, child in item.items()}
        if isinstance(item, list | tuple):
            return [normalize(child) for child in item]
        return item

    return hashlib.sha256(
        json.dumps(
            normalize(value),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
    ).hexdigest()


def compare_reads(source: Path, remote: SupabaseAirfare) -> dict[str, Any]:
    """Compare domain answers, including every watched departure prefix."""
    watch = source / "kv/airfare-routes.json"
    document = (
        json.loads(watch.read_text(encoding="utf-8"))
        if watch.exists()
        else {"version": 1, "routes": []}
    )
    if (
        not isinstance(document, dict)
        or document.get("version") != 1
        or not isinstance(document.get("routes"), list)
    ):
        raise ValueError("invalid airfare watch document")
    history, calendar = FareHistory(source / "fares"), FareCalendar(source / "fares/calendar")
    logical = AirfareSync(source).logical_records()
    pairs: dict[str, set[str]] = {}
    for route in document["routes"]:
        route_months = route.get("months") if isinstance(route, dict) else None
        if not isinstance(route_months, list) or any(
            not isinstance(month, str) or _SNAPSHOT_MONTH.fullmatch(month) is None
            for month in route_months
        ):
            raise ValueError("watched route months must use YYYY-MM")
        stem = route_stem(route["origin"], route["destination"])
        pairs.setdefault(stem, set()).update(route_months)
    mismatches = []
    comparisons = []
    known = history.airports()
    for stem, months in sorted(pairs.items()):
        origin, destination = stem.split("-")
        snapshot_months = tuple(sorted(months))
        if not 1 <= len(snapshot_months) <= 12:
            raise ValueError("watched route must name between one and twelve months")

        pair_rows = {
            dataset: [
                row
                for row in logical[dataset]
                if row["origin"] == origin and row["destination"] == destination
            ]
            for dataset in ("snapshots", "baseline", "board_checks", "calendar_checks")
        }

        all_snapshot_rows = sorted(
            pair_rows["snapshots"],
            key=lambda row: (row["captured_at_text"], row["source_line"], row["record_id"]),
        )
        all_snapshots = [
            snapshot
            for row in all_snapshot_rows
            if (snapshot := _snapshot_from(json.dumps(row["payload"]))) is not None
        ]
        baseline_rows = sorted(
            pair_rows["baseline"],
            key=lambda row: (row["flight_date"], row["price_date"], row["record_id"]),
        )
        board_checks = sorted(pair_rows["board_checks"], key=lambda row: row["payload"]["at"])
        calendar_checks = sorted(pair_rows["calendar_checks"], key=lambda row: row["payload"]["at"])
        minima: dict[str, float] = {}
        for snapshot in all_snapshots:
            prices = [offer.price for offer in snapshot.offers if offer.price is not None]
            if prices:
                minima[snapshot.flight_date] = min(
                    minima.get(snapshot.flight_date, float("inf")), min(prices)
                )
        pair_reference = (
            {"value": median(minima.values()), "dates": len(minima)} if minima else None
        )
        for departure in snapshot_months:
            snapshot_rows = [
                row for row in all_snapshot_rows if row["flight_date"].startswith(departure)
            ]
            snapshots = [
                snapshot
                for row in snapshot_rows
                if (snapshot := _snapshot_from(json.dumps(row["payload"]))) is not None
            ]
            selected_baseline = [
                row
                for row in baseline_rows
                if not departure or row["flight_date"].startswith(departure)
            ]
            body = remote.rpc(
                "read_airfare_history",
                {
                    "p_origin": origin,
                    "p_destination": destination,
                    "p_departure": departure,
                    "p_snapshot_months": [departure],
                    "p_since": None,
                    "p_until": None,
                },
            )
            parsed = [_snapshot_from(json.dumps(row)) for row in body["snapshots"]]
            if any(snapshot is None for snapshot in parsed):
                raise ValueError("invalid remote snapshot")
            local_answer = {
                "origin": origin,
                "destination": destination,
                "snapshots": [asdict(snapshot) for snapshot in snapshots],
                "snapshotIdentities": [row["record_id"] for row in snapshot_rows],
                "baseline": [
                    {
                        "flight_date": row["flight_date"],
                        "date": row["price_date"],
                        "price": row["price"],
                    }
                    for row in selected_baseline
                ],
                "baselineIdentities": [row["record_id"] for row in selected_baseline],
                "airports": [
                    asdict(known[code]) for code in (origin, destination) if code in known
                ],
                "health": _health(
                    [
                        row["payload"]
                        for row in board_checks
                        if not departure or row["flight_date"].startswith(departure)
                    ]
                ),
                "pairReference": pair_reference,
            }
            remote_answer = {
                "origin": body["origin"],
                "destination": body["destination"],
                "snapshots": [asdict(snapshot) for snapshot in parsed if snapshot is not None],
                "snapshotIdentities": [
                    canonical_record_id("snapshot", origin, destination, row)
                    for row in body["snapshots"]
                ],
                "baseline": [
                    {
                        "flight_date": str(row["flightDate"]),
                        "date": str(row["date"]),
                        "price": float(row["price"]),
                    }
                    for row in body["baseline"]
                ],
                "baselineIdentities": [
                    canonical_record_id("baseline", origin, destination, row)
                    for row in body["baseline"]
                ],
                "airports": [
                    {
                        key: row.get(key)
                        for key in ("code", "name", "city", "country", "latitude", "longitude")
                    }
                    for row in body["airports"]
                ],
                "health": body["health"],
                "pairReference": body["pairReference"],
            }
            label = f"{stem}:history" + (f":{departure}" if departure else "")
            if local_answer != remote_answer:
                mismatches.append(label)
            comparisons.append(
                {
                    "read": label,
                    "matches": local_answer == remote_answer,
                    "local_digest": _hash(local_answer),
                    "remote_digest": _hash(remote_answer),
                }
            )
        horizon = calendar.horizon(origin, destination)
        local_calendar = {
            "origin": origin,
            "destination": destination,
            "health": _health([row["payload"] for row in calendar_checks]),
            "horizon": None
            if horizon is None
            else {
                "capturedAt": horizon.captured_at,
                "source": horizon.source,
                "currency": horizon.currency,
                "fromDate": horizon.start,
                "toDate": horizon.end,
                "prices": [
                    {
                        "departureDate": point.departure_date,
                        "price": point.price,
                        "observedAt": point.observed_at,
                    }
                    for point in horizon.prices
                ],
            },
        }
        remote_calendar = remote.rpc(
            "read_airfare_calendar", {"p_origin": origin, "p_destination": destination}
        )
        if remote_calendar["horizon"] is not None:
            for point in remote_calendar["horizon"]["prices"]:
                if point["price"] is not None:
                    point["price"] = float(point["price"])
        label = f"{stem}:calendar"
        if local_calendar != remote_calendar:
            mismatches.append(label)
        comparisons.append(
            {
                "read": label,
                "matches": local_calendar == remote_calendar,
                "local_digest": _hash(local_calendar),
                "remote_digest": _hash(remote_calendar),
            }
        )
    return {
        "matches": not mismatches,
        "routes": len(pairs),
        "mismatches": mismatches,
        "comparisons": comparisons,
    }


def _validate_report_target(source: Path, target: Path) -> None:
    """Refuse lexical, junction/symlink, and hardlink aliases of source data."""
    lexical_source = Path(os.path.abspath(source))
    lexical_target = Path(os.path.abspath(target))
    resolved_target = target.resolve()
    roots = {lexical_source / name for name in ("fares", "kv")}
    roots.update(root.resolve() for root in tuple(roots))
    # Consumed files may be below nested junctions outside either root. Their
    # resolved parent directories remain authoritative as well.
    sync = AirfareSync(source)
    roots.update(directory.resolve() for directory in sync.source_directories())
    files = sync.source_files()
    roots.update(path.parent.resolve() for path in files)
    # A source-file link can name a missing target. Compare its prospective
    # resolved file path without treating unrelated siblings as source data.
    if resolved_target in {path.resolve() for path in files}:
        raise ValueError("report target aliases an authoritative Airfare file")
    if any(
        candidate == root or root in candidate.parents
        for root in roots
        for candidate in (lexical_target, resolved_target)
    ):
        raise ValueError("report target overlaps authoritative Airfare files")
    if target.exists():
        identity = target.stat()
        for path in files:
            try:
                source_identity = path.stat()
            except FileNotFoundError:
                # A distinct dangling source link has no identity to compare.
                continue
            if (identity.st_dev, identity.st_ino) == (
                source_identity.st_dev,
                source_identity.st_ino,
            ):
                raise ValueError("report target aliases an authoritative Airfare file")


def _source_label(source: Path) -> str:
    """Return a stable report label without disclosing an external filesystem path."""
    try:
        return source.relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError:
        return "<external-source>"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    for action in ("dry-run", "apply", "verify", "compare-reads"):
        actions.add_argument(f"--{action}", action="store_true")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--full", action="store_true")
    modes.add_argument("--incremental", action="store_true")
    parser.add_argument(
        "--source", type=Path, default=Path(os.getenv("LOCAL_DATA_DIR", ".local-data"))
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    source = REPO_ROOT / args.source
    report_path = REPO_ROOT / args.report if args.report else None
    if report_path is not None:
        try:
            _validate_report_target(source, report_path)
        except (OSError, ValueError):
            parser.error("--report must not overlap or alias authoritative Airfare files")
    source = source.resolve()
    started = time.perf_counter()
    report: dict[str, Any] = {
        "project_ref": None,
        "source_root": _source_label(source),
        "status": "failed",
    }
    exit_code = 1
    try:
        client = None
        batch_size = 250
        if args.apply or args.verify or args.compare_reads:
            os.environ["AIRFARE_SYNC_ENABLED"] = "true"
            config = airfare_supabase_config()
            assert config is not None
            client = configured_airfare_supabase()
            report["project_ref"] = (urlsplit(config.url).hostname or "").split(".")[0]
            batch_size = config.batch_size
        sync = AirfareSync(source, client, batch_size=batch_size)
        mode: SyncMode = "incremental" if args.incremental else "full"
        if args.apply:
            report.update(asdict(sync.apply(mode)))
        else:
            manifest = sync.scan(mode)
            report["source"] = asdict(manifest)
            if args.verify:
                result = sync.verify(manifest)
                report.update(asdict(result))
                report["status"] = "complete" if result.matches else "failed"
            elif args.compare_reads:
                assert client is not None
                result_dict = compare_reads(source, client)
                report.update(result_dict)
                report["status"] = "complete" if result_dict["matches"] else "failed"
            else:
                report.update(mode="dry-run", status="complete")
        exit_code = 0 if report["status"] == "complete" else 1
    except (AirfareRemoteError, OSError, ValueError, KeyError, TypeError):
        # Raw source rows, remote response bodies, and environment values never
        # belong in an operator report, including exception messages.
        report["error"] = "Airfare operation failed; check source files and cloud configuration"
    finally:
        close_airfare_supabase_client()
    report["duration_seconds"] = round(time.perf_counter() - started, 6)
    encoded = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)
    if report_path is not None:
        try:
            _validate_report_target(source, report_path)
        except (OSError, ValueError):
            parser.error("--report must not overlap or alias authoritative Airfare files")
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
