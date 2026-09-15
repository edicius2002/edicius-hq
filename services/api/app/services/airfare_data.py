"""One deep seam for Airfare archive reads, imports, and replica synchronization."""

from __future__ import annotations

import logging
import math
import threading
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Literal, NoReturn

from app.adapters.fares.models import Airport, FareInsights, FareOffer, FareSnapshot
from app.config import airfare_data_backend, airfare_supabase_config, local_data_dir
from app.services import airport_coordinates
from app.services.airfare_supabase import (
    AirfareRemoteError,
    AirfareRemoteRejected,
    AirfareRemoteUnavailable,
    SupabaseAirfare,
    configured_airfare_supabase,
)
from app.services.airfare_sync import AirfareSync, DatasetManifest, SourceManifest, SyncReport
from app.services.fare_calendar import CALENDAR, FareCalendar, Horizon, ObservedPrice
from app.services.fare_history import HISTORY, BaselinePoint, FareHistory, route_stem

logger = logging.getLogger(__name__)

_SYNC_LOCK = threading.Lock()
_IMPORT_ROUTE_LOCKS_GUARD = threading.Lock()
_IMPORT_ROUTE_LOCKS: dict[str, threading.Lock] = {}
_SYNC_DATASETS = (
    "snapshots",
    "baseline",
    "calendar",
    "board_checks",
    "calendar_checks",
    "airports",
    "documents",
)
_EMPTY_SYNC_DIGEST = sha256(b"").hexdigest()


@dataclass(frozen=True, slots=True)
class WatchHealth:
    last_checked_at: str | None
    checks: int
    changes: int
    errors: int


@dataclass(frozen=True, slots=True)
class PairReferenceSummary:
    value: float
    dates: int


@dataclass(frozen=True, slots=True)
class HistoryQuery:
    origin: str
    destination: str
    departure: str | None = None
    snapshot_months: tuple[str, ...] = ()
    since: str | None = None
    until: str | None = None


@dataclass(frozen=True, slots=True)
class HistoryRead:
    origin: str
    destination: str
    snapshots: tuple[FareSnapshot, ...]
    baseline: tuple[BaselinePoint, ...]
    health: WatchHealth
    airports: tuple[Airport, ...]
    pair_reference: PairReferenceSummary | None


@dataclass(frozen=True, slots=True)
class CalendarRead:
    origin: str
    destination: str
    horizon: Horizon | None
    health: WatchHealth


@dataclass(frozen=True, slots=True)
class ImportSnapshotsResult:
    """The local authoritative watch-import outcome."""

    imported: int
    skipped: int


