"""
Map geography — reference data, not Path A and not Path B.

Its own router rather than another entry under `/api/fares`, which is where the
airport endpoints live. Those are archive: an airport is on that list because
somebody watched a route through it, and 12.21 records that its coordinates
arrived free with the fare search that found it. Natural Earth's subdivisions
are the opposite kind of thing — they ship with the code, no collection creates
them, and nothing about them is a fare. Filing them under fares would say they
were, and the next person reading `routers/fares.py` would have to find out
otherwise.

Wire shapes are camelCase, matching `app.routers.market` and `app.routers.fares`
and the TypeScript types that mirror them.
"""

from typing import Any

from fastapi import APIRouter, HTTPException, Path, status
from pydantic import BaseModel, Field

from app.services import subdivisions as subdivision_data

router = APIRouter(prefix="/api/geography", tags=["geography"])


class SubdivisionLabelModel(BaseModel):
    """Where one subdivision's name goes, and how much ground it has."""

    name: str
    #: Longitude and latitude of the largest piece, so an archipelago's name
    #: lands on land rather than on the average of its islands.
    at: list[float]
    #: Solid angle in steradians. The half of "is there room for this name"
    #: that does not change when the view does — see `lib/globe.screenArea`.
    area: float


class SubdivisionsResponse(BaseModel):
    country: str
    #: TopoJSON, and deliberately not modelled further. A topology is arcs,
    #: transforms and index arrays; a Pydantic mirror of it would restate the
    #: format's own specification, cost a full re-validation of 170 kB on every
    #: request, and check nothing the client is not already trusting the
    #: geometry for.
    borders: dict[str, Any]
    labels: list[SubdivisionLabelModel] = Field(default_factory=list)


@router.get("/subdivisions/{country}", response_model=SubdivisionsResponse)
def get_subdivisions(
    country: str = Path(
        ...,
        pattern=subdivision_data.COUNTRY_PATTERN,
        description="ISO 3166-1 numeric, the id the bundled country outlines carry",
    ),
) -> SubdivisionsResponse:
    """
    One country's first-level subdivisions: internal borders and names.

    One country per request because that is how it is read. The reader zooms
    into a country and this is the country they zoomed into; serving the world
    would mean 2 MB for the 22 kB anyone actually looks at, which is the whole
    reason this is an endpoint instead of a bundled file.

    404 when Natural Earth does not divide the country, and the client is
    expected to treat that as an answer rather than a failure — the map keeps
    the country's own name and draws nothing else.
    """
    found = subdivision_data.subdivisions(country)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No subdivisions for country {country!r}")
    return SubdivisionsResponse(**found)
