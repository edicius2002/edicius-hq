"""Crash-resumable local compaction of departed fare journals."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

from app.services.airfare_retention import DepartureSummary, summarize_departure
from app.services.airfare_sync import _record
from app.services.fare_calendar import FareCalendar

_ROUTE = re.compile(r"[A-Z0-9]{3}")
_FILES = {
    "snapshots": "fares/{route}.jsonl",
    "baseline": "fares/baseline/{route}.jsonl",
    "board_checks": "fares/checks/{route}.jsonl",
    "calendar": "fares/calendar/{route}.jsonl",
}


def _hash(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _fsync_directory(path: Path) -> None:
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _json_bytes(value: object) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
    ).encode("utf-8")


def _distinct_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("invalid fare journal: duplicate JSON key")
        result[key] = value
    return result


def _read_journal(path: Path, dataset: str, route: str) -> tuple[bytes, list[tuple[bytes, dict]]]:
    if path.is_symlink():
        raise ValueError("invalid fare journal: symbolic link")
    if not path.exists():
        return b"", []
    raw = path.read_bytes()
    if raw and not raw.endswith(b"\n"):
        raise ValueError("invalid fare journal: unterminated line")
    rows = []
    for number, line in enumerate(raw.splitlines(keepends=True), 1):
        try:
            body = json.loads(
                line.decode("utf-8"),
                object_pairs_hook=_distinct_object,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")),
            )
            if not isinstance(body, dict) or _record(dataset, route, body, number) is None:
                raise ValueError("invalid fare journal row")
        except (UnicodeError, ValueError, TypeError, KeyError, OverflowError) as exc:
            raise ValueError(f"invalid fare journal: {path.name} line {number}") from exc
        rows.append((line, body))
    return raw, rows


class RetentionStore:
    """The Pi's immutable numeric partitions and restartable source replacements."""

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.fares = self.root / "fares"
        self.retention = self.fares / "retention"

    def _route(self, origin: str, destination: str) -> str:
        if not _ROUTE.fullmatch(origin) or not _ROUTE.fullmatch(destination):
            raise ValueError("invalid fare route")
        return f"{origin}-{destination}"

    def state(self) -> dict[str, Any]:
        path = self.retention / "state.json"
        if not path.exists():
            return {"cutoff": None, "target_cutoff": None, "phase": "verified"}
        body = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(body, dict) or body.get("phase") not in {
            "verified",
            "pending",
            "summarized",
            "compacted",
            "pruned",
        }:
            raise ValueError("invalid fare retention state")
        return body

    def write_state(self, state: dict[str, Any]) -> None:
        _atomic_write(self.retention / "state.json", _json_bytes(state))

    def read_cutoff(self) -> date | None:
        value = self.state().get("cutoff")
        return date.fromisoformat(value) if value is not None else None

    def partition_path(self, origin: str, destination: str, flight_date: date) -> Path:
        return (
            self.retention
            / "partitions"
            / self._route(origin, destination)
            / f"{flight_date.isoformat()}.json"
        )

    def publish(self, summary: DepartureSummary) -> str:
        path = self.partition_path(
            summary.origin, summary.destination, date.fromisoformat(summary.flight_date)
        )
        content = summary.canonical_json().encode("utf-8") + b"\n"
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            if path.read_bytes() != content:
                raise ValueError("fare retention partition conflict")
            return summary.digest
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.link(temporary, path)
            except FileExistsError:
                if path.read_bytes() != content:
                    raise ValueError("fare retention partition conflict") from None
            _fsync_directory(path.parent)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return summary.digest

    def summaries(self, origin: str, destination: str) -> list[DepartureSummary]:
        directory = self.retention / "partitions" / self._route(origin, destination)
        result = []
        for path in sorted(directory.glob("*.json")):
            body = json.loads(path.read_text(encoding="utf-8"))
            summary = DepartureSummary(**body)
            if path.name != f"{summary.flight_date}.json" or summary.key[:2] != (
                origin,
                destination,
            ):
                raise ValueError("invalid fare retention partition")
            if path.read_bytes() != summary.canonical_json().encode("utf-8") + b"\n":
                raise ValueError("invalid fare retention partition digest")
            result.append(summary)
        return result

    def compact_route(self, origin: str, destination: str, cutoff: date) -> dict[str, object]:
        route = self._route(origin, destination)
        if not isinstance(cutoff, date):
            raise ValueError("invalid fare retention cutoff")
        plan_path = self.retention / "plans" / f"{route}.json"
        if plan_path.exists():
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            if plan.get("cutoff") != cutoff.isoformat():
                raise ValueError("fare retention plan cutoff conflict")
        else:
            plan = self._prepare(route, origin, destination, cutoff)
            _atomic_write(plan_path, _json_bytes(plan))
        self._resume(plan, route, cutoff)
        plan_path.unlink()
        _fsync_directory(plan_path.parent)
        return {"route": route, "cutoff": cutoff.isoformat(), "summaries": len(plan["summaries"])}

    def _prepare(self, route: str, origin: str, destination: str, cutoff: date) -> dict:
        sources = {}
        expired: dict[str, dict[str, list[dict]]] = defaultdict(
            lambda: {"snapshots": [], "baseline": [], "board_checks": []}
        )
        replacements = []
        for dataset, template in _FILES.items():
            relative = template.format(route=route)
            path = self.root / relative
            raw, rows = _read_journal(path, dataset, route)
            sources[dataset] = (relative, raw, rows)
        for dataset in ("snapshots", "baseline", "board_checks"):
            relative, raw, rows = sources[dataset]
            kept = []
            for line, body in rows:
                departure = date.fromisoformat(body["flightDate"])
                if departure < cutoff:
                    expired[departure.isoformat()][dataset].append(body)
                else:
                    kept.append(line)
            replacement = b"".join(kept)
            if raw != replacement:
                replacements.append((relative, raw, replacement))
        relative, raw, rows = sources["calendar"]
        transformed = []
        for line, body in rows:
            prices = body["prices"]
            if not isinstance(prices, dict):
                raise ValueError("invalid fare journal: calendar prices")
            if date.fromisoformat(body["from"]) > date.fromisoformat(body["to"]):
                raise ValueError("invalid fare journal: calendar window")
            for key in prices:
                date.fromisoformat(key)
                if not body["from"] <= key <= body["to"]:
                    raise ValueError("invalid fare journal: calendar price outside window")
            if date.fromisoformat(body["to"]) < cutoff:
                continue
            remaining = {
                key: value for key, value in prices.items() if date.fromisoformat(key) >= cutoff
            }
            if len(remaining) == len(prices) and date.fromisoformat(body["from"]) >= cutoff:
                transformed.append(line)
            else:
                rewritten = {
                    **body,
                    "from": max(body["from"], cutoff.isoformat()),
                    "prices": remaining,
                }
                transformed.append(_json_bytes(rewritten))
        replacement = b"".join(transformed)
        if raw != replacement:
            replacements.append((relative, raw, replacement))

        summaries = []
        for departure_text, groups in sorted(expired.items()):
            summary = summarize_departure(
                origin,
                destination,
                date.fromisoformat(departure_text),
                groups["snapshots"],
                groups["baseline"],
                groups["board_checks"],
            )
            self.publish(summary)
            summaries.append({"date": departure_text, "digest": summary.digest})
        files = []
        for index, (relative, old, new) in enumerate(replacements):
            stage = f"fares/retention/staging/{route}/{cutoff.isoformat()}/{index}.jsonl"
            _atomic_write(self.root / stage, new)
            files.append(
                {
                    "path": relative,
                    "stage": stage,
                    "old_sha256": _hash(old),
                    "new_sha256": _hash(new),
                }
            )
        return {
            "version": 1,
            "route": route,
            "cutoff": cutoff.isoformat(),
            "summaries": summaries,
            "files": files,
        }

    def _resume(self, plan: dict, route: str, cutoff: date) -> None:
        if plan.get("version") != 1 or plan.get("route") != route:
            raise ValueError("invalid fare retention plan")
        origin, destination = route.split("-")
        actual_summaries = {
            summary.flight_date: summary.digest for summary in self.summaries(origin, destination)
        }
        for entry in plan["summaries"]:
            if actual_summaries.get(entry["date"]) != entry["digest"]:
                raise ValueError("fare retention partition conflict")
        for index, entry in enumerate(plan["files"]):
            if entry["path"] not in {
                template.format(route=route) for template in _FILES.values()
            } or entry["stage"] != (
                f"fares/retention/staging/{route}/{cutoff.isoformat()}/{index}.jsonl"
            ):
                raise ValueError("invalid fare retention plan path")
            path = self.root / entry["path"]
            stage = self.root / entry["stage"]
            current = _hash(path.read_bytes()) if path.exists() else _hash(b"")
            if current == entry["new_sha256"]:
                stage.unlink(missing_ok=True)
                continue
            if (
                current != entry["old_sha256"]
                or not stage.exists()
                or _hash(stage.read_bytes()) != entry["new_sha256"]
            ):
                raise ValueError("fare retention source changed during compaction")
            path.parent.mkdir(parents=True, exist_ok=True)
            os.replace(stage, path)
            _fsync_directory(path.parent)
        self._reset_derived(route, cutoff, [entry["path"] for entry in plan["files"]])

    def _reset_derived(self, route: str, cutoff: date, changed: list[str]) -> None:
        if not changed:
            return
        for relative in (
            f"fares/sync/route-index/{route}.json",
            f"fares/sync/baseline-ack/{route}.json",
        ):
            (self.root / relative).unlink(missing_ok=True)
        cursor_path = self.root / "fares/sync/cursors.json"
        if cursor_path.exists():
            cursors = json.loads(cursor_path.read_text(encoding="utf-8"))
            if not isinstance(cursors, dict):
                raise ValueError("invalid fare sync cursors")
            for relative in changed:
                cursors.pop(relative, None)
            _atomic_write(cursor_path, _json_bytes(cursors))
        state_path = self.root / f"fares/state/{route}.json"
        if state_path.exists():
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if not isinstance(state, dict):
                raise ValueError("invalid fare board state")
            state = {
                key: value for key, value in state.items() if date.fromisoformat(key) >= cutoff
            }
            _atomic_write(state_path, _json_bytes(state))
        calendar = FareCalendar(self.fares / "calendar")
        latest = calendar.latest(*route.split("-"))
        calendar_state = self.root / f"fares/calendar/state/{route}.json"
        if latest is None:
            calendar_state.unlink(missing_ok=True)
        elif calendar_state.exists():
            _atomic_write(
                calendar_state, _json_bytes({"fingerprint": calendar.fingerprint(latest)})
            )
