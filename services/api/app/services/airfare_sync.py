"""Content-addressed replication of the authoritative, untouched local archive."""

import hashlib
import json
import logging
import os
import re
import sys
import tempfile
import time
import zlib
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from app.services.airfare_baseline_ack import BaselineAcknowledgements
from app.services.airfare_supabase import (
    AirfareRemoteError,
    AirfareRemoteRejected,
    AirfareRemoteUnavailable,
    SupabaseAirfare,
)
from app.services.fare_calendar import _curve_from
from app.services.fare_history import _snapshot_from, route_stem

logger = logging.getLogger(__name__)

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

type SyncMode = Literal["full", "incremental"]
_TABLES = {
    "snapshots": "fare_snapshots",
    "baseline": "fare_baseline_points",
    "calendar": "fare_calendar_captures",
    "board_checks": "fare_checks",
    "calendar_checks": "fare_checks",
    "airports": "fare_airports",
    "documents": "airfare_documents",
}
_PROJECTION_TIMEOUT_SECONDS = 65.0
_MANIFEST_TIMEOUT_SECONDS = 35.0
_FINALIZATION_RETRY_DELAYS = (1.0, 2.0)
_KINDS = {
    "snapshots": "snapshot",
    "baseline": "baseline",
    "calendar": "calendar",
    "board_checks": "board_check",
    "calendar_checks": "calendar_check",
}
_JOURNALS = {
    "snapshots": "fares",
    "baseline": "fares/baseline",
    "calendar": "fares/calendar",
    "board_checks": "fares/checks",
    "calendar_checks": "fares/calendar/checks",
}
_HEX = re.compile(r"^[0-9a-f]{64}$")


