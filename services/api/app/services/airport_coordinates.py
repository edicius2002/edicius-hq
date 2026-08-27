"""Coordinates for IATA airports that the provider did not search directly.

The checked-in TSV is a reduced OurAirports ``airports.csv`` (public domain),
kept separate from the route-search airport catalogue because only the map's
intermediate stops need this worldwide fallback.
"""

from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "airport_coordinates.tsv"


@lru_cache(maxsize=1)
def coordinates() -> dict[str, tuple[float, float]]:
    """OurAirports' CC0 IATA coordinates, indexed once for route waypoints."""
    try:
        rows = DATA.read_text(encoding="utf-8").splitlines()[1:]
    except OSError:
        return {}
    found: dict[str, tuple[float, float]] = {}
    for row in rows:
        code, separator, values = row.partition("\t")
        if len(code) != 3 or not separator:
            continue
        latitude, separator, longitude = values.partition("\t")
        if not separator:
            continue
        try:
            found[code.upper()] = (float(latitude), float(longitude))
        except ValueError:
            continue
    return found
