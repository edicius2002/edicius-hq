"""
The raw board behind every parse-drift refusal, kept for whoever studies it.

`parse_payload` refuses a board it cannot read rather than archive a partial
one (decision 12.4), and that refusal is all that survived: a log line saying
"returned 1 itineraries and none could be read". ARI-SCL has produced dozens of
those, only in the long evening passes, and every board fetched by hand since
has read cleanly — so the one thing that would explain them is the board
itself, at the moment it was refused. This keeps it.

Written under the collector's own state directory, the newest `KEEP` only, and
never at the cost of the refusal: a sample that cannot be written is logged and
dropped, and the `FareError` goes on exactly as before.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.adapters.fares.models import FareQuery
from app.config import local_data_dir

logger = logging.getLogger(__name__)

DIRECTORY = "fares-drift"
KEEP = 20


def keep(
    query: FareQuery,
    payload: Any,
    *,
    root: Path | None = None,
    stamp: str | None = None,
) -> Path | None:
    """Write `payload` as the sample for `query`, trimming to the newest `KEEP`."""
    try:
        directory = (root or local_data_dir()) / DIRECTORY
        directory.mkdir(parents=True, exist_ok=True)
        when = stamp or datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        path = directory / f"{when}-{query.origin}-{query.destination}-{query.flight_date}.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        # Timestamped names sort by age, so everything before the last KEEP goes.
        for stale in sorted(directory.glob("*.json"))[:-KEEP]:
            stale.unlink(missing_ok=True)
        return path
    except (OSError, TypeError, ValueError) as error:
        logger.warning("could not keep a parse-drift sample: %s", error)
        return None


__all__ = ["DIRECTORY", "KEEP", "keep"]