@contextmanager
def _exclusive_process_lock(path: Path) -> Iterator[None]:
    """Serialize replica scans and writes across API and CLI processes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        if sys.platform == "win32":
            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    time.sleep(0.05)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@dataclass(frozen=True, slots=True)
class CountDigest:
    records: int
    digest: str


@dataclass(frozen=True, slots=True)
class DatasetManifest:
    physical_valid: int
    logical_unique: int
    skipped: int
    digest: str
    by_route: dict[str, CountDigest]


@dataclass(frozen=True, slots=True)
class SourceManifest:
    snapshots: DatasetManifest
    baseline: DatasetManifest
    calendar: DatasetManifest
    board_checks: DatasetManifest
    calendar_checks: DatasetManifest
    airports: DatasetManifest
    documents: DatasetManifest


@dataclass(frozen=True, slots=True)
class DestinationManifest:
    snapshots: CountDigest
    baseline: CountDigest
    calendar: CountDigest
    board_checks: CountDigest
    calendar_checks: CountDigest
    airports: CountDigest
    documents: CountDigest


@dataclass(frozen=True, slots=True)
class SyncReport:
    mode: SyncMode
    status: Literal["complete", "failed"]
    source: SourceManifest
    uploaded: dict[str, int]
    error: str | None


@dataclass(frozen=True, slots=True)
class VerificationReport:
    matches: bool
    source: SourceManifest
    destination: DestinationManifest
    mismatches: tuple[str, ...]


def canonical_record_id(kind: str, origin: str, destination: str, row: Mapping[str, object]) -> str:
    body = json.dumps(
        row, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )
    route = f"{origin.upper()}-{destination.upper()}"
    return hashlib.sha256(f"{kind}\n{route}\n{body}".encode()).hexdigest()


def _digest(ids: Sequence[str]) -> CountDigest:
    unique = sorted(set(ids))
    return CountDigest(len(unique), hashlib.sha256("\n".join(unique).encode()).hexdigest())


@dataclass
class _Dataset:
    rows: dict[str, dict[str, Any]] = field(default_factory=dict)
    routes: dict[str, list[str]] = field(default_factory=dict)
    physical: int = 0
    skipped: int = 0

    def add(self, identity: str, row: dict[str, Any], route: str = "") -> None:
        self.physical += 1
        self.rows[identity] = row
        if route:
            self.routes.setdefault(route, []).append(identity)

    def manifest(self) -> DatasetManifest:
        digest = _digest(list(self.rows))
        return DatasetManifest(
            self.physical,
            digest.records,
            self.skipped,
            digest.digest,
            {route: _digest(ids) for route, ids in sorted(self.routes.items())},
        )


@dataclass
class _Journal:
    path: Path
    dataset: str
    content: bytes
    stat: os.stat_result
    # Successful records carry their physical line-end offset. Blank/bad lines
    # are acknowledged only alongside the preceding successful batch.
    entries: list[tuple[int, str]]
    end: int
    base_offset: int = 0
    positions: list[tuple[str, str, str, int]] = field(default_factory=list)
    read_bytes: int = 0
    prefix_crc32: int = 0


def _window_digest(handle: Any, offset: int) -> str:
    """Fingerprint the boundary of an append-only journal without reading its history."""
    handle.seek(max(0, offset - 4096))
    return hashlib.sha256(handle.read(min(offset, 4096))).hexdigest()


def _json(content: bytes) -> Any:
    return json.loads(content.decode("utf-8"), parse_constant=_invalid_constant)


def _invalid_constant(value: str) -> Any:
    raise ValueError("nonfinite JSON number")


def _record(dataset: str, route: str, row: dict[str, Any], line: int) -> dict[str, Any] | None:
    origin, destination = route.split("-")
    wire = json.dumps(row, ensure_ascii=False, allow_nan=False)
    result: dict[str, Any] = {
        "record_id": canonical_record_id(_KINDS[dataset], origin, destination, row),
        "origin": origin,
        "destination": destination,
        "payload": row,
    }
    if dataset == "snapshots":
        snapshot = _snapshot_from(wire)
        if snapshot is None:
            return None
        prices = [offer.price for offer in snapshot.offers if offer.price is not None]
        result.update(
            flight_date=snapshot.flight_date,
            captured_at=snapshot.captured_at,
            captured_at_text=snapshot.captured_at,
            source_line=line,
            source=snapshot.source,
            currency=snapshot.currency,
            cheapest_price=min(prices, default=None),
        )
    elif dataset == "calendar":
        curve = _curve_from(wire)
        if curve is None:
            return None
        result.update(
            captured_at=curve.captured_at,
            source_line=line,
            from_date=curve.start,
            to_date=curve.end,
            source=curve.source,
            currency=curve.currency,
        )
    elif dataset == "baseline":
        price = row.get("price")
        if isinstance(price, bool) or not isinstance(price, int | float | str):
            return None
        result.update(
            flight_date=str(row["flightDate"]),
            price_date=str(row["date"]),
            price=float(price),
            source=str(row["source"]),
            currency=str(row["currency"]),
        )
    else:
        result.update(
            kind="board" if dataset == "board_checks" else "calendar",
            flight_date=str(row["flightDate"]) if dataset == "board_checks" else None,
            checked_at=str(row["at"]),
            outcome=str(row["outcome"]),
            offers=int(row.get("offers" if dataset == "board_checks" else "dates", 0)),
            cheapest=row.get("cheapest"),
            error_code=row.get("errorCode"),
        )
    # Fail before sending malformed typed columns; never mutate the source payload.
    for key in ("flight_date", "price_date", "from_date", "to_date"):
        if result.get(key) is not None:
            date.fromisoformat(result[key])
    for key in ("captured_at", "checked_at"):
        if key in result:
            datetime.fromisoformat(result[key])
    json.dumps(result, allow_nan=False)
    return result


class AirfareSync:
    def __init__(
        self, source_root: Path, remote: SupabaseAirfare | None = None, *, batch_size: int = 250
    ):
        if isinstance(batch_size, bool) or not 1 <= batch_size <= 500:
            raise ValueError("Airfare sync batch size must be between 1 and 500")
        self.source_root = source_root.resolve()
        self.remote = remote
        self.batch_size = batch_size
        self.cursor_path = self.source_root / "fares/sync/cursors.json"
        self.route_index_dir = self.source_root / "fares/sync/route-index"
        self.process_lock_path = self.source_root / "fares/sync/replica.lock"

    def _route_index_path(self, route: str) -> Path:
        return self.route_index_dir / f"{route}.json"

    def _read_route_index(self, route: str) -> dict[str, Any] | None:
        try:
            wrapper = _json(self._route_index_path(route).read_bytes())
            payload = wrapper["payload"]
            encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
            if wrapper["digest"] != hashlib.sha256(encoded).hexdigest() or payload["version"] != 1:
                return None
            return payload if isinstance(payload, dict) else None
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _write_route_index(self, route: str, payload: dict[str, Any]) -> None:
        self.route_index_dir.mkdir(parents=True, exist_ok=True)
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        wrapper = {"payload": payload, "digest": hashlib.sha256(encoded).hexdigest()}
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.route_index_dir, suffix=".tmp", delete=False
        ) as handle:
            temporary = Path(handle.name)
            json.dump(wrapper, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self._route_index_path(route))

    def _index_from_scan(
        self, route: str, datasets: dict[str, _Dataset], journals: list[_Journal]
    ) -> dict[str, Any]:
        files = {}
        for journal in journals:
            relative = journal.path.relative_to(self.source_root).as_posix()
            files[relative] = {
                "offset": journal.end,
                "size": journal.stat.st_size,
                "inode": journal.stat.st_ino,
                "mtime_ns": journal.stat.st_mtime_ns,
                "lines": journal.content[: journal.end].count(b"\n"),
                "window": hashlib.sha256(
                    journal.content[max(0, journal.end - 4096) : journal.end]
                ).hexdigest(),
                "crc32": zlib.crc32(journal.content[: journal.end]),
            }
        return {
            "version": 1,
            "files": files,
            "datasets": {
                name: {
                    "ids": list(datasets[name].rows),
                    "physical": datasets[name].physical,
                    "skipped": datasets[name].skipped,
                }
                for name in _JOURNALS
            },
            "baseline_keys": {
                f"{row['flight_date']}|{row['price_date']}": identity
                for identity, row in datasets["baseline"].rows.items()
            },
            "positions": [list(position) for journal in journals for position in journal.positions],
            "cursors": {},
        }

    @staticmethod
    def _index_manifest(index: dict[str, Any], route: str) -> SourceManifest:
        empty = _Dataset().manifest()
        manifests = {}
        for name in _JOURNALS:
            dataset = index["datasets"][name]
            digest = _digest(dataset["ids"])
            manifests[name] = DatasetManifest(
                dataset["physical"],
                digest.records,
                dataset["skipped"],
                digest.digest,
                {route: digest} if digest.records else {},
            )
        return SourceManifest(**manifests, airports=empty, documents=empty)

    def _collect_manual_delta(
        self, route: str, cursors: dict[str, Any], client: SupabaseAirfare | None
    ) -> tuple[dict[str, _Dataset], list[_Journal], dict[str, Any]] | None:
        index = self._read_route_index(route)
        if index is None:
            return None
        paths = [
            path
            for directory in _JOURNALS.values()
            for path in sorted((self.source_root / directory).glob("*.jsonl"))
            if route_stem(*path.stem.partition("-")[::2]) == route
        ]
        relatives = {path.relative_to(self.source_root).as_posix() for path in paths}
        try:
            if relatives != set(index["files"]):
                return None
            if any(
                cursors.get(relative) != index["cursors"].get(relative) for relative in relatives
            ):
                return None
            for relative in relatives:
                if (
                    relative.startswith("fares/baseline/")
                    and client is not None
                    and client.replica_id
                ):
                    checkpoint = BaselineAcknowledgements(
                        self.source_root / "fares/sync/baseline-ack" / f"{route}.json",
                        replica_id=client.replica_id,
                        writer_cursor=self._baseline_writer_cursor(route, cursors),
                    )
                    if not checkpoint.valid:
                        return None
            datasets = {name: _Dataset() for name in _TABLES}
            journals = []
            positions = {tuple(item) for item in index["positions"]}
            baseline_keys = index["baseline_keys"]
            for path in paths:
                relative = path.relative_to(self.source_root).as_posix()
                meta = index["files"][relative]
                name = next(
                    name
                    for name, directory in _JOURNALS.items()
                    if relative.startswith(directory + "/")
                    and relative[len(directory) + 1 :].count("/") == 0
                )
                with path.open("rb") as handle:
                    stat = os.fstat(handle.fileno())
                    offset = meta["offset"]
                    prefix_crc32 = meta["crc32"]
                    if (
                        stat.st_ino != meta["inode"]
                        or stat.st_size < meta["size"]
                        or (stat.st_size == meta["size"] and stat.st_mtime_ns != meta["mtime_ns"])
                        or _window_digest(handle, offset) != meta["window"]
                    ):
                        return None
                    handle.seek(offset)
                    content = handle.read(stat.st_size - offset)
                end = offset + content.rfind(b"\n") + 1
                line_offset = offset
                entries = []
                journal_positions = []
                skipped = 0
                for line, raw in enumerate(content.split(b"\n")[:-1], meta["lines"] + 1):
                    line_offset += len(raw) + 1
                    if not raw.strip():
                        continue
                    try:
                        row = _json(raw)
                        record = _record(name, route, row, line) if isinstance(row, dict) else None
                    except (ValueError, KeyError, TypeError, OverflowError):
                        record = None
                    if record is None:
                        datasets[name].skipped += 1
                        skipped += 1
                        continue
                    if name in {"snapshots", "calendar"}:
                        position = (name, route, str(row["capturedAt"]), line)
                        if position in positions:
                            raise ValueError("ambiguous airfare source observation position")
                        positions.add(position)
                        index["positions"].append(list(position))
                        journal_positions.append(position)
                    identity = record["record_id"]
                    if name == "baseline":
                        key = f"{record['flight_date']}|{record['price_date']}"
                        if key in baseline_keys and baseline_keys[key] != identity:
                            raise ValueError("ambiguous airfare baseline natural key")
                        baseline_keys[key] = identity
                    datasets[name].add(identity, record, route)
                    entries.append((line_offset, identity))
                data = index["datasets"][name]
                data["ids"].extend(identity for _, identity in entries)
                data["physical"] += len(entries)
                data["skipped"] += skipped
                meta["crc32"] = zlib.crc32(content[: end - offset], prefix_crc32)
                meta.update(
                    offset=end,
                    size=stat.st_size,
                    inode=stat.st_ino,
                    mtime_ns=stat.st_mtime_ns,
                    lines=meta["lines"] + content[: end - offset].count(b"\n"),
                )
                with path.open("rb") as handle:
                    meta["window"] = _window_digest(handle, end)
                journals.append(
                    _Journal(
                        path,
                        name,
                        content,
                        stat,
                        entries,
                        end,
                        offset,
                        journal_positions,
                        len(content) + min(offset, 4096) + min(end, 4096),
                        prefix_crc32,
                    )
                )
            return datasets, journals, index
        except (KeyError, TypeError, IndexError, OSError, StopIteration):
            return None

    def _collect(
        self, *, route_scope: str | None = None
    ) -> tuple[dict[str, _Dataset], list[_Journal]]:
        datasets = {name: _Dataset() for name in _TABLES}
        journals = []
        positions: set[tuple[str, str, str, int]] = set()
        baseline_keys: dict[tuple[str, str, str], str] = {}
        for name, directory in _JOURNALS.items():
            for path in sorted((self.source_root / directory).glob("*.jsonl")):
                origin, separator, destination = path.stem.partition("-")
                route = route_stem(origin, destination)
                if route_scope is not None and route != route_scope:
                    continue
                if not separator or not re.fullmatch(r"[A-Z0-9]{3}-[A-Z0-9]{3}", route):
                    raise ValueError("invalid airfare source route filename")
                with path.open("rb") as handle:
                    stat = os.fstat(handle.fileno())
                    content = handle.read(stat.st_size)
                entries = []
                journal_positions = []
                offset = 0
                for line, raw in enumerate(content.split(b"\n")[:-1], 1):
                    offset += len(raw) + 1
                    if not raw.strip():
                        continue
                    try:
                        row = _json(raw)
                        record = _record(name, route, row, line) if isinstance(row, dict) else None
                    except (ValueError, KeyError, TypeError, OverflowError):
                        record = None
                    if record is None:
                        datasets[name].skipped += 1
                        continue
                    if name in {"snapshots", "calendar"}:
                        position = (name, route, str(row["capturedAt"]), line)
                        if position in positions:
                            raise ValueError("ambiguous airfare source observation position")
                        positions.add(position)
                        journal_positions.append(position)
                    identity = record["record_id"]
                    if name == "baseline":
                        baseline_key = (route, record["flight_date"], record["price_date"])
                        if (
                            baseline_key in baseline_keys
                            and baseline_keys[baseline_key] != identity
                        ):
                            raise ValueError("ambiguous airfare baseline natural key")
                        baseline_keys[baseline_key] = identity
                    datasets[name].add(identity, record, route)
                    entries.append((offset, identity))
                journals.append(
                    _Journal(
                        path,
                        name,
                        content,
                        stat,
                        entries,
                        content.rfind(b"\n") + 1,
                        0,
                        journal_positions,
                    )
                )
        if route_scope is not None:
            return datasets, journals
        airports = self.source_root / "fares/airports.json"
        if airports.exists():
            try:
                rows = _json(airports.read_bytes())
            except ValueError:
                rows = None
            if not isinstance(rows, dict):
                datasets["airports"].skipped += 1
            else:
                for code, row in rows.items():
                    if (
                        not isinstance(row, dict)
                        or not re.fullmatch(r"[A-Z0-9]{3}", code)
                        or not isinstance(row.get("latitude"), int | float)
                        or not isinstance(row.get("longitude"), int | float)
                        or not -90 <= row["latitude"] <= 90
                        or not -180 <= row["longitude"] <= 180
                    ):
                        datasets["airports"].skipped += 1
                        continue
                    identity = canonical_record_id("airport", code, "", row)
                    datasets["airports"].add(
                        identity,
                        {
                            "code": code,
                            "payload": row,
                            **{
                                key: row.get(key)
                                for key in ("name", "city", "country", "latitude", "longitude")
                            },
                        },
                    )
        document = self.source_root / "kv/airfare-routes.json"
        if document.exists():
            with document.open("rb") as handle:
                stamp = os.fstat(handle.fileno()).st_mtime
                try:
                    value = _json(handle.read())
                except ValueError:
                    datasets["documents"].skipped += 1
                else:
                    identity = canonical_record_id(
                        "document", "", "", {"key": "airfare-routes", "value": value}
                    )
                    datasets["documents"].add(
                        identity,
                        {
                            "key": "airfare-routes",
                            "value": value,
                            "source_updated_at": datetime.fromtimestamp(stamp, UTC).isoformat(),
                        },
                    )
        return datasets, journals

    def source_directories(self) -> tuple[Path, ...]:
        """Authoritative scan roots, including currently empty nested journals."""
        return tuple(self.source_root / directory for directory in (*_JOURNALS.values(), "kv"))

    def source_files(self) -> tuple[Path, ...]:
        """Every authoritative file a scan can consume, including path aliases."""
        files = [
            path
            for directory in _JOURNALS.values()
            for path in sorted((self.source_root / directory).glob("*.jsonl"))
        ]
        files.extend(
            path
            for path in (
                self.source_root / "fares/airports.json",
                self.source_root / "kv/airfare-routes.json",
            )
            if os.path.lexists(path)
        )
        return tuple(files)

    def logical_records(self) -> dict[str, list[dict[str, Any]]]:
        """Original content identities and final source positions for read parity."""
        datasets, _ = self._collect()
        return {name: list(dataset.rows.values()) for name, dataset in datasets.items()}

    @staticmethod
    def _manifest(datasets: dict[str, _Dataset]) -> SourceManifest:
        return SourceManifest(**{name: data.manifest() for name, data in datasets.items()})

    def scan(self, mode: SyncMode = "full") -> SourceManifest:
        """Whole-source manifests are comparable regardless of upload cursor mode."""
        self._check_mode(mode)
        return self._manifest(self._collect()[0])

    @staticmethod
    def _check_mode(mode: SyncMode) -> None:
        if mode not in {"full", "incremental"}:
            raise ValueError("invalid airfare sync mode")

    def _client(self) -> SupabaseAirfare:
        if self.remote is None:
            raise ValueError("Supabase must be configured for this operation")
        return self.remote

    def _cursors(self) -> dict[str, Any]:
        try:
            value = _json(self.cursor_path.read_bytes())
        except (OSError, ValueError):
            return {}
        return value if isinstance(value, dict) else {}

    def _start(self, journal: _Journal, cursors: dict[str, Any], mode: SyncMode) -> int:
        cursor = cursors.get(journal.path.relative_to(self.source_root).as_posix(), {})
        if mode == "full" or not isinstance(cursor, dict):
            return 0
        if journal.base_offset and cursor.get("offset") == journal.base_offset:
            return journal.base_offset
        offset = cursor.get("offset", 0)
        previous_size = cursor.get("size")
        if (
            not isinstance(offset, int)
            or not isinstance(previous_size, int)
            or journal.stat.st_size < previous_size
            or offset <= 0
            or offset > journal.end
            or journal.content[offset - 1 : offset] != b"\n"
            or cursor.get("inode") != journal.stat.st_ino
            or (
                (
                    cursor.get("window_digest")
                    != hashlib.sha256(journal.content[max(0, offset - 4096) : offset]).hexdigest()
                    or cursor.get("prefix_crc32") != zlib.crc32(journal.content[:offset])
                )
                if "window_digest" in cursor
                else cursor.get("prefix_digest")
                != hashlib.sha256(journal.content[:offset]).hexdigest()
            )
        ):
            return 0
        return offset

    def _acknowledge(
        self, journal: _Journal, end: int, cursors: dict[str, Any], *, baseline_ack: bool = False
    ) -> None:
        relative = journal.path.relative_to(self.source_root).as_posix()
        cursors[relative] = {
            "path": relative,
            "offset": end,
            "size": journal.stat.st_size,
            "mtime_ns": journal.stat.st_mtime_ns,
            "inode": journal.stat.st_ino,
        }
        if journal.base_offset:
            with journal.path.open("rb") as handle:
                cursors[relative]["window_digest"] = _window_digest(handle, end)
            cursors[relative]["prefix_crc32"] = zlib.crc32(
                journal.content[: end - journal.base_offset], journal.prefix_crc32
            )
        else:
            cursors[relative]["prefix_digest"] = hashlib.sha256(journal.content[:end]).hexdigest()
        if baseline_ack:
            # Legacy importers replace the entire entry and drop this marker,
            # even when they eventually restore identical source metadata.
            cursors[relative]["baseline_ack_version"] = 2
        self.cursor_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.cursor_path.parent, suffix=".tmp", delete=False
        ) as handle:
            temporary = Path(handle.name)
            json.dump(cursors, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.replace(temporary, self.cursor_path)
        finally:
            temporary.unlink(missing_ok=True)

    def apply(
        self,
        mode: SyncMode = "incremental",
        *,
        collect_destination_manifest: bool = True,
        projection_routes: frozenset[tuple[str, str]] | None = None,
    ) -> SyncReport:
        self._check_mode(mode)
        if not isinstance(collect_destination_manifest, bool):
            raise ValueError("invalid destination manifest option")
        if projection_routes is not None and (
            not isinstance(projection_routes, frozenset)
            or not projection_routes
            or any(
                not isinstance(route, tuple)
                or len(route) != 2
                or any(
                    not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9]{3}", code)
                    for code in route
                )
                for route in projection_routes
            )
        ):
            raise ValueError("invalid Airfare projection routes")
        lock_started = time.perf_counter()
        with _exclusive_process_lock(self.process_lock_path):
            logger.info(
                "Airfare sync lock acquired mode=%s wait_ms=%d",
                mode,
                round((time.perf_counter() - lock_started) * 1000),
            )
            return self._apply_locked(mode, collect_destination_manifest, projection_routes)

    def apply_manual_route(
        self,
        origin: str,
        destination: str,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> SyncReport:
        """Publish one validated route; global reconciliation handles other journals."""
        if (
            any(
                not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9]{3}", code)
                for code in (origin, destination)
            )
            or origin == destination
        ):
            raise ValueError("invalid Airfare manual route")
        route = (origin, destination)
        lock_started = time.perf_counter()
        with _exclusive_process_lock(self.process_lock_path):
            logger.info(
                "Airfare manual sync lock acquired route=%s-%s wait_ms=%d",
                origin,
                destination,
                round((time.perf_counter() - lock_started) * 1000),
            )
            return self._apply_locked(
                "incremental",
                False,
                frozenset({route}),
                source_route=route,
                on_progress=on_progress,
            )

    def _apply_locked(
        self,
        mode: SyncMode,
        collect_destination_manifest: bool,
        projection_routes: frozenset[tuple[str, str]] | None,
        *,
        source_route: tuple[str, str] | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> SyncReport:
        client = self._client()
        run_id = str(uuid4())
        scan_started = time.perf_counter()
        cursors = self._cursors()
        route_index = None
        if source_route is not None:
            route = "-".join(source_route)
            collected = self._collect_manual_delta(route, cursors, client)
            if collected is None:
                datasets, journals = self._collect(route_scope=route)
                route_index = self._index_from_scan(route, datasets, journals)
            else:
                datasets, journals, route_index = collected
            source = self._index_manifest(route_index, route)
        else:
            datasets, journals = self._collect()
            source = self._manifest(datasets)
        logger.info(
            "Airfare sync scan run_id=%s scope=%s journals=%d bytes=%d rows=%d scan_ms=%d",
            run_id,
            "-".join(source_route) if source_route is not None else "global",
            len(journals),
            sum(journal.read_bytes or len(journal.content) for journal in journals),
            sum(data.physical + data.skipped for data in datasets.values()),
            round((time.perf_counter() - scan_started) * 1000),
        )
        source_manifest = (
            {
                "scope": {
                    "kind": "route",
                    "origin": source_route[0],
                    "destination": source_route[1],
                },
                "datasets": {name: asdict(getattr(source, name)) for name in _JOURNALS},
            }
            if source_route is not None
            else asdict(source)
        )
        uploaded = dict.fromkeys(_TABLES, 0)
        # The run record, each scanned journal, the two metadata datasets, and
        # final projection/index work are observable sync units. The final unit
        # is acknowledged only after all writes have succeeded.
        sync_total = len(journals) + 4
        sync_completed = 0

        def advance() -> None:
            nonlocal sync_completed
            sync_completed += 1
            if on_progress is not None:
                on_progress(sync_completed, sync_total)

        if on_progress is not None:
            on_progress(0, sync_total)
        run: dict[str, Any] = {
            "run_id": run_id,
            "mode": mode,
            "started_at": datetime.now(UTC).isoformat(),
            "status": "running",
            "source_manifest": source_manifest,
            "destination_manifest": {},
            "error": None,
        }
        error = None
        try:
            upload_started = time.perf_counter()
            client.upsert("airfare_import_runs", [run], on_conflict="run_id")
            advance()
            for journal in journals:
                if journal.dataset == "baseline" and getattr(client, "replica_id", None):
                    self._upload_baseline(
                        journal, datasets["baseline"], client, mode, cursors, uploaded
                    )
                    advance()
                    continue
                start = self._start(journal, cursors, mode)
                # Select the last physical occurrence per content ID: calendar
                # duplicates at a later position must still win equal-time ties.
                pending = {identity: end for end, identity in journal.entries if end > start}
                ordered = sorted(pending, key=lambda identity: pending[identity])
                for index in range(0, len(ordered), self.batch_size):
                    ids = ordered[index : index + self.batch_size]
                    client.upsert(
                        _TABLES[journal.dataset],
                        [datasets[journal.dataset].rows[identity] for identity in ids],
                        on_conflict="origin,destination,flight_date,price_date"
                        if journal.dataset == "baseline"
                        else "record_id",
                    )
                    uploaded[journal.dataset] += len(ids)
                    self._acknowledge(journal, pending[ids[-1]], cursors)
                if journal.end > start:
                    self._acknowledge(journal, journal.end, cursors)
                advance()
            for name, key in (("airports", "code"), ("documents", "key")):
                rows = list(datasets[name].rows.values())
                for index in range(0, len(rows), self.batch_size):
                    batch = rows[index : index + self.batch_size]
                    client.upsert(_TABLES[name], batch, on_conflict=key)
                    uploaded[name] += len(batch)
                advance()
            logger.info(
                "Airfare sync upload run_id=%s rows=%s upload_ms=%d",
                run_id,
                uploaded,
                round((time.perf_counter() - upload_started) * 1000),
            )
            self._finish_run(client, run, collect_destination_manifest, projection_routes)
            if route_index is not None and source_route is not None:
                route_index["cursors"] = {
                    relative: cursors.get(relative) for relative in route_index["files"]
                }
                self._write_route_index("-".join(source_route), route_index)
            advance()
        except (AirfareRemoteError, OSError) as failure:
            # Remote errors are sanitized by the HTTP boundary. Filesystem
            # messages may contain private paths, so log only their type.
            logger.warning(
                "Airfare synchronization failed: %s",
                failure if isinstance(failure, AirfareRemoteError) else type(failure).__name__,
            )
            error = "Airfare synchronization failed; retry with the retained source journals"
            run.update(status="failed", completed_at=datetime.now(UTC).isoformat(), error=error)
            try:
                client.upsert("airfare_import_runs", [run], on_conflict="run_id")
            except AirfareRemoteError:
                error += "; import-run status could not be recorded"
        return SyncReport(mode, "failed" if error else "complete", source, uploaded, error)

    def _finish_run(
        self,
        client: SupabaseAirfare,
        run: dict[str, Any],
        collect_destination_manifest: bool,
        projection_routes: frozenset[tuple[str, str]] | None,
    ) -> None:
        """Retry idempotent finalization without repeating uploads or local ACKs.

        Failed projection transactions retain their dirty rows. Manifest reads
        and final writes to the same run ID are safe after a lost response too.
        Every manual retry keeps its explicit route and omits the global read.
        """
        for attempt in range(len(_FINALIZATION_RETRY_DELAYS) + 1):
            try:
                projection_started = time.perf_counter()
                try:
                    self._refresh_projections(client, projection_routes)
                finally:
                    logger.info(
                        "Airfare sync projection run_id=%s attempt=%d projection_ms=%d",
                        run["run_id"],
                        attempt + 1,
                        round((time.perf_counter() - projection_started) * 1000),
                    )
                manifest_started = time.perf_counter()
                try:
                    manifest = self._remote_groups() if collect_destination_manifest else {}
                finally:
                    logger.info(
                        "Airfare sync manifest run_id=%s attempt=%d collected=%s manifest_ms=%d",
                        run["run_id"],
                        attempt + 1,
                        collect_destination_manifest,
                        round((time.perf_counter() - manifest_started) * 1000),
                    )
                run.update(
                    status="complete",
                    completed_at=datetime.now(UTC).isoformat(),
                    destination_manifest=manifest,
                )
                finish_started = time.perf_counter()
                try:
                    client.upsert("airfare_import_runs", [run], on_conflict="run_id")
                finally:
                    logger.info(
                        "Airfare sync final write run_id=%s attempt=%d write_ms=%d",
                        run["run_id"],
                        attempt + 1,
                        round((time.perf_counter() - finish_started) * 1000),
                    )
                return
            except AirfareRemoteUnavailable as error:
                if attempt == len(_FINALIZATION_RETRY_DELAYS):
                    raise
                delay = _FINALIZATION_RETRY_DELAYS[attempt]
                logger.warning(
                    "Airfare finalization attempt %d failed; retrying in %.1fs: %s",
                    attempt + 1,
                    delay,
                    error,
                )
                time.sleep(delay)

    def _upload_baseline(
        self,
        journal: _Journal,
        dataset: _Dataset,
        client: SupabaseAirfare,
        mode: SyncMode,
        cursors: dict[str, Any],
        uploaded: dict[str, int],
    ) -> None:
        origin, _, destination = journal.path.stem.partition("-")
        route = route_stem(origin, destination)
        last_acknowledged = self._start(journal, cursors, mode)
        checkpoint = BaselineAcknowledgements(
            self.source_root / "fares/sync/baseline-ack" / f"{route}.json",
            replica_id=client.replica_id,
            writer_cursor=self._baseline_writer_cursor(route, cursors),
        )
        latest: dict[tuple[str, str], tuple[int, str]] = {}
        for end, identity in journal.entries:
            row = dataset.rows[identity]
            latest[(row["flight_date"], row["price_date"])] = (end, identity)
        needed = (
            set(latest)
            if mode == "full"
            else checkpoint.needed({key: identity for key, (_, identity) in latest.items()})
        )
        pending = sorted(
            ((end, key, identity) for key, (end, identity) in latest.items() if key in needed),
            key=lambda item: item[0],
        )
        if pending:
            checkpoint.pending(key for _, key, _ in pending)
        for index in range(0, len(pending), self.batch_size):
            batch = pending[index : index + self.batch_size]
            client.upsert(
                _TABLES["baseline"],
                [dataset.rows[identity] for _, _, identity in batch],
                on_conflict="origin,destination,flight_date,price_date",
            )
            end = journal.end if index + self.batch_size >= len(pending) else batch[-1][0]
            self._acknowledge(journal, end, cursors, baseline_ack=True)
            checkpoint.confirm(
                {key: identity for _, key, identity in batch},
                writer_cursor=self._baseline_writer_cursor(route, cursors),
            )
            uploaded["baseline"] += len(batch)
            last_acknowledged = end
        if journal.end > last_acknowledged:
            self._acknowledge(journal, journal.end, cursors, baseline_ack=True)
            checkpoint.confirm({}, writer_cursor=self._baseline_writer_cursor(route, cursors))

    @staticmethod
    def _baseline_writer_cursor(route: str, cursors: dict[str, Any]) -> str:
        """Include current and removed aliases so legacy writes cannot hide."""
        entries = {}
        for relative, cursor in cursors.items():
            prefix = "fares/baseline/"
            if not relative.startswith(prefix):
                continue
            name = relative.removeprefix(prefix)
            if "/" in name or not name.endswith(".jsonl"):
                continue
            origin, _, destination = name.removesuffix(".jsonl").partition("-")
            if route_stem(origin, destination) == route:
                entries[relative] = cursor
        content = json.dumps(entries, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    def _refresh_projections(
        self,
        client: SupabaseAirfare,
        projection_routes: frozenset[tuple[str, str]] | None = None,
    ) -> None:
        """Drain DB-owned dirty routes after all source batches have arrived.

        A failed refresh leaves its dirty row in Postgres, so the next ordinary
        synchronization retries even when its source cursors have advanced.
        """
        routes = (
            [
                {"origin": origin, "destination": destination}
                for origin, destination in sorted(projection_routes)
            ]
            if projection_routes is not None
            else client.rpc("list_fare_projection_dirty_routes", {})
        )
        if not isinstance(routes, list):
            raise AirfareRemoteRejected("Invalid dirty Airfare projection list")
        for route in routes:
            if (
                not isinstance(route, dict)
                or set(route) != {"origin", "destination"}
                or not isinstance(route["origin"], str)
                or not isinstance(route["destination"], str)
                or not re.fullmatch(r"[A-Z0-9]{3}", route["origin"])
                or not re.fullmatch(r"[A-Z0-9]{3}", route["destination"])
            ):
                raise AirfareRemoteRejected("Invalid dirty Airfare projection route")
            try:
                count = client.rpc(
                    "refresh_fare_route_projection",
                    {"p_origin": route["origin"], "p_destination": route["destination"]},
                    timeout_seconds=_PROJECTION_TIMEOUT_SECONDS,
                )
            except AirfareRemoteError as error:
                logger.warning(
                    "Airfare projection refresh failed for %s-%s: %s",
                    route["origin"],
                    route["destination"],
                    error,
                )
                raise
            if not isinstance(count, int) or count < 0:
                raise AirfareRemoteRejected("Invalid Airfare projection refresh result")

    def _remote_groups(self) -> list[dict[str, Any]]:
        groups = self._client().rpc(
            "airfare_dataset_manifest", {}, timeout_seconds=_MANIFEST_TIMEOUT_SECONDS
        )
        if not isinstance(groups, list):
            raise AirfareRemoteRejected("Supabase returned an invalid manifest")
        cleaned = []
        seen: set[tuple[str, str]] = set()
        for group in groups:
            if (
                not isinstance(group, dict)
                or group.get("dataset") not in _KINDS
                or not isinstance(group.get("route"), str)
                or not re.fullmatch(r"[A-Z0-9]{3}-[A-Z0-9]{3}", group["route"])
                or not isinstance(group.get("count"), int)
                or group["count"] <= 0
                or not isinstance(group.get("digest"), str)
                or not _HEX.fullmatch(group["digest"])
            ):
                raise AirfareRemoteRejected("Supabase returned an invalid manifest group")
            key = (group["dataset"], group["route"])
            if key in seen:
                raise AirfareRemoteRejected("Supabase returned duplicate manifest groups")
            seen.add(key)
            cleaned.append({name: group[name] for name in ("dataset", "route", "count", "digest")})
        return sorted(cleaned, key=lambda group: (group["dataset"], group["route"]))

    def verify(self, source: SourceManifest) -> VerificationReport:
        client = self._client()
        remote_routes = {
            (group["dataset"], group["route"]): CountDigest(group["count"], group["digest"])
            for group in self._remote_groups()
        }
        ids: dict[str, list[str]] = {name: [] for name in _TABLES}
        for name in ("snapshots", "baseline", "calendar"):
            ids[name] = [
                row["record_id"]
                for row in client.select_all(_TABLES[name], ("record_id",), key="record_id")
            ]
        for row in client.select_all("fare_checks", ("record_id", "kind"), key="record_id"):
            if row["kind"] not in {"board", "calendar"}:
                raise AirfareRemoteRejected("Supabase returned an invalid check kind")
            ids[row["kind"] + "_checks"].append(row["record_id"])
        for row in client.select_all("fare_airports", ("code", "payload"), key="code"):
            ids["airports"].append(canonical_record_id("airport", row["code"], "", row["payload"]))
        for row in client.select_all("airfare_documents", ("key", "value"), key="key"):
            ids["documents"].append(canonical_record_id("document", "", "", row))
        destination = DestinationManifest(
            **{name: _digest(records) for name, records in ids.items()}
        )
        mismatches = []
        for name in _TABLES:
            expected = getattr(source, name)
            if CountDigest(expected.logical_unique, expected.digest) != getattr(destination, name):
                mismatches.append(name)
            if name in _KINDS:
                routes = set(expected.by_route) | {
                    route for dataset, route in remote_routes if dataset == name
                }
                for route in sorted(routes):
                    if expected.by_route.get(route) != remote_routes.get((name, route)):
                        mismatches.append(f"{name}:{route}")
                if sum(
                    count.records
                    for (dataset, _), count in remote_routes.items()
                    if dataset == name
                ) != len(ids[name]):
                    mismatches.append(f"{name}:manifest-count")
        return VerificationReport(not mismatches, source, destination, tuple(mismatches))