class AirfareData:
    """Airfare domain answers while hiding storage, fallback, and sync mechanics."""

    def __init__(
        self,
        history: FareHistory = HISTORY,
        calendar: FareCalendar = CALENDAR,
        *,
        remote: SupabaseAirfare | None = None,
        backend: Literal["local", "supabase"] = "local",
        source_root: Path | None = None,
        sync: AirfareSync | None = None,
    ) -> None:
        if backend not in {"local", "supabase"}:
            raise ValueError("Airfare data backend must be 'local' or 'supabase'")
        if backend == "supabase" and remote is None:
            raise ValueError("Supabase must be configured for Supabase Airfare reads")
        self._history = history
        self._calendar = calendar
        self._remote = remote
        self._backend = backend
        self._source_root = local_data_dir() if source_root is None else source_root
        self._sync = AirfareSync(self._source_root, remote) if sync is None else sync

    def history(self, query: HistoryQuery) -> HistoryRead:
        """Read route history from the selected store, falling back only on an outage."""
        if self._backend == "local":
            return self._local_history(query)
        try:
            return self._remote_history(query)
        except AirfareRemoteUnavailable:
            logger.warning(
                "Airfare history fell back to local archive for %s after Supabase unavailable",
                route_stem(query.origin, query.destination),
            )
            return self._local_history(query)

    def calendar(self, origin: str, destination: str) -> CalendarRead:
        """Read a route calendar from the selected store, retaining local outage fallback."""
        if self._backend == "local":
            return self._local_calendar(origin, destination)
        try:
            return self._remote_calendar(origin, destination)
        except AirfareRemoteUnavailable:
            logger.warning(
                "Airfare calendar fell back to local archive for %s after Supabase unavailable",
                route_stem(origin, destination),
            )
            return self._local_calendar(origin, destination)

    def airports(self, codes: Sequence[str]) -> dict[str, Airport]:
        """All provider airports plus coordinate-only fallbacks for requested unknown codes."""
        if self._backend == "local":
            known = self._history.airports()
        else:
            try:
                known = self._remote_airports()
            except AirfareRemoteUnavailable:
                logger.warning(
                    "Airfare airports fell back to local archive after Supabase unavailable"
                )
                known = self._history.airports()
        for code in codes:
            normalized = code.upper()
            if normalized in known:
                continue
            point = airport_coordinates.coordinates().get(normalized)
            if point is not None:
                known[normalized] = Airport(normalized, None, None, None, point[0], point[1])
        return known

    def iter_snapshots(self, origin: str, destination: str) -> Iterator[FareSnapshot]:
        """Yield a complete route archive through the same read and fallback seam."""
        yield from self.history(HistoryQuery(origin, destination)).snapshots

    def import_snapshots(self, snapshots: Iterable[FareSnapshot]) -> ImportSnapshotsResult:
        """Append only unseen watch observations to the authoritative local journal."""
        known: dict[str, set[tuple[str, str, str, str]]] = {}
        imported = 0
        skipped = 0
        for snapshot in snapshots:
            stem = route_stem(snapshot.origin, snapshot.destination)
            with _import_route_lock(stem):
                route_known = known.get(stem)
                if route_known is None:
                    route_known = {
                        self._snapshot_identity(existing)
                        for existing in self._history.read(snapshot.origin, snapshot.destination)
                    }
                    known[stem] = route_known
                identity = self._snapshot_identity(snapshot)
                if identity in route_known:
                    skipped += 1
                    continue
                self._history.append(snapshot)
                route_known.add(identity)
                imported += 1
        return ImportSnapshotsResult(imported, skipped)

    def sync_incremental(self) -> SyncReport:
        """Serialize same-process replica writes and keep configuration failures bounded."""
        with _SYNC_LOCK:
            try:
                return self._sync.apply("incremental")
            except (AirfareRemoteError, OSError, ValueError):
                return self._failed_sync_report(
                    "Airfare synchronization is unavailable; configure Supabase before retrying"
                    if self._remote is None
                    else "Airfare synchronization failed; retry with the retained source journals"
                )

    def _local_history(self, query: HistoryQuery) -> HistoryRead:
        whole_pair = self._history.read(query.origin, query.destination)
        snapshots = [
            snapshot
            for snapshot in whole_pair
            if (not query.since or snapshot.captured_at >= query.since)
            and (not query.until or snapshot.captured_at <= query.until)
        ]
        if query.snapshot_months:
            allowed_months = set(query.snapshot_months)
            snapshots = [
                snapshot for snapshot in snapshots if snapshot.flight_date[:7] in allowed_months
            ]
        known_airports = self._history.airports()
        return HistoryRead(
            origin=query.origin,
            destination=query.destination,
            snapshots=tuple(snapshots),
            baseline=tuple(
                self._history.read_baseline(query.origin, query.destination, query.departure)
            ),
            health=self._health(
                self._history.checks(query.origin, query.destination, query.departure)
            ),
            airports=tuple(
                airport
                for code in (query.origin, query.destination)
                if (airport := known_airports.get(code)) is not None
            ),
            pair_reference=self._local_pair_reference(whole_pair),
        )

    def _local_calendar(self, origin: str, destination: str) -> CalendarRead:
        return CalendarRead(
            origin=origin,
            destination=destination,
            horizon=self._calendar.horizon(origin, destination),
            health=self._health(self._calendar.checks(origin, destination)),
        )

    def _remote_history(self, query: HistoryQuery) -> HistoryRead:
        remote = self._remote_or_raise()
        document = remote.rpc(
            "read_airfare_history",
            {
                "p_origin": query.origin,
                "p_destination": query.destination,
                "p_departure": query.departure,
                # PostgreSQL distinguishes an omitted filter (NULL) from [] (no rows).
                "p_snapshot_months": list(query.snapshot_months) or None,
                "p_since": query.since,
                "p_until": query.until,
            },
        )
        doc = _object(document, "history document")
        _route(doc, query.origin, query.destination, "history document")
        snapshots = tuple(_snapshot(row) for row in _array(doc, "snapshots", "history document"))
        if any(
            item.origin != query.origin or item.destination != query.destination
            for item in snapshots
        ):
            _reject("Supabase returned a mismatched snapshot route")
        if query.snapshot_months and any(
            item.flight_date[:7] not in query.snapshot_months for item in snapshots
        ):
            _reject("Supabase returned snapshots outside the requested snapshot month filter")
        if any(
            (query.since is not None and item.captured_at < query.since)
            or (query.until is not None and item.captured_at > query.until)
            for item in snapshots
        ):
            _reject("Supabase returned snapshots outside the requested capturedAt bounds")
        if tuple(item.captured_at for item in snapshots) != tuple(
            sorted(item.captured_at for item in snapshots)
        ):
            _reject("Supabase returned history snapshots out of order")
        baseline = tuple(_baseline(row) for row in _array(doc, "baseline", "history document"))
        if tuple((item.flight_date, item.date) for item in baseline) != tuple(
            sorted((item.flight_date, item.date) for item in baseline)
        ):
            _reject("Supabase returned history baseline out of order")
        if query.departure is not None and any(
            not item.flight_date.startswith(query.departure) for item in baseline
        ):
            _reject("Supabase returned baseline departure filter violation")
        if len({(item.flight_date, item.date) for item in baseline}) != len(baseline):
            _reject("Supabase returned duplicate baseline points")
        return HistoryRead(
            origin=query.origin,
            destination=query.destination,
            snapshots=snapshots,
            baseline=baseline,
            health=_remote_health(doc.get("health")),
            airports=_history_airports(
                _array(doc, "airports", "history document"), query.origin, query.destination
            ),
            pair_reference=_pair_reference(doc.get("pairReference")),
        )

    def _remote_calendar(self, origin: str, destination: str) -> CalendarRead:
        remote = self._remote_or_raise()
        document = remote.rpc(
            "read_airfare_calendar", {"p_origin": origin, "p_destination": destination}
        )
        doc = _object(document, "calendar document")
        _route(doc, origin, destination, "calendar document")
        return CalendarRead(
            origin=origin,
            destination=destination,
            horizon=_horizon(doc.get("horizon"), origin, destination),
            health=_remote_health(doc.get("health")),
        )

    def _remote_airports(self) -> dict[str, Airport]:
        remote = self._remote_or_raise()
        found: dict[str, Airport] = {}
        for row in remote.select_all("fare_airports", ("code", "payload"), key="code"):
            item = _object(row, "airport selection")
            code = _string(item.get("code"), "airport selection code")
            payload = _object(item.get("payload"), "airport payload")
            if "code" in payload and payload["code"] != code:
                _reject("Supabase returned a mismatched airport code")
            airport = _airport({**payload, "code": code})
            if code in found:
                _reject("Supabase returned duplicate airport rows")
            found[code] = airport
        return found

    def _local_pair_reference(
        self, snapshots: Iterable[FareSnapshot]
    ) -> PairReferenceSummary | None:
        cheapest_by_departure: dict[str, float] = {}
        for snapshot in snapshots:
            prices = [offer.price for offer in snapshot.offers if offer.price is not None]
            if not prices:
                continue
            cheapest = min(prices)
            previous = cheapest_by_departure.get(snapshot.flight_date)
            if previous is None or cheapest < previous:
                cheapest_by_departure[snapshot.flight_date] = cheapest
        values = sorted(cheapest_by_departure.values())
        if not values:
            return None
        middle = len(values) // 2
        value = values[middle] if len(values) % 2 else (values[middle - 1] + values[middle]) / 2
        return PairReferenceSummary(float(value), len(values))

    @staticmethod
    def _failed_sync_report(error: str) -> SyncReport:
        return SyncReport(
            "incremental",
            "failed",
            _unavailable_source_manifest(),
            dict.fromkeys(_SYNC_DATASETS, 0),
            error,
        )

    def _remote_or_raise(self) -> SupabaseAirfare:
        if self._remote is None:
            raise AirfareRemoteUnavailable("Supabase is unavailable")
        return self._remote

    def _snapshot_identity(self, snapshot: FareSnapshot) -> tuple[str, str, str, str]:
        return (
            route_stem(snapshot.origin, snapshot.destination),
            snapshot.flight_date,
            snapshot.captured_at,
            self._history.fingerprint(snapshot),
        )

    @staticmethod
    def _health(checks: Sequence[dict[str, object]]) -> WatchHealth:
        return WatchHealth(
            last_checked_at=str(checks[-1].get("at")) if checks else None,
            checks=len(checks),
            changes=sum(1 for item in checks if item.get("outcome") == "changed"),
            errors=sum(1 for item in checks if item.get("outcome") == "error"),
        )


