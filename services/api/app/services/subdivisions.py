"""
A country's first-level subdivisions — states, provinces, departments.

**Served, not bundled.** Decision 12.24 kept the map on 1:110m geography
because 1:50m is 236 kB gzipped and too heavy for a browser to carry for a page
most visits never open. There is no 1:110m admin-1 anywhere: Natural Earth's
1:50m admin-1 covers nine countries and nobody else, so the only worldwide
option is 1:10m, which is 40 MB of GeoJSON. Split per country and served from
here, a reader downloads the one country they zoomed into — 22 kB for Peru,
41 kB for the United States — and the web bundle does not grow by a byte.

The same argument `airport_search` makes for the airport table, one order of
magnitude further along: reference data that ships with the code, in
`app/data`, rather than anything the collector accumulates in `.local-data`.

Each file holds the *internal* borders only, already meshed so a border between
two provinces is one line rather than two, plus a name, a centroid and a solid
angle per subdivision. `scripts/build-subdivisions.mjs` writes them and carries
the reasoning for what it throws away.

Source: Natural Earth 1:10m Admin 1 - States, Provinces. Public domain, no
attribution required, verified at naturalearthdata.com/about/terms-of-use on
2026-08-19.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

DATA = Path(__file__).resolve().parent.parent / "data" / "subdivisions"

# ISO 3166-1 numeric, which is what `world-atlas` uses as a feature id and
# therefore the only name the map knows a country by. Three digits and nothing
# else: this string reaches the filesystem, and a country code is the whole of
# what should ever be allowed to.
COUNTRY_PATTERN = r"^\d{3}$"


@lru_cache(maxsize=1)
def available() -> frozenset[str]:
    """
    Which countries have a file, read once from the directory.

    167 of the 177 the map draws. The ten without are Antarctica, the two
    territories with a single administrative unit, and the disputed or
    unrecognised entries Natural Earth's admin-1 does not divide — every one of
    which the map already handles by keeping the country's own name.
    """
    if not DATA.is_dir():
        return frozenset()
    return frozenset(path.stem for path in DATA.glob("*.json"))


@lru_cache(maxsize=8)
def _read(country: str) -> dict[str, Any]:
    return json.loads((DATA / f"{country}.json").read_text(encoding="utf-8"))


def subdivisions(country: str) -> dict[str, Any] | None:
    """
    One country's subdivisions, or `None` when there are none to give.

    `None` is not an error and the caller must not dress it as one: a country
    Natural Earth does not divide is a country that keeps its own name on the
    map, which is a perfectly good answer to look at.

    Cached to eight countries rather than all 167. A reader zooms into a
    handful in a session and the largest file is Russia's 170 kB, so a full
    cache would hold 2 MB against the few hundred kilobytes anyone reaches.
    """
    if country not in available():
        return None
    return _read(country)
