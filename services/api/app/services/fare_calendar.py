"""
The archive of what a whole year of departures costs, one line per curve.

**Why this is not a fifth kind of file inside `FareHistory`.** That was the
first design and it was rejected on a specific hazard rather than on taste. All
four kinds `fare_history` owns — the snapshot, the heartbeat, the fingerprint
state and the provider baseline — are keyed by `(city pair, flightDate)`, and
the readers built on that keying include `last_checked()`, which is the input
the board scheduler runs on. A calendar curve is keyed by `(city pair,
capturedAt)`: its departure dates are the *payload*, three hundred of them to a
line, not the key. Folding it in would mean either a fifth key shape inside a
class whose every reader assumes the fourth, or teaching `last_checked` to skip
a kind of row it must never hand the scheduler — a change to the code path that
collects the reader's primary data, made for a feature that can be additive
instead. The board collection works and is not touched.

What is shared is the rule, not the class, and the one piece of code that must
not be duplicated is imported rather than copied: `route_stem`, the guard that
stops a route code reading as a way out of the directory.

Three kinds of file, under `fares/calendar/`, mirroring the archive beside it:

- `LIM-CUZ.jsonl` — one observed curve per line, written **only when something
  moved**. Measured on the first real one, ARI-SCL on 2026-08-19: 331 departure
  dates in 7,145 bytes, so a by-the-clock daily write is 2.6 MB a route a year.
  A fare eleven months out moves on 22% of days by a median 1.7%, so most of
  those lines would be saying nothing at all — same rule as 12.16, one level up.

- `checks/LIM-CUZ.jsonl` — one short line per pass, always. Same reason the
  board has one: without it a stretch with no curves is ambiguous between
  "nothing moved" and "nothing ran", and those must never look alike.

- `state/LIM-CUZ.json` — the fingerprint of the last curve, so deciding whether
  to write costs a small read rather than a scan. Purely derived.

**Honest about gaps in two distinct ways**, which is the whole reason the row
carries `from` and `to` beside its prices. A departure date inside the window
with a `null` price is a day the provider answered about and had nothing to
sell. A departure date inside the window that is absent from `prices` is a day
we never got an answer for. Collapsing those two into one absence would make an
unserved Tuesday indistinguishable from a truncated collection.
"""

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from app.adapters.fares.models import CalendarPrice
from app.config import fares_dir
from app.services.fare_history import route_stem

logger = logging.getLogger(__name__)

#: Which reader produced a stored fingerprint, carried as a `recipe:digest`
#: prefix. Same device as `fare_history.FINGERPRINT_RECIPE` and for the same
#: reason: a change to how a curve is hashed must not read as every route
#: moving at once. Starts at 1 because nothing has been written yet.
FINGERPRINT_RECIPE = 1


@dataclass(frozen=True, slots=True)
class CalendarCurve:
    """
    Every departure date a provider priced for one city pair, at one moment.

    The unit of this archive, exactly as a `FareSnapshot` is the unit of the
    one beside it — and one level up from it: a snapshot is a board on one
    departure, a curve is one number on each of three hundred.
    """

    captured_at: str
    source: str
    origin: str
    destination: str
    currency: str
    #: The window that was asked for, so a date missing from `prices` reads as
    #: a gap in the answer rather than as a date nobody wanted.
    start: str
    end: str
    prices: list[CalendarPrice] = field(default_factory=list)

    @property
    def route(self) -> str:
        return f"{self.origin}-{self.destination}"

    @property
    def cheapest(self) -> CalendarPrice | None:
        """The cheapest day in the window, which is the question this exists for."""
        priced = [point for point in self.prices if point.price is not None]
        return min(priced, key=lambda point: point.price or 0.0, default=None)


