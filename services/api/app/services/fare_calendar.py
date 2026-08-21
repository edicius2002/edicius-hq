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

**And the year is read from every curve, not from the newest one** —
`a-curve-fills-what-newer-lost`. That is what `horizon()` at the bottom of
this file is, and it is a reading rule rather than a writing one: nothing here
merges on the way in, because a stored curve is the record of what was observed
at one moment and a merged one would destroy exactly that. See `horizon()` for
what the merge does and what it refuses to do.
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


@dataclass(frozen=True, slots=True)
class ObservedPrice:
    """
    One departure date, its cheapest fare, and **when that fare was seen**.

    A `CalendarPrice` with the one fact it could afford to leave out while the
    only answer to "what does the year cost" was a single curve. Inside one
    curve every date shares the curve's `captured_at`, so carrying it per date
    would have been the same string three hundred times. Across several curves
    it is not the same string, and it stops being metadata: a price merged in
    from a collection three days ago is being shown beside one collected an hour
    ago, and a reader cannot weigh the two without knowing which is which.
    """

    departure_date: str
    price: float | None
    #: The `captured_at` of the curve this price came from.
    observed_at: str


@dataclass(frozen=True, slots=True)
class Horizon:
    """
    What the whole year costs, assembled from every curve on disk.

    Shaped like a `CalendarCurve` on purpose — a window and one price per
    departure date inside it — because that is what a reader of the year wants
    and it is what the endpoint already serves. What it is not is an
    observation: no single moment produced it, which is why its prices carry
    their own stamps and why nothing ever writes one of these to a file.
    """

    origin: str
    destination: str
    source: str
    currency: str
    start: str
    end: str
    #: Oldest departure date first. A date inside `start`..`end` that is absent
    #: from here was answered for by nobody — 12.154 survives the merge intact.
    prices: list[ObservedPrice]
    #: The freshest observation in `prices`. See `FareCalendar.horizon`.
    captured_at: str

    @property
    def route(self) -> str:
        return f"{self.origin}-{self.destination}"

    @property
    def cheapest(self) -> ObservedPrice | None:
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
        """
        The most recent curve, exactly as it was observed.

        Still here, and still the right answer to "has this pair ever been
        collected" — which is the one question left that wants a single curve.
        It is no longer the answer to "what does the year cost": see `horizon`.
        """
        curves = self.read(origin, destination)
        return curves[-1] if curves else None

    def horizon(self, origin: str, destination: str) -> Horizon | None:
        """
        What the year costs, taking each date from the newest curve that answered.

        **The fault this repairs.** `latest()` was what the endpoint served, and
        a curve can be *shorter* than the one before it. Since 12.245 the
        collector walks a refused window's far end back and keeps only what the
        provider would actually price, which is honest on disk and was silently
        destructive on the way out: the day MAD-BCN was narrowed to 2027-02-18
        after one refusal, five months of departure dates left the chart, while
        the curve holding them sat on disk beside the new one, whole and
        readable. Nothing was lost — the archive is append-only and always was —
        so this is a reading rule and there is nothing to migrate.

        **Newest wins, per date.** Walking the curves newest first and keeping
        the first answer for each date is all the arithmetic there is. What
        deserves the words is what counts as an answer.

        **Presence decides who answered; the window decides what an absence
        means.** A date is answered by a curve when it is *in that curve's
        prices*, whether the price is a number or `null` — 12.154, and it holds
        per curve here rather than only per file. A date the newest curve never
        reached is not in its prices at all, so the walk falls through to the
        curve behind it; a date the provider answered about and had nothing to
        sell on is present with a `null`, so the walk stops there and the `null`
        is what the reader gets. Testing "is the price null" instead of "is the
        date present" would have inverted exactly that: an unserved Tuesday
        would have been overwritten by whatever last week thought it cost, which
        is a fare invented out of two true facts.

        The window is still load-bearing, one level up. `start`..`end` is what
        makes a date that appears in *no* curve legible as "nobody ever answered
        for this" rather than as "nobody wanted it", and a merged answer needs
        its own or the distinction dies at the boundary.

        **The near end is the newest curve's; the far end is the furthest any
        curve reached.** The two ends move for opposite reasons and only one of
        them is a loss. A window's near end advances because time passes and
        yesterday's departure has gone — inheriting it would put flights nobody
        can book back on the chart and would grow this payload by a date a day
        forever. The far end retreats because a provider refused, and that is
        the loss this exists to repair.

        **Not on write.** Storing the merged curve would be a smaller endpoint
        and would destroy the archive: the file would stop being a record of
        what was observed when, and no later reader could ever separate the two
        again. Nothing about the merge belongs anywhere near `append_if_changed`.
        """
        curves = self.read(origin, destination)
        if not curves:
            return None

        newest = curves[-1]
        start = newest.start
        end = max(curve.end for curve in curves)

        answered: dict[str, ObservedPrice] = {}
        for curve in reversed(curves):
            for point in curve.prices:
                if point.departure_date < start or point.departure_date > end:
                    continue
                if point.departure_date in answered:
                    continue
                answered[point.departure_date] = ObservedPrice(
                    departure_date=point.departure_date,
                    price=point.price,
                    observed_at=curve.captured_at,
                )

        prices = sorted(answered.values(), key=lambda point: point.departure_date)
        return Horizon(
            origin=origin,
            destination=destination,
            # The newest curve's, both of them. `source` is which provider
            # answered and `currency` is what the numbers are denominated in;
            # taking either from an older curve would describe the majority of
            # the prices on screen by a fact about the minority.
            source=newest.source,
            currency=newest.currency,
            start=start,
            end=end,
            prices=prices,
            # **The freshest thing actually on screen**, which is the decision
            # rather than the arithmetic. A merged answer has no one capture
            # time, and the field is read to answer "how old is what I am
            # looking at" — so it names the newest price a reader can see and
            # never a collection that contributed none of them. In practice the
            # two candidate readings coincide: the newest curve sets `start` and
            # so always contributes, which makes the newest observation its own.
            # They part only where a stored curve holds no prices at all, and
            # there the fallback below is the newest curve rather than nothing —
            # a stamp is still owed even when there is nothing to stamp.
            #
            # What it is emphatically *not* is a claim about every price beside
            # it. Dates inherited from older curves carry their own
            # `observed_at`, and a reader that showed this one stamp over all of
            # them would be doing the thing this merge was written to avoid.
            captured_at=max((point.observed_at for point in prices), default=newest.captured_at),
        )

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
