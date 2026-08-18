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

Compaction is deliberately absent. One snapshot per route per day is a few
hundred lines a year; at that size a reader that streams is simpler than any
rotation scheme, and the scheme can be added when there is something to rotate.
"""

import json
import logging
from pathlib import Path

from app.adapters.fares.models import FareOffer, FareSnapshot
from app.config import fares_dir

logger = logging.getLogger(__name__)


class FareHistory:
    def __init__(self, directory: Path | None = None) -> None:
        self._dir = directory

    @property
    def directory(self) -> Path:
        return self._dir if self._dir is not None else fares_dir()

    def _path_for(self, origin: str, destination: str) -> Path:
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
        return self.directory / f"{parts[0]}-{parts[1]}.jsonl"

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
            offers=[_offer_from(offer) for offer in row.get("offers", [])],
        )
    except (ValueError, KeyError, TypeError):
        return None


HISTORY = FareHistory()