class FareCalendar:
    def __init__(self, directory: Path | None = None) -> None:
        self._dir = directory

    @property
    def directory(self) -> Path:
        return self._dir if self._dir is not None else fares_dir() / "calendar"

    @property
    def checks_directory(self) -> Path:
        return self.directory / "checks"

    @property
    def state_directory(self) -> Path:
        return self.directory / "state"

    def _path_for(self, origin: str, destination: str) -> Path:
        return self.directory / f"{route_stem(origin, destination)}.jsonl"

    def _checks_path(self, origin: str, destination: str) -> Path:
        return self.checks_directory / f"{route_stem(origin, destination)}.jsonl"

    def _state_path(self, origin: str, destination: str) -> Path:
        return self.state_directory / f"{route_stem(origin, destination)}.json"

    # ------------------------------------------------------------- writing --

    def append(self, curve: CalendarCurve) -> None:
        path = self._path_for(curve.origin, curve.destination)
        row = {
            "capturedAt": curve.captured_at,
            "source": curve.source,
            "origin": curve.origin,
            "destination": curve.destination,
            "currency": curve.currency,
            "from": curve.start,
            "to": curve.end,
            # An object keyed by departure date, because that is the shape the
            # thing is: a map from a day to one number. A list of pairs would
            # allow the same date twice, which this cannot mean.
            "prices": {point.departure_date: point.price for point in curve.prices},
        }
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError as error:
            # Loud, like `FareHistory.append` and unlike the bar cache: this is
            # the only copy of what the year looked like on this day.
            logger.error("fare calendar could not append %s: %s", curve.route, error)
            raise

    def fingerprint(self, curve: CalendarCurve) -> str:
        """
        What "the same curve" means: every departure date and its price.

        Deliberately excludes `captured_at`, which always differs, and the
        window, which shifts by a day every day — a curve that has slid forward
        one date is not news about a fare.
        """
        rows = sorted(
            f"{point.departure_date}|{'' if point.price is None else point.price}"
            for point in curve.prices
        )
        digest = hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()[:16]
        return f"{FINGERPRINT_RECIPE}:{digest}"

    def append_if_changed(self, curve: CalendarCurve) -> bool:
        """Write the curve only if it says something new. Returns whether it did."""
        state = self._read_state(curve.origin, curve.destination)
        current = self.fingerprint(curve)
        if state.get("fingerprint") == current:
            return False
        self.append(curve)
        self._write_state(curve.origin, curve.destination, {"fingerprint": current})
        return True

    def _read_state(self, origin: str, destination: str) -> dict[str, str]:
        try:
            found = json.loads(self._state_path(origin, destination).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(found, dict):
            return {}
        return {str(k): str(v) for k, v in found.items() if isinstance(v, str)}

    def _write_state(self, origin: str, destination: str, state: dict[str, str]) -> None:
        path = self._state_path(origin, destination)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        except OSError as error:
            # Derived. Losing it costs one redundant curve on the next pass.
            logger.warning(
                "fare calendar could not update state for %s-%s: %s", origin, destination, error
            )

    def record_check(
        self,
        origin: str,
        destination: str,
        *,
        at: str,
        outcome: str,
        dates: int = 0,
        cheapest: float | None = None,
        error_code: str | None = None,
    ) -> None:
        """One line saying we looked, whatever came of it."""
        row: dict[str, object] = {"at": at, "outcome": outcome, "dates": dates}
        if cheapest is not None:
            row["cheapest"] = cheapest
        if error_code is not None:
            row["errorCode"] = error_code
        path = self._checks_path(origin, destination)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError as error:
            # A lost heartbeat costs an ambiguous gap, not an observation.
            logger.warning(
                "fare calendar could not record a check for %s-%s: %s", origin, destination, error
            )

    # ------------------------------------------------------------- reading --

    def checks(self, origin: str, destination: str) -> list[dict[str, object]]:
        """Every look taken at a route's calendar, oldest first."""
        path = self._checks_path(origin, destination)
        if not path.exists():
            return []
        found: list[dict[str, object]] = []
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            logger.error(
                "fare calendar could not read checks for %s-%s: %s", origin, destination, error
            )
            return []
        for line in lines:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict):
                found.append(row)
        found.sort(key=lambda row: str(row.get("at", "")))
        return found

    def last_checked_at(self, origin: str, destination: str) -> str | None:
        checks = self.checks(origin, destination)
        return str(checks[-1]["at"]) if checks else None

    def read(
        self,
        origin: str,
        destination: str,
        *,
        since: str | None = None,
        until: str | None = None,
    ) -> list[CalendarCurve]:
        """
        Every curve stored for a route, oldest first.

        `since`/`until` are inclusive prefixes on `capturedAt`, the same rule
        `FareHistory.read` uses, so `2026-08` selects a month with no date
        parsing anywhere.
        """
        path = self._path_for(origin, destination)
        if not path.exists():
            return []

        curves: list[CalendarCurve] = []
        skipped = 0
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    curve = _curve_from(line)
                    if curve is None:
                        skipped += 1
                        continue
                    if since and curve.captured_at < since:
                        continue
                    if until and curve.captured_at > until:
                        continue
                    curves.append(curve)
        except OSError as error:
            logger.error("fare calendar could not read %s-%s: %s", origin, destination, error)
            return []

        if skipped and not curves:
            # Every line unreadable is a format change, not a bad row, and the
            # honest symptom of one is not an empty chart — same lesson the
            # archive beside this one learned the hard way.
            logger.error(
                "fare calendar could not read any of the %d line(s) in %s; "
                "the stored format has probably changed",
                skipped,
                path.name,
            )
        elif skipped:
            logger.warning("fare calendar skipped %d unreadable line(s) in %s", skipped, path.name)
        curves.sort(key=lambda curve: curve.captured_at)
        return curves

    def latest(self, origin: str, destination: str) -> CalendarCurve | None:
        """The most recent curve, which is what "what does the year cost" means."""
        curves = self.read(origin, destination)
        return curves[-1] if curves else None

    def routes(self) -> list[tuple[str, str]]:
        directory = self.directory
        if not directory.exists():
            return []
        found = []
        for path in sorted(directory.glob("*.jsonl")):
            origin, _, destination = path.stem.partition("-")
            if origin and destination:
                found.append((origin, destination))
        return found

    # ----------------------------------------------------------- staleness --

    def due(
        self,
        origin: str,
        destination: str,
        now: datetime,
        *,
        every_minutes: int,
    ) -> bool:
        """
        Whether this route's calendar is stale enough to spend requests on.

        The store decides, rather than the collector, because the store is what
        knows when it was last written to — the same division `due_now` and
        `last_checked` already draw for the boards.
        """
        seen = self.last_checked_at(origin, destination)
        if not seen:
            return True
        try:
            previous = datetime.fromisoformat(seen)
        except ValueError:
            return True
        return now - previous >= timedelta(minutes=every_minutes)


def _curve_from(line: str) -> CalendarCurve | None:
    try:
        row = json.loads(line)
        prices = row["prices"]
        if not isinstance(prices, dict):
            raise TypeError("prices is not an object")
        return CalendarCurve(
            captured_at=str(row["capturedAt"]),
            source=str(row["source"]),
            origin=str(row["origin"]),
            destination=str(row["destination"]),
            currency=str(row["currency"]),
            start=str(row["from"]),
            end=str(row["to"]),
            prices=[
                CalendarPrice(
                    departure_date=str(date),
                    # A stored `null` is a day with no flights and is kept as
                    # one. Reading it as a zero would put a free flight on the
                    # chart; dropping it would lose the difference between an
                    # unserved day and an unasked one.
                    price=None if price is None else float(price),
                )
                for date, price in prices.items()
            ],
        )
    except (ValueError, KeyError, TypeError):
        return None


CALENDAR = FareCalendar()
