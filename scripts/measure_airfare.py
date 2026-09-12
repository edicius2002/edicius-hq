"""Read-only measurements of the real airfare archive; never starts collectors."""

import argparse
import gzip
import json
import math
import statistics
import sys
import tempfile
import time
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "api"))

from app.routers import fares  # noqa: E402
from app.services.fare_calendar import FareCalendar  # noqa: E402
from app.services.fare_history import FareHistory  # noqa: E402


def measure(call):
    start = time.perf_counter()
    result = call()
    return result, (time.perf_counter() - start) * 1000


def stats(values):
    return {
        "first_ms": round(values[0], 2),
        "median_ms": round(statistics.median(values), 2),
        "p95_ms": round(sorted(values)[math.ceil(len(values) * 0.95) - 1], 2),
        "max_ms": round(max(values), 2),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=15)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "services/api/.local-data")
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("samples must be positive")
    fares.HISTORY = FareHistory(args.data_dir / "fares")
    fares.CALENDAR = FareCalendar(args.data_dir / "fares/calendar")
    watches = json.loads((args.data_dir / "kv/airfare-routes.json").read_text(encoding="utf-8"))
    payload_dir = Path(tempfile.mkdtemp(prefix="airfare-measure-"))
    (payload_dir / "watchlist.json").write_text(json.dumps(watches), encoding="utf-8")
    (payload_dir / "airports.json").write_text(
        fares.get_airports(None).model_dump_json(), encoding="utf-8"
    )
    report = {
        "method": "Direct production endpoint functions and Pydantic JSON serialization; no network/auth/browser or collector startup",
        "samples_per_endpoint": args.samples,
        "payload_dir": str(payload_dir),
        "routes": [],
    }
    for route in watches["routes"]:
        origin, destination = route["origin"], route["destination"]
        month = route["months"][0]
        pair = f"{origin}-{destination}"
        row = {
            "pair": pair,
            "month": month,
            "archive_bytes": (args.data_dir / "fares" / f"{pair}.jsonl").stat().st_size,
        }
        for kind in ("history", "calendar"):
            timings, serialization, totals, counts = [], [], [], []
            for _ in range(args.samples):
                if kind == "history":
                    response, elapsed = measure(
                        partial(fares.get_history, origin, destination, month, None, None)
                    )
                    counts.append(len(response.snapshots))
                else:
                    response, elapsed = measure(partial(fares.get_calendar, origin, destination))
                    counts.append(len(response.horizon.prices) if response.horizon else 0)
                body, serial_ms = measure(response.model_dump_json)
                timings.append(elapsed)
                serialization.append(serial_ms)
                totals.append(elapsed + serial_ms)
            encoded = body.encode("utf-8")
            (payload_dir / f"{pair}-{kind}.json").write_bytes(encoded)
            row[kind] = {
                "endpoint": stats(timings),
                "serialization": stats(serialization),
                "total": stats(totals),
                "response_bytes": len(encoded),
                "gzip_bytes": len(gzip.compress(encoded)),
                "count_min": min(counts),
                "count_max": max(counts),
                "empty_responses": counts.count(0),
            }
            if kind == "history":
                row[kind]["offers"] = sum(len(s.offers) for s in response.snapshots)
                row[kind]["month_snapshots"] = sum(
                    s.flightDate.startswith(month) for s in response.snapshots
                )
        report["routes"].append(row)
        print(json.dumps(row), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Report: {args.output}\nTemporary payloads: {payload_dir}", flush=True)


if __name__ == "__main__":
    main()
