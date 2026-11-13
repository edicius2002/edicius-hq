"""Pure, exact summaries of departed flights; no archive mutation or clock reads."""

import json
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation, localcontext
from hashlib import sha256
from types import MappingProxyType


def retention_cutoff(now: datetime) -> date:
    """Exclusive UTC departure cutoff; a flight expires on departure day + 2."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("Retention requires a timezone-aware instant")
    return now.astimezone(UTC).date() - timedelta(days=1)


def _price(value: object) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, Decimal | str | int | float):
        raise ValueError("Price must be a finite decimal")
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError("Price must be a finite decimal") from exc
    if not result.is_finite():
        raise ValueError("Price must be finite")
    return result


def _decimal_text(value: Decimal) -> str:
    if not value:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _count(value: object, *, allow_zero: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < (0 if allow_zero else 1):
        raise ValueError(
            "Count must be a positive integer" if not allow_zero else "Invalid counter"
        )
    return value


def weighted_median(frequencies: Mapping[Decimal, int]) -> Decimal | None:
    """Median over cumulative frequencies, with memory independent of their weights."""
    values = sorted((_price(price), _count(count)) for price, count in frequencies.items())
    total = sum(count for _, count in values)
    if not total:
        return None
    left_index, right_index = (total - 1) // 2, total // 2
    seen = 0
    left = None
    for price, count in values:
        seen += count
        if left is None and seen > left_index:
            left = price
        if seen > right_index:
            assert left is not None
            # Decimal's ambient precision must not round retained exact prices.
            precision = (
                max(left.adjusted(), price.adjusted())
                - min(int(left.as_tuple().exponent), int(price.as_tuple().exponent))
                + 3
            )
            with localcontext() as context:
                context.prec = max(precision, 28)
                return (left + price) / 2
    raise AssertionError("Invalid cumulative weights")


def _day(value: object) -> str:
    if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
        raise ValueError("Expected an ISO date")
    return value


def _timestamp(value: object) -> str:
    if not isinstance(value, str) or len(value) < 19:
        raise ValueError("Expected an ISO timestamp")
    datetime.fromisoformat(value)
    _day(value[:10])
    return value


def _frequencies(value: Mapping[str, Sequence[Sequence[object]]]):
    result = {}
    for day, entries in value.items():
        counts: Counter[Decimal] = Counter()
        for price, count in entries:
            counts[_price(price)] += _count(count)
        result[_day(day)] = tuple(
            (_decimal_text(price), count) for price, count in sorted(counts.items())
        )
    return MappingProxyType(result)


@dataclass(frozen=True, slots=True)
class DepartureSummary:
    version: int
    origin: str
    destination: str
    flight_date: str
    price_days: Mapping[str, tuple[tuple[str, int], ...]]
    provider_days: Mapping[str, tuple[tuple[str, int], ...]]
    unsold_days: Mapping[str, int]
    minimum_price: str | None
    latest_capture: str | None
    health: Mapping[str, object]

    def __post_init__(self) -> None:
        if type(self.version) is not int or self.version != 1:
            raise ValueError("Unsupported departure summary version")
        if not self.origin or not self.destination:
            raise ValueError("Departure summary requires a route")
        _day(self.flight_date)
        for name in ("price_days", "provider_days"):
            object.__setattr__(self, name, _frequencies(getattr(self, name)))
        object.__setattr__(
            self,
            "unsold_days",
            MappingProxyType({_day(day): _count(count) for day, count in self.unsold_days.items()}),
        )
        if self.minimum_price is not None:
            object.__setattr__(self, "minimum_price", _decimal_text(_price(self.minimum_price)))
        if self.latest_capture is not None:
            _timestamp(self.latest_capture)
        health = {
            name: _count(self.health[name], allow_zero=True)
            for name in ("checks", "changes", "errors")
        }
        latest = self.health["last_checked_at"]
        if latest is not None:
            _timestamp(latest)
        if health["changes"] + health["errors"] > health["checks"]:
            raise ValueError("Health outcomes exceed checks")
        object.__setattr__(self, "health", MappingProxyType({**health, "last_checked_at": latest}))

    @property
    def key(self) -> tuple[str, str, str]:
        return self.origin, self.destination, self.flight_date

    def to_payload(self) -> dict[str, object]:
        """A fresh JSON-safe payload, never exposing mutable summary internals."""
        return {
            "version": self.version,
            "origin": self.origin,
            "destination": self.destination,
            "flight_date": self.flight_date,
            "price_days": {
                day: [list(entry) for entry in entries] for day, entries in self.price_days.items()
            },
            "provider_days": {
                day: [list(entry) for entry in entries]
                for day, entries in self.provider_days.items()
            },
            "unsold_days": dict(self.unsold_days),
            "minimum_price": self.minimum_price,
            "latest_capture": self.latest_capture,
            "health": dict(self.health),
        }

    def canonical_json(self) -> str:
        return json.dumps(
            self.to_payload(),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )

    @property
    def digest(self) -> str:
        return sha256(self.canonical_json().encode("utf-8")).hexdigest()


def _logical_rows(rows: Sequence[Mapping[str, object]]) -> list[Mapping[str, object]]:
    # Same content identity as replication: the complete logical journal payload,
    # not physical line offsets. Decimal inputs avoid a float round trip.
    unique = {}
    for row in rows:
        identity = json.dumps(
            dict(row),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
            default=lambda value: _decimal_text(_price(value)),
        )
        unique[identity] = row
    return list(unique.values())


def summarize_departure(
    origin: str,
    destination: str,
    flight_date: date,
    snapshots: Sequence[Mapping[str, object]],
    baseline: Sequence[Mapping[str, object]],
    checks: Sequence[Mapping[str, object]],
) -> DepartureSummary:
    """Summarize one partition of raw journal rows in persisted order.

    Baseline natural keys use the last persisted value; callers must preserve
    their journal order until that reconciliation is complete. Captured days
    deliberately retain the textual date used by existing price projections.
    """
    departure = _day(flight_date.isoformat())
    for rows in (snapshots, baseline, checks):
        for row in rows:
            if (
                _day(row.get("flightDate")) != departure
                or row.get("origin", origin) != origin
                or row.get("destination", destination) != destination
            ):
                raise ValueError("Row does not belong to the departure partition")
    price_days: dict[str, Counter[Decimal]] = {}
    provider_days: dict[str, Counter[Decimal]] = {}
    unsold_days: Counter[str] = Counter()
    captures = []
    minimum = None
    for row in _logical_rows(snapshots):
        capture = _timestamp(row.get("capturedAt"))
        captures.append(capture)
        offers = row.get("offers")
        if not isinstance(offers, list) or any(not isinstance(offer, Mapping) for offer in offers):
            raise ValueError("Snapshot must contain offers")
        prices = [_price(offer["price"]) for offer in offers if offer.get("price") is not None]
        if prices:
            cheapest = min(prices)
            price_days.setdefault(capture[:10], Counter())[cheapest] += 1
            minimum = cheapest if minimum is None else min(minimum, cheapest)
        else:
            unsold_days[capture[:10]] += 1
    latest_baseline = {}
    for row in baseline:
        latest_baseline[_day(row.get("date"))] = _price(row.get("price"))
    for day, price in latest_baseline.items():
        provider_days.setdefault(day, Counter())[price] += 1
    logical_checks = _logical_rows(checks)
    times = [_timestamp(row.get("at")) for row in logical_checks]

    def frequencies(days):
        return {
            day: tuple((_decimal_text(price), count) for price, count in sorted(counts.items()))
            for day, counts in days.items()
        }

    return DepartureSummary(
        version=1,
        origin=origin,
        destination=destination,
        flight_date=departure,
        price_days=frequencies(price_days),
        provider_days=frequencies(provider_days),
        unsold_days=unsold_days,
        minimum_price=None if minimum is None else _decimal_text(minimum),
        latest_capture=max(captures, default=None),
        health={
            "last_checked_at": max(times, default=None),
            "checks": len(logical_checks),
            "changes": sum(row.get("outcome") == "changed" for row in logical_checks),
            "errors": sum(row.get("outcome") == "error" for row in logical_checks),
        },
    )
