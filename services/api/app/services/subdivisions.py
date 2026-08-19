"""
A country's first-level subdivisions — states, provinces, departments.

**Served, not bundled.** Decision 12.24 kept the map on 1:110m geography
because 1:50m is 236 kB gzipped and too heavy for a browser to carry for a page
most visits never open. There is no 1:110m admin-1 anywhere: Natural Earth's
1:50m admin-1 covers nine countries and nobody else, so the only worldwide
option is 1:10m, which is 40 MB of GeoJSON. Split per country and served from
here, a reader downloads the countries in front of them — 43 kB for Peru,
334 kB for the United States, against 6.4 MB for all 167 — and the web bundle
does not grow by a byte. Which countries those are is the client's question
and `catalogue` is what lets it answer in bytes rather than in guesses.

The same argument `airport_search` makes for the airport table, one order of
magnitude further along: reference data that ships with the code, in
`app/data`, rather than anything the collector accumulates in `.local-data`.

Each file holds two geometries over one shared set of arcs — the borders
*between* two subdivisions, already meshed so a shared one is a single line,
and the country's own outline dissolved out of the same units — plus a name, a
centroid and a solid angle per subdivision.

The outline is there because the map's zoom ceiling is 32x, where a pixel is
1.03 km and the bundled 1:110m atlas has a median segment of 63 km: sixty-one
pixels, which reads as a straight line where a coast should be. Dissolving the
admin-1 units is what keeps it honest — a 1:50m coast under 1:10m provincial
borders would not meet them. `scripts/build-subdivisions.mjs` writes the files
and carries the rest of the reasoning.

Source: Natural Earth 1:10m Admin 1 - States, Provinces. Public domain, no
attribution required, verified at naturalearthdata.com/about/terms-of-use on
2026-08-19.
"""

from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "subdivisions"

# ISO 3166-1 numeric, which is what `world-atlas` uses as a feature id and
# therefore the only name the map knows a country by. Three digits and nothing
# else: this string reaches the filesystem, and a country code is the whole of
# what should ever be allowed to.
COUNTRY_PATTERN = r"^\d{3}$"


@lru_cache(maxsize=1)
def catalogue() -> dict[str, int]:
    """
    What every country's subdivisions weigh, in the bytes the wire will carry.

    The map no longer reads one country at a time. It fills the camera's field
    of view, which over Europe is thirty countries at once, and the files run
    from 4 kB to Russia's 618 kB — so "how many countries" is the wrong unit
    for a budget and "how many bytes" is the right one. The client cannot know
    those bytes without being told, and telling it after the fact is telling it
    too late: by then the bytes are spent.

    Two and a half kilobytes for all 167, fetched once and never again, and it
    also removes the requests that were never going to return anything. A
    country with no entry here has no file, so the client stops asking about
    Western Sahara and the Falklands instead of collecting a 404 for each of
    them every time a view happens to include one — which one country per
    request could afford and thirty cannot.

    File sizes rather than a re-measured payload, because they are the same
    number: `get_subdivisions` serves the file, so what is counted here is what
    arrives. Read once — the directory is reference data that changes when
    somebody regenerates it, which is a redeploy.
    """
    if not DATA.is_dir():
        return {}
    return {path.stem: path.stat().st_size for path in sorted(DATA.glob("*.json"))}


def available() -> frozenset[str]:
    """
    Which countries have a file.

    167 of the 177 the map draws. The ten without are Antarctica, the two
    territories with a single administrative unit, and the disputed or
    unrecognised entries Natural Earth's admin-1 does not divide — every one of
    which the map already handles by keeping the country's own name.
    """
    return frozenset(catalogue())


@lru_cache(maxsize=32)
def _read(country: str) -> bytes:
    return (DATA / f"{country}.json").read_bytes()


def subdivisions(country: str) -> bytes | None:
    """
    One country's subdivisions as the file holds them, or `None` for a country
    that has none.

    `None` is not an error and the caller must not dress it as one: a country
    Natural Earth does not divide is a country that keeps its own name on the
    map, which is a perfectly good answer to look at.

    **Bytes, not a parsed document, and that is the fan-out paying for itself.**
    Parsed, these files cost fourteen times their own size in Python objects —
    measured, twenty-four of them are 2.05 MB on disk and 29.3 MB in memory —
    so a cache big enough for a viewport was a cache too big to keep. Held as
    bytes, thirty-two countries are a few megabytes, the round trip through
    `json.loads` and back out through the serialiser is gone from a burst that
    is now twenty requests rather than one, and what the catalogue promises is
    exactly what the wire carries. The shape is still declared on the endpoint
    and still checked, once, by `test_geography` against the shipped files —
    which is where a build that wrote something malformed should be caught,
    rather than on every request forever after.

    Thirty-two rather than all 167, because the reader's next view overlaps
    this one and the one before it: a viewport's worth of countries stays hot
    across a pan, and the whole corpus is 6.4 MB nobody looks at.
    """
    if country not in available():
        return None
    return _read(country)