def _object(value: object, context: str) -> dict[str, object]:
    if not isinstance(value, dict):
        _reject(f"Supabase returned an invalid {context}")
    return value


def _import_route_lock(stem: str) -> threading.Lock:
    with _IMPORT_ROUTE_LOCKS_GUARD:
        return _IMPORT_ROUTE_LOCKS.setdefault(stem, threading.Lock())


def _unavailable_source_manifest() -> SourceManifest:
    def empty_dataset() -> DatasetManifest:
        return DatasetManifest(0, 0, 0, _EMPTY_SYNC_DIGEST, {})

    return SourceManifest(
        snapshots=empty_dataset(),
        baseline=empty_dataset(),
        calendar=empty_dataset(),
        board_checks=empty_dataset(),
        calendar_checks=empty_dataset(),
        airports=empty_dataset(),
        documents=empty_dataset(),
    )


def _reject(message: str) -> NoReturn:
    raise AirfareRemoteRejected(message)


def _array(document: dict[str, object], name: str, context: str) -> list[object]:
    value = document.get(name)
    if not isinstance(value, list):
        _reject(f"Supabase returned an invalid {context} {name}")
    return value


def _string(value: object, context: str) -> str:
    if not isinstance(value, str) or not value:
        _reject(f"Supabase returned an invalid {context}")
    return value


