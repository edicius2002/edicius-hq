"""
The archive of what a route cost, one line per observation.

Deliberately not `BarCache`. That cache replaces a whole series on every write,
which is right for candles — upstream is the authority and our copy is a
convenience. Here we *are* the authority: nobody else remembers what LIM-SCL
cost on a Tuesday in August, so a write that replaces is a write that destroys.

JSONL, one file per route, appended:

- Appending is O(1) and touches nothing already written. A crash mid-write can
  cost the last line and nothing before it, which a rewrite-the-file design
  cannot promise.
- A corrupt line is skipped rather than fatal, for the same reason `BarCache`
  treats an unreadable file as a miss: one bad row must not cost the history.

Three kinds of file, because polling often and recording everything are not the
same thing:

- `LIM-CUZ.jsonl` — a snapshot, written **only when something moved**. Measured
  2026-08-18: four of five real snapshots were identical to the one before, two
  of them taken 23 seconds and 8 minutes apart. At a half-hourly cadence a
  by-the-clock archive would be almost entirely duplicates — 110 MB per route
  per year of them — and the ADR's own note said this design does not hold up
  "at a hundred routes polled hourly". Writing on change instead turns the file
  into the record of what changed, which is the question being asked of it.

- `checks/LIM-CUZ.jsonl` — one short line per poll, always. Without it a gap in
  the snapshots is ambiguous between "nothing moved" and "the collector was
  down for a week", and those must never look alike.

- `state/LIM-CUZ.json` — the fingerprint of the last snapshot per departure
  date, so deciding whether to write costs a small read instead of a scan of
  the whole history. Purely derived: delete it and the next poll writes one
  extra snapshot, which is the whole cost.

Compaction is still absent, and now it can stay absent: writing on change is
what keeps the file small enough not to need it.

**12.110 changed the watch from a departure to a month and this file did not
have to move** — 12.112. Every one of the four kinds above is already keyed by
`flightDate` inside a file named for the city pair, so thirty-one departures
coexist in it exactly as two used to; the layout was per-pair-per-departure all
along and a month is only more departures. The change is on the read side and
amounts to two prefix filters, on `read_baseline` and on `checks`, so a caller
can ask for `2027-03` where it used to ask for `2027-03-09`.
"""

import hashlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path

from app.adapters.fares.models import (
    Airport,
    FareInsights,
    FareOffer,
    FareSnapshot,
    PricePoint,
)
from app.config import fares_dir

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class BaselinePoint:
    """
    One stored baseline row: which departure, when it was priced, and at what.

    Deliberately not `adapters.fares.models.PricePoint`, which is what the
    provider's payload parses into and knows only a date and a price — the
    departure is a fact about the *search* that produced the series, so the
    adapter genuinely does not have it and the archive does. Widening
    `PricePoint` instead would have given every parsed point a departure field
    that is empty everywhere except after a round trip through this file, which
    is a type that lies about what the parser returns.

    Both dates are `YYYY-MM-DD` and neither is ever parsed: `date` is when the
    provider priced the departure, `flight_date` is the departure itself, and
    the difference between them in whole days is the lead time the client plots
    a fare against.
    """

    #: The departure this price was quoted for.
    flight_date: str
    #: When it was quoted. Local midnight at the origin, as the provider sends.
    date: str
    price: float


# Which reader produced a stored fingerprint. Bumped whenever a change to the
# parser or to `fingerprint` moves the hash on boards that did not move — the
# first such change was reading Google's best-departing block, which added
# offers to nine watched routes at once and would otherwise have written
# "changed" against all nine on the same minute.
#
# Carried as a `recipe:digest` prefix on the stored value rather than as a new
# field in the state file, because the state file is a flat
# `{flightDate: fingerprint}` map that several small methods read as
# `dict[str, str]`, and nesting it to hold one integer would touch all of them
# for no gain. A fingerprint written before this existed has no prefix, which
# reads as an older recipe, which is exactly right.
FINGERPRINT_RECIPE = 2


