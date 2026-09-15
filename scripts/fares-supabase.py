"""Inspect or replicate the local Airfare archive. Dry-run is the default."""

import argparse
import hashlib
import json
import os
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
from app.services.airfare_sync import AirfareSync, SyncMode  # noqa: E402
from app.services.fare_calendar import FareCalendar  # noqa: E402
from app.services.fare_history import FareHistory, _snapshot_from, route_stem  # noqa: E402


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
    pairs: dict[str, set[str]] = {}
    for route in document["routes"]:
        stem = route_stem(route["origin"], route["destination"])
        pairs.setdefault(stem, set()).update(route["months"])
    mismatches = []
    comparisons = []
    known = history.airports()
    for stem, months in sorted(pairs.items()):
        origin, destination = stem.split("-")
        snapshots = history.read(origin, destination)
        minima: dict[str, float] = {}
        for snapshot in snapshots:
            prices = [offer.price for offer in snapshot.offers if offer.price is not None]
            if prices:
                minima[snapshot.flight_date] = min(
                    minima.get(snapshot.flight_date, float("inf")), min(prices)
                )
        pair_reference = (
            {"value": median(minima.values()), "dates": len(minima)} if minima else None
        )
        for departure in [None, *sorted(months)]:
            body = remote.rpc(
                "read_airfare_history",
                {
                    "p_origin": origin,
                    "p_destination": destination,
                    "p_departure": departure,
                    "p_snapshot_months": None,
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
                "baseline": [
                    asdict(point) for point in history.read_baseline(origin, destination, departure)
                ],
                "airports": [
                    asdict(known[code]) for code in (origin, destination) if code in known
                ],
                "health": _health(history.checks(origin, destination, departure)),
                "pairReference": pair_reference,
            }
            remote_answer = {
                "origin": body["origin"],
                "destination": body["destination"],
                "snapshots": [asdict(snapshot) for snapshot in parsed if snapshot is not None],
                "baseline": [
                    {
                        "flight_date": str(row["flightDate"]),
                        "date": str(row["date"]),
                        "price": float(row["price"]),
                    }
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
            "health": _health(calendar.checks(origin, destination)),
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
    source = (REPO_ROOT / args.source).resolve()
    report_path = (REPO_ROOT / args.report).resolve() if args.report else None
    # Reports must never overwrite any authoritative input or cursor file.
    if report_path is not None and any(
        report_path == protected or protected in report_path.parents
        for protected in (source / "fares", source / "kv")
    ):
        parser.error("--report must be outside the source tree")
    started = time.perf_counter()
    report: dict[str, Any] = {"project_ref": None, "source_root": str(source), "status": "failed"}
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
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
