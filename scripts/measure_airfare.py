"""Measure airfare history reads on a frozen, read-only copy of an archive.

No collector or HTTP write endpoint is started. Controlled append, replace,
and truncate operations happen only in a per-run temporary working copy.
"""

import argparse
import gzip
import hashlib
import json
import math
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import tracemalloc
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "api"))


def _load_airfare_modules():
    from app.routers import fares
    from app.services.airfare_data import AirfareData
    from app.services.fare_calendar import FareCalendar
    from app.services.fare_history import FareHistory

    return fares, AirfareData, FareCalendar, FareHistory


fares, AirfareData, FareCalendar, FareHistory = _load_airfare_modules()

MEASUREMENT_METHOD = (
    "Direct production history endpoint model construction only; excludes "
    "Pydantic JSON serialization, HTTP, authentication, browser, collector "
    "startup, and source writes"
)
TIMING_BOUNDARIES = {
    "included": [
        "production get_history function",
        "history read or cache lookup",
        "response-model construction",
    ],
    "excluded": [
        "model_dump_json serialization",
        "HTTP stack",
        "authentication",
        "browser rendering",
        "WAN latency",
        "collector startup and work",
    ],
}


def stats(values: list[float]) -> dict[str, float]:
    return {
        "first_ms": round(values[0], 2),
        "median_ms": round(statistics.median(values), 2),
        "p95_ms": round(sorted(values)[math.ceil(len(values) * 0.95) - 1], 2),
        "max_ms": round(max(values), 2),
    }


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def tree_manifest(directory: Path) -> list[dict[str, Any]]:
    manifest = []
    for path in sorted(directory.rglob("*")):
        if path.is_file():
            content = path.read_bytes()
            manifest.append(
                {
                    "path": path.relative_to(directory).as_posix(),
                    "bytes": len(content),
                    "sha256": sha256_bytes(content),
                }
            )
    return manifest


def manifest_sha256(manifest: list[dict[str, Any]]) -> str:
    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    return sha256_bytes(encoded)


def route_rows(data_dir: Path, requested_pair: str | None) -> list[dict[str, Any]]:
    watchlist = json.loads((data_dir / "kv/airfare-routes.json").read_text(encoding="utf-8"))
    rows = [
        route
        for route in watchlist["routes"]
        if requested_pair is None
        or f"{route['origin']}-{route['destination']}" == requested_pair.upper()
    ]
    if not rows:
        available = ", ".join(
            f"{route['origin']}-{route['destination']}" for route in watchlist["routes"]
        )
        raise ValueError(f"pair {requested_pair!r} is not watched; available: {available}")
    return rows


def selected_relative_paths(data_dir: Path, routes: list[dict[str, Any]]) -> list[Path]:
    paths = [Path("kv/airfare-routes.json"), Path("fares/airports.json")]
    for route in routes:
        pair = f"{route['origin']}-{route['destination']}"
        paths.extend(
            [
                Path(f"fares/{pair}.jsonl"),
                Path(f"fares/baseline/{pair}.jsonl"),
                Path(f"fares/checks/{pair}.jsonl"),
                Path(f"fares/calendar/{pair}.jsonl"),
                Path(f"fares/calendar/checks/{pair}.jsonl"),
            ]
        )
    return sorted({path for path in paths if (data_dir / path).is_file()})


def selected_source_manifest(data_dir: Path, relative_paths: list[Path]) -> list[dict[str, Any]]:
    manifest = []
    for relative in relative_paths:
        content = (data_dir / relative).read_bytes()
        manifest.append(
            {
                "path": relative.as_posix(),
                "bytes": len(content),
                "sha256": sha256_bytes(content),
            }
        )
    return manifest


def create_or_reuse_frozen_copy(
    source: Path, frozen: Path, routes: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], bool]:
    if frozen.exists():
        manifest = tree_manifest(frozen)
        if not manifest or not (frozen / "kv/airfare-routes.json").is_file():
            raise ValueError(f"frozen copy is incomplete: {frozen}")
        route_rows(frozen, None)
        return manifest, True

    relative_paths = selected_relative_paths(source, routes)
    before = selected_source_manifest(source, relative_paths)
    frozen.mkdir(parents=True)
    for relative in relative_paths:
        target = frozen / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, target)
    (frozen / "kv/airfare-routes.json").write_text(
        json.dumps({"version": 1, "routes": routes}, indent=2), encoding="utf-8"
    )
    after = selected_source_manifest(source, relative_paths)
    if before != after:
        raise RuntimeError("source changed while the frozen copy was being created; retry")
    return tree_manifest(frozen), False