class FareHistory:
    def __init__(self, directory: Path | None = None) -> None:
        self._dir = directory

    @property
    def directory(self) -> Path:
        return self._dir if self._dir is not None else fares_dir()

    @property
    def checks_directory(self) -> Path:
        return self.directory / "checks"

    @property
    def state_directory(self) -> Path:
        return self.directory / "state"

    def _stem(self, origin: str, destination: str) -> str:
        """
        A file name that cannot read like a way out of this directory.

        Same guard as `market_cache._path_for`, tightened: an IATA code is
        letters and digits, so unlike a ticker there is no reason to allow a
        dot here at all.
        """
        parts = []
        for code in (origin, destination):
            safe = "".join(c for c in code.upper() if c.isalnum()) or "UNKNOWN"
            parts.append(safe)
        return f"{parts[0]}-{parts[1]}"

    def _path_for(self, origin: str, destination: str) -> Path:
        return self.directory / f"{self._stem(origin, destination)}.jsonl"

    def _checks_path(self, origin: str, destination: str) -> Path:
        return self.checks_directory / f"{self._stem(origin, destination)}.jsonl"

    def _state_path(self, origin: str, destination: str) -> Path:
        return self.state_directory / f"{self._stem(origin, destination)}.json"

    def append(self, snapshot: FareSnapshot) -> None:
        path = self._path_for(snapshot.origin, snapshot.destination)
        row = {
            "capturedAt": snapshot.captured_at,
            "source": snapshot.source,
            "origin": snapshot.origin,
            "destination": snapshot.destination,
            "flightDate": snapshot.flight_date,
            "returnDate": snapshot.return_date,
            "currency": snapshot.currency,
            "insights": _insights_row(snapshot.insights),
            "offers": [_offer_row(offer) for offer in snapshot.offers],
        }
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            # One `write` of one line. Short lines land atomically on every
            # filesystem we run on, and a partial line is survivable anyway
            # because `read` skips what it cannot parse.
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError as error:
            # Loud, unlike the bar cache's warning. A cache that cannot write is
            # slow; an archive that cannot write is losing the only copy.
            logger.error("fare history could not append %s: %s", snapshot.route, error)
            raise

    def read(
        self,
        origin: str,
        destination: str,
        *,
        since: str | None = None,
        until: str | None = None,
    ) -> list[FareSnapshot]:
        """
        Every snapshot for a route, oldest first.

        `since`/`until` filter on `capturedAt` — when the price was observed,
        not when the flight leaves. Both bounds are inclusive prefixes, so a
        plain `2026-08` matches the whole month without any date parsing.
        """
        path = self._path_for(origin, destination)
        if not path.exists():
            return []

        snapshots: list[FareSnapshot] = []
        skipped = 0
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    snapshot = _snapshot_from(line)
                    if snapshot is None:
                        skipped += 1
                        continue
                    if since and snapshot.captured_at < since:
                        continue
                    if until and snapshot.captured_at > until:
                        continue
                    snapshots.append(snapshot)
        except OSError as error:
            logger.error("fare history could not read %s-%s: %s", origin, destination, error)
            return []

        if skipped and not snapshots:
            # Every line unreadable is not a bad line, it is a format change,
            # and the honest symptom of one is not an empty chart. Measured in
            # development: renaming the offer keys made a two-line archive read
            # as no history at all, and only a `warning` said so.
            logger.error(
                "fare history could not read any of the %d line(s) in %s; "
                "the archive format has probably changed",
                skipped,
                path.name,
            )
        elif skipped:
            logger.warning("fare history skipped %d unreadable line(s) in %s", skipped, path.name)
        snapshots.sort(key=lambda snapshot: snapshot.captured_at)
        return snapshots

    def fingerprint(self, snapshot: FareSnapshot) -> str:
        """
        What "the same observation" means.

        Every flight's identity and price, and nothing else. Verified stable
        against real snapshots: 25 of 33 flights kept the same
        (airline, number, departure) key across a whole day, and the ones that
        did not had genuinely rotated off the board. The arrival joins them so
        that this agrees with the web's `flightKey`, which needed it to tell
        two connections behind one first leg apart.

        Deliberately excludes `capturedAt`, which always differs, and the
        insight block, which drifts on its own and would make every poll look
        like a fare change.

        The `recipe:` prefix is what stops a change to this function from
        reading as a change in the fares — see `FINGERPRINT_RECIPE`.
        """
        rows = sorted(
            f"{offer.airline}|{offer.flight_number or ''}|{offer.departure_at}"
            f"|{offer.arrival_at or ''}|{offer.price}"
            for offer in snapshot.offers
        )
        digest = hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()[:16]
        return f"{FINGERPRINT_RECIPE}:{digest}"

    def is_rebaseline(self, snapshot: FareSnapshot) -> bool:
        """
        Whether the last fingerprint held for this departure predates the reader.

        A poll that follows a change to the parser or to `fingerprint` will
        differ from the stored value on every route at once, and it will differ
        for a reason no fare had anything to do with. Recording that as a
        change would put a spike through every series on the same minute and
        leave nobody able to tell it from a real one, so the collector asks
        this first and writes a different heartbeat when the answer is yes.

        The snapshot is still written. Its contents genuinely differ from what
        was archived — the old reader saw a partial board — and an archive that
        skipped the first correct observation to keep its own history tidy
        would be lying in the other direction.
        """
        stored = self._read_state(snapshot.origin, snapshot.destination).get(snapshot.flight_date)
        if stored is None:
            return False
        return stored.split(":", 1)[0] != str(FINGERPRINT_RECIPE)

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
            # Derived data. Losing it costs one redundant snapshot on the next
            # poll, which is why this warns where a failed append raises.
            logger.warning(
                "fare history could not update state for %s-%s: %s", origin, destination, error
            )

    def append_if_changed(self, snapshot: FareSnapshot) -> bool:
        """
        Write the snapshot only if it says something new. Returns whether it did.

        Compared against the last snapshot stored for this exact departure
        date, not for the route: two dates on one route are two series, and a
        change in one is not a change in the other.
        """
        state = self._read_state(snapshot.origin, snapshot.destination)
        current = self.fingerprint(snapshot)
        if state.get(snapshot.flight_date) == current:
            return False
        self.append(snapshot)
        state[snapshot.flight_date] = current
        self._write_state(snapshot.origin, snapshot.destination, state)
        return True

    def record_check(
        self,
        origin: str,
        destination: str,
        flight_date: str,
        *,
        at: str,
        outcome: str,
        offers: int = 0,
        cheapest: float | None = None,
        error_code: str | None = None,
    ) -> None:
        """
        One line saying we looked, whatever came of it.

        This is what makes a quiet stretch of the archive readable. Without it,
        a month with no snapshots means either a month with no price movement
        or a month with no collector, and the difference is the whole
        trustworthiness of the series.
        """
        row: dict[str, object] = {
            "at": at,
            "flightDate": flight_date,
            "outcome": outcome,
            "offers": offers,
        }
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
                "fare history could not record a check for %s-%s: %s", origin, destination, error
            )

    def last_checked(self) -> dict[tuple[str, str, str], str]:
        """
        When each watched departure was last looked at, from the heartbeats.

        The scheduler wants this and nothing else, so it reads the small files
        rather than the archive — at a half-hourly cadence that is the
        difference between scanning a day and scanning a year.
        """
        directory = self.checks_directory
        if not directory.exists():
            return {}
        seen: dict[tuple[str, str, str], str] = {}
        for path in sorted(directory.glob("*.jsonl")):
            origin, _, destination = path.stem.partition("-")
            if not origin or not destination:
                continue
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except OSError:
                continue
            for line in lines:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                    key = (origin, destination, str(row["flightDate"]))
                    at = str(row["at"])
                except (ValueError, KeyError, TypeError):
                    continue
                if at > seen.get(key, ""):
                    seen[key] = at
        return seen

    def checks(
        self, origin: str, destination: str, departure: str | None = None
    ) -> list[dict[str, object]]:
        """
        Every look taken at a route, oldest first, unreadable lines skipped.

        `departure` narrows to one departure or, as a prefix, to one watched
        month — same rule as `read_baseline`. Without it the health figures on
        a pair watched across two months would count both, and a reader looking
        at March would be told how often the collector had looked at April.
        """
        path = self._checks_path(origin, destination)
        if not path.exists():
            return []
        found: list[dict[str, object]] = []
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            logger.error(
                "fare history could not read checks for %s-%s: %s", origin, destination, error
            )
            return []
        for line in lines:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict):
                continue
            if departure is not None and not str(row.get("flightDate", "")).startswith(departure):
                continue
            found.append(row)
        found.sort(key=lambda row: str(row.get("at", "")))
        return found

    # ------------------------------------------------------------ baseline --
    #
    # Google ships a 61-point daily series with every search, covering the
    # sixty days up to today and scoped to the exact departure being watched.
    # It is kept apart from the snapshots on purpose: it is one rounded integer
    # per day with no airline, no departure time and no cents, so drawing it on
    # the same line as our own observations would quietly change what the line
    # measures. Beside them it is worth a great deal — a route added today
    # starts with two months of context instead of one point.
    #
    # Unlike the snapshots, this is *re-fetchable*, which is the same
    # distinction ADR 0002 drew between `bars/` and `fares/`: Google can answer
    # again for any day still inside its window. But the window rolls, so days
    # that fall out of it survive only here. Merge, never replace.

    def _baseline_path(self, origin: str, destination: str) -> Path:
        return self.baseline_directory / f"{self._stem(origin, destination)}.jsonl"

    @property
    def baseline_directory(self) -> Path:
        return self.directory / "baseline"

    def merge_baseline(
        self,
        origin: str,
        destination: str,
        flight_date: str,
        points: list[PricePoint],
        *,
        source: str,
        currency: str,
    ) -> int:
        """
        Fold a provider's own history in, keeping anything it has forgotten.

        Returns how many days are new to us. A day we already hold is
        overwritten by the fresh value rather than duplicated: it is the same
        provider answering about the same day, so the later answer is the one
        to keep.
        """
        if not points:
            return 0
        existing = {
            (str(row.get("flightDate")), str(row.get("date"))): row
            for row in self._read_baseline_rows(origin, destination)
        }
        before = len(existing)
        for point in points:
            existing[(flight_date, point.date)] = {
                "flightDate": flight_date,
                "date": point.date,
                "price": point.price,
                "currency": currency,
                "source": source,
            }
        rows = sorted(existing.values(), key=lambda row: (str(row["flightDate"]), str(row["date"])))

        path = self._baseline_path(origin, destination)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(
                "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
                encoding="utf-8",
            )
            temporary.replace(path)
        except OSError as error:
            # Written whole rather than appended, because merging is the point —
            # so unlike `append` this one needs the rename to be atomic.
            logger.error(
                "fare history could not write the baseline for %s-%s: %s",
                origin,
                destination,
                error,
            )
            raise
        return len(existing) - before

    def _read_baseline_rows(self, origin: str, destination: str) -> list[dict[str, object]]:
        path = self._baseline_path(origin, destination)
        if not path.exists():
            return []
        rows: list[dict[str, object]] = []
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            logger.error(
                "fare history could not read the baseline for %s-%s: %s",
                origin,
                destination,
                error,
            )
            return []
        for line in lines:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and "date" in row and "price" in row:
                rows.append(row)
        return rows

    def read_baseline(
        self, origin: str, destination: str, departure: str | None = None
    ) -> list[BaselinePoint]:
        """
        The provider's own daily series, oldest first, for one departure or one
        month of them.

        `departure` is matched as a **prefix**, which is the whole of what
        12.110 needed from this file: `2027-03-09` still selects one departure,
        and `2027-03` selects the month a route is now watched by. A prefix
        works because these keys are `YYYY-MM-DD` and sort and truncate the way
        the calendar does — the same property that keeps `read`'s `since` and
        `until` free of any date parsing.

        A `BaselinePoint` rather than the adapter's `PricePoint` — 12.171. The
        stored row has always carried the departure it was priced for, because
        `merge_baseline` keys on it; the read side was dropping it on the way
        out, which left a caller holding a month of these unable to say which
        of the thirty-one departures any one of them belonged to. That is the
        one fact a lead-time axis is built from.

        Sorted by departure and then by observation date, so a month of them
        reads as thirty-one series laid end to end rather than as one series
        that jumps back in time thirty times. Within a departure the order is
        the one it always was.
        """
        points = []
        for row in self._read_baseline_rows(origin, destination):
            flight_date = str(row.get("flightDate", ""))
            if departure is not None and not flight_date.startswith(departure):
                continue
            price = row.get("price")
            # Narrowed before `float`, not guarded after it: the same reason
            # `binance._timestamp_seconds` was rewritten — an `except` a type
            # checker cannot read is a guard only half the readers can see.
            if isinstance(price, bool) or not isinstance(price, int | float | str):
                continue
            try:
                points.append(
                    BaselinePoint(
                        flight_date=flight_date, date=str(row["date"]), price=float(price)
                    )
                )
            except (KeyError, ValueError):
                continue
        points.sort(key=lambda point: (point.flight_date, point.date))
        return points

    def has_baseline(self, origin: str, destination: str, flight_date: str) -> bool:
        """Whether this departure has already been seeded, so we seed it once."""
        return bool(self.read_baseline(origin, destination, flight_date))

    # ----------------------------------------------------------- airports --
    #
    # One small file for the whole archive rather than one per route: an
    # airport is a fact about the world, not about a route, and LIM appearing
    # in nine watched pairs should not be nine copies that can disagree.
    #
    # This is the one part of the archive that is genuinely re-fetchable — an
    # airport does not move — so it is written whole, like `BarCache` and
    # unlike the observations.

    @property
    def airports_path(self) -> Path:
        return self.directory / "airports.json"

    def merge_airports(self, airports: list[Airport]) -> int:
        """Fold newly seen airports in, returning how many were new."""
        if not airports:
            return 0
        known = self.airports()
        before = len(known)
        for airport in airports:
            known[airport.code] = airport
        rows = {
            code: {
                "code": airport.code,
                "name": airport.name,
                "city": airport.city,
                "country": airport.country,
                "latitude": airport.latitude,
                "longitude": airport.longitude,
            }
            for code, airport in sorted(known.items())
        }
        path = self.airports_path
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
            temporary.replace(path)
        except OSError as error:
            # Coordinates are what a map needs, not what an observation needs.
            # Losing them must not cost the snapshot behind them.
            logger.warning("fare history could not write airports: %s", error)
            return 0
        return len(known) - before

    def airports(self) -> dict[str, Airport]:
        path = self.airports_path
        if not path.exists():
            return {}
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(rows, dict):
            return {}
        found: dict[str, Airport] = {}
        for code, row in rows.items():
            if not isinstance(row, dict):
                continue
            latitude, longitude = row.get("latitude"), row.get("longitude")
            if not isinstance(latitude, int | float) or not isinstance(longitude, int | float):
                continue
            found[str(code)] = Airport(
                code=str(code),
                name=row.get("name"),
                city=row.get("city"),
                country=row.get("country"),
                latitude=float(latitude),
                longitude=float(longitude),
            )
        return found

    def routes(self) -> list[tuple[str, str]]:
        """Which routes have any history at all."""
        directory = self.directory
        if not directory.exists():
            return []
        found = []
        for path in sorted(directory.glob("*.jsonl")):
            origin, _, destination = path.stem.partition("-")
            if origin and destination:
                found.append((origin, destination))
        return found