def _optional_string(value: object, context: str) -> str | None:
    if value is None:
        return None
    return _string(value, context)


def _number(
    value: object,
    context: str,
    *,
    allow_none: bool = False,
    allow_numeric_string: bool = False,
) -> float | None:
    if value is None and allow_none:
        return None
    if isinstance(value, bool):
        _reject(f"Supabase returned an invalid {context}")
    if isinstance(value, str) and allow_numeric_string:
        try:
            number = float(value)
        except ValueError:
            _reject(f"Supabase returned an invalid {context}")
        if math.isfinite(number):
            return number
        _reject(f"Supabase returned an invalid {context}")
    if not isinstance(value, int | float) or not math.isfinite(value):
        _reject(f"Supabase returned an invalid {context}")
    return float(value)


def _integer(value: object, context: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _reject(f"Supabase returned an invalid {context}")
    return value


def _route(document: dict[str, object], origin: str, destination: str, context: str) -> None:
    if document.get("origin") != origin or document.get("destination") != destination:
        _reject(f"Supabase returned a mismatched {context} route")


def _snapshot(value: object) -> FareSnapshot:
    row = _object(value, "snapshot")
    offers = [_offer(item) for item in _array(row, "offers", "snapshot")]
    insights_value = row.get("insights")
    insights = None if insights_value is None else _insights(insights_value)
    return FareSnapshot(
        captured_at=_string(row.get("capturedAt"), "snapshot capturedAt"),
        source=_string(row.get("source"), "snapshot source"),
        origin=_string(row.get("origin"), "snapshot origin"),
        destination=_string(row.get("destination"), "snapshot destination"),
        flight_date=_string(row.get("flightDate"), "snapshot flightDate"),
        return_date=_optional_string(row.get("returnDate"), "snapshot returnDate"),
        currency=_string(row.get("currency"), "snapshot currency"),
        offers=offers,
        insights=insights,
    )


def _offer(value: object) -> FareOffer:
    row = _object(value, "offer")
    via_points_value = row.get("viaPoints")
    if via_points_value is None:
        via_points = None
    elif isinstance(via_points_value, list) and all(
        isinstance(item, str) for item in via_points_value
    ):
        via_points = tuple(via_points_value)
    else:
        _reject("Supabase returned an invalid offer viaPoints")
    duration = row.get("durationMinutes")
    if duration is not None:
        duration = _integer(duration, "offer durationMinutes")
    return FareOffer(
        airline=_string(row.get("airline"), "offer airline"),
        airline_name=_optional_string(row.get("airlineName"), "offer airlineName"),
        flight_number=_optional_string(row.get("flightNumber"), "offer flightNumber"),
        departure_at=_string(row.get("departureAt"), "offer departureAt"),
        arrival_at=_optional_string(row.get("arrivalAt"), "offer arrivalAt"),
        transfers=_integer(row.get("transfers"), "offer transfers"),
        duration_minutes=duration,
        price=_number(row.get("price"), "offer price", allow_none=True, allow_numeric_string=True),
        currency=_string(row.get("currency"), "offer currency"),
        via_points=via_points,
    )


def _insights(value: object) -> FareInsights:
    row = _object(value, "insights")
    return FareInsights(
        typical=_number(row.get("typical"), "insights typical", allow_none=True),
        usual_low=_number(row.get("usualLow"), "insights usualLow", allow_none=True),
        usual_high=_number(row.get("usualHigh"), "insights usualHigh", allow_none=True),
    )


def _baseline(value: object) -> BaselinePoint:
    row = _object(value, "baseline point")
    price = _number(row.get("price"), "baseline price", allow_numeric_string=True)
    assert price is not None
    return BaselinePoint(
        flight_date=_string(row.get("flightDate"), "baseline flightDate"),
        date=_string(row.get("date"), "baseline date"),
        price=price,
    )


def _airport(value: object) -> Airport:
    row = _object(value, "airport")
    latitude = _number(row.get("latitude"), "airport latitude")
    longitude = _number(row.get("longitude"), "airport longitude")
    assert latitude is not None and longitude is not None
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        _reject("Supabase returned invalid airport coordinates")
    return Airport(
        code=_string(row.get("code"), "airport code"),
        name=_optional_string(row.get("name"), "airport name"),
        city=_optional_string(row.get("city"), "airport city"),
        country=_optional_string(row.get("country"), "airport country"),
        latitude=latitude,
        longitude=longitude,
    )


def _history_airports(rows: list[object], origin: str, destination: str) -> tuple[Airport, ...]:
    airports = tuple(_airport(row) for row in rows)
    endpoints = tuple(dict.fromkeys((origin, destination)))
    position = -1
    for airport in airports:
        try:
            current = endpoints.index(airport.code)
        except ValueError:
            _reject("Supabase returned history airports outside the requested endpoints")
        if current <= position:
            _reject("Supabase returned history airports outside the requested endpoint order")
        position = current
    return airports


def _remote_health(value: object) -> WatchHealth:
    row = _object(value, "health")
    checks = _integer(row.get("checks"), "health checks")
    changes = _integer(row.get("changes"), "health changes")
    errors = _integer(row.get("errors"), "health errors")
    last_checked_at = _optional_string(row.get("lastCheckedAt"), "health lastCheckedAt")
    if changes + errors > checks or (checks == 0) != (last_checked_at is None):
        _reject("Supabase returned an invalid health summary")
    return WatchHealth(last_checked_at, checks, changes, errors)


def _pair_reference(value: object) -> PairReferenceSummary | None:
    if value is None:
        return None
    row = _object(value, "pair reference")
    price = _number(row.get("value"), "pair reference value")
    dates = _integer(row.get("dates"), "pair reference dates")
    assert price is not None
    if price < 0 or dates == 0:
        _reject("Supabase returned an invalid pair reference")
    return PairReferenceSummary(price, dates)


def _horizon(value: object, origin: str, destination: str) -> Horizon | None:
    if value is None:
        return None
    row = _object(value, "calendar horizon")
    start = _string(row.get("fromDate"), "calendar horizon fromDate")
    end = _string(row.get("toDate"), "calendar horizon toDate")
    if start > end:
        _reject("Supabase returned an invalid calendar horizon window")
    prices = tuple(_observed_price(item) for item in _array(row, "prices", "calendar horizon"))
    if tuple(item.departure_date for item in prices) != tuple(
        sorted(item.departure_date for item in prices)
    ) or any(item.departure_date < start or item.departure_date > end for item in prices):
        _reject("Supabase returned calendar horizon prices out of order")
    if len({item.departure_date for item in prices}) != len(prices):
        _reject("Supabase returned duplicate calendar departure dates")
    captured_at = _string(row.get("capturedAt"), "calendar horizon capturedAt")
    if prices and captured_at != max(item.observed_at for item in prices):
        _reject("Supabase returned an invalid calendar horizon summary timestamp")
    return Horizon(
        origin=origin,
        destination=destination,
        source=_string(row.get("source"), "calendar horizon source"),
        currency=_string(row.get("currency"), "calendar horizon currency"),
        start=start,
        end=end,
        prices=list(prices),
        captured_at=captured_at,
    )


def _observed_price(value: object) -> ObservedPrice:
    row = _object(value, "calendar price")
    return ObservedPrice(
        departure_date=_string(row.get("departureDate"), "calendar price departureDate"),
        price=_number(
            row.get("price"),
            "calendar price price",
            allow_none=True,
            allow_numeric_string=True,
        ),
        observed_at=_string(row.get("observedAt"), "calendar price observedAt"),
    )


def _configured_airfare_data() -> AirfareData:
    config = airfare_supabase_config()
    remote = configured_airfare_supabase() if config is not None else None
    return AirfareData(
        remote=remote,
        backend=airfare_data_backend(),
        source_root=local_data_dir(),
        sync=AirfareSync(
            local_data_dir(), remote, batch_size=config.batch_size if config is not None else 250
        ),
    )


AIRFARE_DATA = _configured_airfare_data()