@contextmanager
def count_archive_reads(archive: Path):
    original_open = Path.open
    reads = {"count": 0}

    def counted_open(path, mode="r", *args, **kwargs):
        if path == archive and mode == "r":
            reads["count"] += 1
        return original_open(path, mode, *args, **kwargs)

    with patch.object(Path, "open", counted_open):
        yield reads


def response_content(response) -> dict[str, Any]:
    return {
        "snapshots": len(response.snapshots),
        "offers": sum(len(snapshot.offers) for snapshot in response.snapshots),
        "baseline": len(response.baseline),
        "airports": len(response.airports),
        "health": response.health.model_dump(),
    }


def measure_phase(call: Callable[[], Any], archive: Path, samples: int) -> dict[str, Any]:
    times: list[float] = []
    read_samples: list[int] = []
    bodies: list[bytes] = []
    with count_archive_reads(archive) as reads:
        for _ in range(samples):
            reads_before = reads["count"]
            started = time.perf_counter()
            response = call()
            times.append((time.perf_counter() - started) * 1000)
            read_samples.append(reads["count"] - reads_before)
            # Content hashes are computed outside the timed boundary. They prove
            # equivalence without folding JSON serialization into endpoint time.
            bodies.append(response.model_dump_json().encode("utf-8"))

    # Tracing allocations materially slows this 20 MB decode, so memory is a
    # separate, explicitly labelled access after the timed sample(s).
    tracemalloc.start()
    try:
        with count_archive_reads(archive) as memory_reads:
            current_before, _ = tracemalloc.get_traced_memory()
            memory_response = call()
            current_after, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    digests = {sha256_bytes(body) for body in bodies}
    if len(digests) != 1:
        raise RuntimeError("response content changed during an unchanged measurement phase")
    result = {
        "timing": stats(times),
        "samples_ms": [round(value, 2) for value in times],
        "archive_reads": sum(read_samples),
        "archive_reads_per_sample": read_samples,
        "peak_traced_bytes": max(0, peak - min(current_before, current_after)),
        "memory_probe": "one additional access after the timed sample(s)",
        "memory_probe_archive_reads": memory_reads["count"],
        "response_bytes": len(bodies[-1]),
        "gzip_bytes": len(gzip.compress(bodies[-1])),
        "response_sha256": next(iter(digests)),
        "content": response_content(response),
    }
    if sha256_bytes(memory_response.model_dump_json().encode("utf-8")) not in digests:
        raise RuntimeError("memory probe response differs from the timed response")
    return result


def history_call(origin: str, destination: str, month: str):
    return fares.get_history(
        origin=origin,
        destination=destination,
        departure=month,
        since=None,
        until=None,
    )


def configure_local_airfare_data(data_dir: Path) -> None:
    fares.AIRFARE_DATA = AirfareData(
        FareHistory(data_dir / "fares"),
        FareCalendar(data_dir / "fares/calendar"),
        source_root=data_dir,
    )


def replace_archive(archive: Path, rows: list[dict[str, Any]]) -> None:
    temporary = archive.with_suffix(".measurement.tmp")
    temporary.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )
    temporary.replace(archive)


def append_measurement_row(archive: Path, original_rows: list[dict[str, Any]]) -> None:
    appended = dict(original_rows[-1])
    appended["capturedAt"] = "9999-12-31T23:59:59.999999+00:00"
    with archive.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(appended, ensure_ascii=False) + "\n")