def _insights_row(insights: FareInsights | None) -> dict[str, object] | None:
    if insights is None:
        return None
    return {
        "typical": insights.typical,
        "usualLow": insights.usual_low,
        "usualHigh": insights.usual_high,
    }


def _insights_from(row: object) -> FareInsights | None:
    if not isinstance(row, dict):
        return None
    return FareInsights(
        typical=row.get("typical"),
        usual_low=row.get("usualLow"),
        usual_high=row.get("usualHigh"),
    )


def _offer_row(offer: FareOffer) -> dict[str, object]:
    """
    An offer as it is written.

    Spelled out rather than `asdict`, which would name the keys after the
    dataclass fields and put `airline_name` inside a row whose own keys are
    `capturedAt` and `flightDate` — two conventions in one line of a file
    meant to be read by a human years from now. These match the wire.
    """
    return {
        "airline": offer.airline,
        "airlineName": offer.airline_name,
        "flightNumber": offer.flight_number,
        "departureAt": offer.departure_at,
        "arrivalAt": offer.arrival_at,
        "transfers": offer.transfers,
        "durationMinutes": offer.duration_minutes,
        "price": offer.price,
        "currency": offer.currency,
    }


def _offer_from(row: object) -> FareOffer:
    if not isinstance(row, dict):
        raise TypeError("offer row is not an object")
    return FareOffer(
        airline=str(row["airline"]),
        airline_name=row.get("airlineName"),
        flight_number=row.get("flightNumber"),
        departure_at=str(row["departureAt"]),
        arrival_at=row.get("arrivalAt"),
        transfers=int(row["transfers"]),
        duration_minutes=row.get("durationMinutes"),
        price=float(row["price"]),
        currency=str(row["currency"]),
    )


def _snapshot_from(line: str) -> FareSnapshot | None:
    try:
        row = json.loads(line)
        return FareSnapshot(
            captured_at=str(row["capturedAt"]),
            source=str(row["source"]),
            origin=str(row["origin"]),
            destination=str(row["destination"]),
            flight_date=str(row["flightDate"]),
            return_date=row.get("returnDate"),
            currency=str(row["currency"]),
            insights=_insights_from(row.get("insights")),
            offers=[_offer_from(offer) for offer in row.get("offers", [])],
        )
    except (ValueError, KeyError, TypeError):
        return None


HISTORY = FareHistory()
