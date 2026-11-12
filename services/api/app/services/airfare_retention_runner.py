"""Supervised, resumable departure retention across the Pi and its replica."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from datetime import date, datetime
from pathlib import Path
from uuid import UUID, uuid4

from app.services.airfare_retention import retention_cutoff
from app.services.airfare_retention_gate import maintenance_lock
from app.services.airfare_retention_store import (
    RetentionStore,
    _read_journal,
    retained_calendar_row,
)
from app.services.airfare_supabase import AirfareRemoteError, SupabaseAirfare
from app.services.airfare_sync import (
    _JOURNALS,
    _KINDS,
    AirfareSync,
    SourceManifest,
    _exclusive_process_lock,
    _record,
)

_ROUTE = re.compile(r"[A-Z0-9]{3}-[A-Z0-9]{3}\Z")


@dataclass(frozen=True, slots=True)
class RetentionReport:
    run_id: str | None
    cutoff: str
    phase: str
    verified: bool
    expired_rows: dict[str, int]
    estimated_source_bytes: int
    mismatches: tuple[str, ...] = ()
    error: str | None = None


class RetentionRunner:
    """Never prune until source/replica equality and published partitions hold."""

    def __init__(self, root: Path, remote: SupabaseAirfare):
        self.root = root.resolve()
        self.remote = remote
        self.store = RetentionStore(self.root)
        self.sync = AirfareSync(self.root, remote)

    def _routes(self) -> list[str]:
        names: set[str] = set()
        for directory in _JOURNALS.values():
            names.update(path.stem for path in (self.root / directory).glob("*.jsonl"))
        partitions = self.store.retention / "partitions"
        if partitions.exists():
            names.update(path.name for path in partitions.iterdir() if path.is_dir())
        if any(not _ROUTE.fullmatch(route) for route in names):
            raise ValueError("invalid Airfare retention source route")
        return sorted(names)

    def _estimate(self, cutoff: date, routes: list[str]) -> tuple[dict[str, int], int]:
        counts = {name: 0 for name in _JOURNALS}
        bytes_to_remove = 0
        for route in routes:
            for dataset, directory in _JOURNALS.items():
                if dataset == "calendar_checks":
                    continue
                _, rows = _read_journal(self.root / directory / f"{route}.jsonl", dataset, route)
                for line, row in rows:
                    departure = row.get("flightDate")
                    if departure is not None and date.fromisoformat(departure) < cutoff:
                        counts[dataset] += 1
                        bytes_to_remove += len(line)
                    elif dataset == "calendar":
                        kept = retained_calendar_row(row, cutoff)
                        if kept is not row:
                            counts[dataset] += 1
                            bytes_to_remove += (
                                len(line)
                                if kept is None
                                else max(0, len(line) - len(json.dumps(kept).encode("utf-8")) - 1)
                            )
        return counts, bytes_to_remove

    def _expected_groups(self, source: SourceManifest) -> list[dict[str, object]]:
        groups = []
        for dataset in _KINDS:
            for route, group in getattr(source, dataset).by_route.items():
                groups.append(
                    {
                        "dataset": dataset,
                        "route": route,
                        "count": group.records,
                        "digest": group.digest,
                    }
                )
        return sorted(groups, key=lambda row: (str(row["dataset"]), str(row["route"])))

    def _summaries_equal(self, routes: list[str]) -> bool:
        expected = {
            (summary.origin, summary.destination, summary.flight_date, summary.digest)
            for route in routes
            for summary in self.store.summaries(*route.split("-"))
        }
        actual = {
            (row["origin"], row["destination"], str(row["flight_date"]), row["digest"])
            for row in self.remote.select_all(
                "fare_departure_summaries",
                ("origin", "destination", "flight_date", "digest"),
                key="digest",
            )
        }
        return expected == actual

    def _replace_calendars(self, run_id: str, cutoff: date, routes: list[str]) -> None:
        for route in routes:
            path = self.root / "fares/calendar" / f"{route}.jsonl"
            _, rows = _read_journal(path, "calendar", route)
            retained_line = 0
            for line_number, (_, row) in enumerate(rows, 1):
                old_record = _record("calendar", route, row, line_number)
                if old_record is None:
                    raise ValueError("invalid Airfare calendar source")
                retained = retained_calendar_row(row, cutoff)
                if retained is not None:
                    retained_line += 1
                if retained is row:
                    continue
                replacement = (
                    _record("calendar", route, retained, retained_line)
                    if retained is not None
                    else None
                )
                if retained is not None and replacement is None:
                    raise ValueError("invalid Airfare calendar replacement")
                self.remote.rpc(
                    "replace_airfare_retention_calendar",
                    {
                        "p_run_id": run_id,
                        "p_record_id": old_record["record_id"],
                        "p_replacement": replacement,
                    },
                )

    def _verify_finished(self, cutoff: date, routes: list[str]) -> tuple[str, ...]:
        source = self.sync.scan("full")
        expected = self._expected_groups(source)
        remote_groups = [
            group for group in self.sync._remote_groups() if group["dataset"] != "retention"
        ]
        if remote_groups != expected:
            return ("datasets:route-manifest",)
        if not self._summaries_equal(routes):
            return ("summaries:keys-and-digests",)
        desired = replace(source, cutoff=cutoff.isoformat(), phase="verified")
        report = self.sync.verify(desired)
        return report.mismatches

    def run(self, *, now: datetime, dry_run: bool = True) -> RetentionReport:
        cutoff = retention_cutoff(now)
        if dry_run:
            routes = self._routes()
            counts, size = self._estimate(cutoff, routes)
            source = self.sync.scan("full")
            verification = self.sync.verify(source)
            phase = self.store.state()["phase"]
            mismatches = verification.mismatches + (
                ("retention:pending",) if phase != "verified" else ()
            )
            return RetentionReport(
                None,
                cutoff.isoformat(),
                phase,
                not mismatches,
                counts,
                size,
                mismatches,
            )

        with (
            maintenance_lock(self.root / "fares"),
            _exclusive_process_lock(self.sync.process_lock_path),
        ):
            state = self.store.state()
            if state["phase"] != "verified":
                cutoff = date.fromisoformat(state["target_cutoff"])
                run_id = str(UUID(state["run_id"]))
            elif state.get("cutoff") == cutoff.isoformat():
                run_id = str(UUID(state["run_id"]))
            else:
                run_id = str(uuid4())
            routes = self._routes()
            counts, size = self._estimate(cutoff, routes)
            try:
                if state["phase"] == "verified" and state.get("cutoff") == cutoff.isoformat():
                    mismatches = self._verify_finished(cutoff, routes)
                    return RetentionReport(
                        run_id,
                        cutoff.isoformat(),
                        "verified",
                        not mismatches,
                        counts,
                        size,
                        mismatches,
                    )
                if state["phase"] == "verified":
                    preflight = self.sync.verify(self.sync.scan("full"))
                    if not preflight.matches:
                        raise ValueError(
                            "preflight replica mismatch: " + ",".join(preflight.mismatches)
                        )
                    self.store.write_state(
                        {
                            "phase": "pending",
                            "cutoff": state.get("cutoff"),
                            "target_cutoff": cutoff.isoformat(),
                            "run_id": run_id,
                        }
                    )
                remote_state = self.remote.rpc(
                    "begin_airfare_retention",
                    {"p_run_id": run_id, "p_cutoff": cutoff.isoformat()},
                )
                if (
                    not isinstance(remote_state, dict)
                    or remote_state.get("run_id") != run_id
                    or remote_state.get("target_cutoff") != cutoff.isoformat()
                ):
                    raise ValueError("replica returned an invalid retention run")
                if remote_state.get("phase") != "verified":
                    for route in routes:
                        origin, destination = route.split("-")
                        self.store.stage_route(origin, destination, cutoff)
                    for route in routes:
                        for summary in self.store.summaries(*route.split("-")):
                            if date.fromisoformat(summary.flight_date) < cutoff:
                                self.remote.rpc(
                                    "publish_airfare_departure_summary",
                                    {
                                        "p_run_id": run_id,
                                        "p_payload": summary.to_payload(),
                                        "p_digest": summary.digest,
                                    },
                                )
                    if not self._summaries_equal(routes):
                        raise ValueError("replica summary keys or digests differ")
                    self.store.write_state({**self.store.state(), "phase": "summarized"})
                    self._replace_calendars(run_id, cutoff, routes)
                    for route in routes:
                        origin, destination = route.split("-")
                        self.store.compact_route(origin, destination, cutoff)
                    self.store.write_state({**self.store.state(), "phase": "compacted"})
                    for route in routes:
                        for summary in self.store.summaries(*route.split("-")):
                            if date.fromisoformat(summary.flight_date) < cutoff:
                                self.remote.rpc(
                                    "prune_airfare_departure",
                                    {
                                        "p_run_id": run_id,
                                        "p_origin": summary.origin,
                                        "p_destination": summary.destination,
                                        "p_flight_date": summary.flight_date,
                                    },
                                )
                    self.store.write_state({**self.store.state(), "phase": "pruned"})
                    replay = self.sync._apply_locked(
                        "full", False, None, allow_retention_pending=True
                    )
                    if replay.status != "complete":
                        raise ValueError("retained Airfare replay failed")
                    source = self.sync.scan("full")
                    expected = self._expected_groups(source)
                    remote_groups = [
                        group
                        for group in self.sync._remote_groups()
                        if group["dataset"] != "retention"
                    ]
                    if remote_groups != expected or not self._summaries_equal(routes):
                        raise ValueError("replica retained manifest mismatch")
                    self.remote.rpc(
                        "finish_airfare_retention",
                        {"p_run_id": run_id, "p_manifest": expected},
                    )
                mismatches = self._verify_finished(cutoff, routes)
                if mismatches:
                    raise ValueError("verified replica mismatch: " + ",".join(mismatches))
                self.store.write_state(
                    {
                        "phase": "verified",
                        "cutoff": cutoff.isoformat(),
                        "target_cutoff": cutoff.isoformat(),
                        "run_id": run_id,
                    }
                )
                return RetentionReport(run_id, cutoff.isoformat(), "verified", True, counts, size)
            except (AirfareRemoteError, OSError, ValueError, KeyError, TypeError) as error:
                phase = self.store.state()["phase"]
                return RetentionReport(
                    run_id,
                    cutoff.isoformat(),
                    phase,
                    False,
                    counts,
                    size,
                    error=type(error).__name__
                    + (": " + str(error)[:240] if not isinstance(error, OSError) else ""),
                )