def measure_route(data_dir: Path, route: dict[str, Any], samples: int):
    origin = str(route["origin"])
    destination = str(route["destination"])
    month = str(route["months"][0])
    pair = f"{origin}-{destination}"
    archive = data_dir / f"fares/{pair}.jsonl"
    archive_bytes = archive.stat().st_size
    original_rows = [
        json.loads(line)
        for line in archive.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not original_rows:
        raise ValueError(f"cannot measure mutations on an empty archive: {archive}")
    configure_local_airfare_data(data_dir)

    def call():
        return history_call(origin, destination, month)

    initial_response = call()
    phases = {"unchanged_repetitions": measure_phase(call, archive, samples)}
    append_measurement_row(archive, original_rows)
    phases["after_append"] = measure_phase(call, archive, 1)
    replace_archive(archive, original_rows)
    phases["after_replace"] = measure_phase(call, archive, 1)
    replace_archive(archive, original_rows[:1])
    phases["after_truncate"] = measure_phase(call, archive, 1)
    return {
        "pair": pair,
        "month": month,
        "archive_bytes": archive_bytes,
        "initial_response": initial_response.model_dump_json(),
        "phases": phases,
    }


def git_commit() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def phase_summary(phase: dict[str, Any]) -> dict[str, Any]:
    timing = phase["timing"]
    return {
        "median_ms": timing["median_ms"],
        "archive_reads": phase["archive_reads"],
        "peak_traced_bytes": phase["peak_traced_bytes"],
        "response_sha256": phase["response_sha256"],
        "content": phase["content"],
    }


def compare_reports(baseline_path: Path, optimized_path: Path) -> dict[str, Any]:
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    optimized = json.loads(optimized_path.read_text(encoding="utf-8"))
    baseline_dataset = baseline["dataset"]["sha256"]
    if optimized["dataset"]["sha256"] != baseline_dataset:
        raise ValueError("baseline and optimized reports use different frozen datasets")
    baseline_routes = {row["pair"]: row for row in baseline["routes"]}
    optimized_routes = {row["pair"]: row for row in optimized["routes"]}
    if optimized_routes.keys() != baseline_routes.keys():
        raise ValueError("baseline and optimized reports contain different routes")

    rows = []
    equivalent = True
    for pair, baseline_route in baseline_routes.items():
        optimized_route = optimized_routes[pair]
        baseline_phases = baseline_route["history"]["phases"]
        optimized_phases = optimized_route["history"]["phases"]
        if optimized_phases.keys() != baseline_phases.keys():
            raise ValueError(f"phase set differs for {pair}")
        phases = {}
        for name, baseline_phase in baseline_phases.items():
            optimized_phase = optimized_phases[name]
            phase_equivalent = (
                baseline_phase["response_sha256"] == optimized_phase["response_sha256"]
                and baseline_phase["content"] == optimized_phase["content"]
            )
            equivalent = equivalent and phase_equivalent
            baseline_median = float(baseline_phase["timing"]["median_ms"])
            optimized_median = float(optimized_phase["timing"]["median_ms"])
            phases[name] = {
                "content_equivalent": phase_equivalent,
                "baseline": phase_summary(baseline_phase),
                "optimized": phase_summary(optimized_phase),
                "median_delta_ms": round(optimized_median - baseline_median, 2),
                "median_change_percent": (
                    round((optimized_median / baseline_median - 1) * 100, 2)
                    if baseline_median
                    else None
                ),
            }
        rows.append({"pair": pair, "phases": phases})
    return {
        "schema_version": 1,
        "metric": "direct_endpoint_model_construction_ms",
        "timing_boundaries": TIMING_BOUNDARIES,
        "baseline_commit": baseline["commit"],
        "optimized_commit": optimized["commit"],
        "dataset_sha256": baseline_dataset,
        "content_equivalent": equivalent,
        "routes": rows,
    }


def run_phase_worker(args: argparse.Namespace) -> None:
    data_dir = args.worker_data_dir.resolve()
    origin, destination = args.worker_pair.split("-", 1)
    configure_local_airfare_data(data_dir)
    archive = data_dir / f"fares/{args.worker_pair}.jsonl"
    result = measure_phase(lambda: history_call(origin, destination, args.worker_month), archive, 1)
    args.worker_output.write_text(json.dumps(result, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=15)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "services/api/.local-data")
    parser.add_argument("--pair")
    parser.add_argument(
        "--compare",
        nargs=2,
        type=Path,
        metavar=("BASELINE", "OPTIMIZED"),
        help="Compare two reports and write a compact integrity/performance summary",
    )
    parser.add_argument(
        "--frozen-copy",
        type=Path,
        help="Stable master copy to create once and reuse across commits",
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        help="New directory for disposable per-route copies (defaults to system temp)",
    )
    parser.add_argument("--phase-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--worker-data-dir", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--worker-pair", help=argparse.SUPPRESS)
    parser.add_argument("--worker-month", help=argparse.SUPPRESS)
    parser.add_argument("--worker-output", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.phase_worker:
        return args
    if args.compare:
        if args.output is None:
            parser.error("--output is required with --compare")
        return args
    if args.samples < 1:
        parser.error("samples must be positive")
    if args.output is None:
        parser.error("--output is required")
    return args


def main() -> None:
    args = parse_args()
    if args.phase_worker:
        run_phase_worker(args)
        return
    if args.compare:
        comparison = compare_reports(*args.compare)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(comparison, indent=2), encoding="utf-8")
        print(json.dumps(comparison, indent=2))
        return

    source = args.data_dir.resolve()
    routes = route_rows(source, args.pair)
    source_paths = selected_relative_paths(source, routes)
    source_before = selected_source_manifest(source, source_paths)
    frozen = (
        args.frozen_copy.resolve()
        if args.frozen_copy
        else Path(tempfile.mkdtemp(prefix="airfare-frozen-parent-")) / "dataset"
    )
    frozen_manifest, reused = create_or_reuse_frozen_copy(source, frozen, routes)
    frozen_routes = route_rows(frozen, args.pair)
    work_root = (
        args.work_dir.resolve()
        if args.work_dir
        else Path(tempfile.mkdtemp(prefix="airfare-measure-work-"))
    )
    if args.work_dir:
        work_root.mkdir(parents=True, exist_ok=False)
    payload_dir = work_root / "payloads"
    payload_dir.mkdir()
    (payload_dir / "watchlist.json").write_text(
        (frozen / "kv/airfare-routes.json").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    configure_local_airfare_data(frozen)
    (payload_dir / "airports.json").write_text(
        fares.get_airports(None).model_dump_json(), encoding="utf-8"
    )

    rows = []
    for route in frozen_routes:
        pair = f"{route['origin']}-{route['destination']}"
        month = str(route["months"][0])
        route_work = work_root / pair
        shutil.copytree(frozen, route_work)
        first_output = route_work / "first-process-access.json"
        subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--phase-worker",
                "--worker-data-dir",
                str(route_work),
                "--worker-pair",
                pair,
                "--worker-month",
                month,
                "--worker-output",
                str(first_output),
            ],
            cwd=ROOT,
            check=True,
        )
        first_process = json.loads(first_output.read_text(encoding="utf-8"))
        measured = measure_route(route_work, route, args.samples)
        phases = {"first_process_access": first_process, **measured.pop("phases")}
        initial_body = measured.pop("initial_response").encode("utf-8")
        (payload_dir / f"{pair}-history.json").write_bytes(initial_body)

        calendar_response = fares.get_calendar(str(route["origin"]), str(route["destination"]))
        (payload_dir / f"{pair}-calendar.json").write_text(
            calendar_response.model_dump_json(), encoding="utf-8"
        )
        rows.append({**measured, "history": {"phases": phases}})
        print(json.dumps({"pair": pair, "phases": phases}), flush=True)

    source_after = selected_source_manifest(source, source_paths)
    report = {
        "schema_version": 2,
        "commit": git_commit(),
        "method": MEASUREMENT_METHOD,
        "timing_boundaries": TIMING_BOUNDARIES,
        "samples_per_unchanged_phase": args.samples,
        "dataset": {
            "source": str(source),
            "frozen_copy": str(frozen),
            "frozen_copy_reused": reused,
            "sha256": manifest_sha256(frozen_manifest),
            "bytes": sum(int(row["bytes"]) for row in frozen_manifest),
            "files": frozen_manifest,
            "source_sha256_before": manifest_sha256(source_before),
            "source_sha256_after": manifest_sha256(source_after),
            "source_unchanged_during_run": source_before == source_after,
        },
        "payload_dir": str(payload_dir),
        "routes": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Report: {args.output}\nFrozen copy: {frozen}\nWorking copies: {work_root}")


if __name__ == "__main__":
    main()
