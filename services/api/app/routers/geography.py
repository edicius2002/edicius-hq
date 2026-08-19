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

from fastapi import APIRouter, HTTPException, Path, Response, status
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
    #: TopoJSON with two objects over one set of arcs: `borders`, the
    #: boundaries between two subdivisions, and `land`, the country itself.
    #: Deliberately not modelled further — a topology is arcs, transforms and
    #: index arrays, and a Pydantic mirror of it would restate the format's own
    #: specification, cost a full re-validation of 600 kB on every request, and
    #: check nothing the client is not already trusting the geometry for.
    borders: dict[str, Any]
    labels: list[SubdivisionLabelModel] = Field(default_factory=list)


class SubdivisionCatalogueResponse(BaseModel):
    """What every country's subdivisions weigh, so the client can budget."""

    #: ISO 3166-1 numeric to the byte length of that country's response. A
    #: country absent from this map has no subdivisions and must not be asked
    #: for; asking anyway still answers 404, which is what makes the catalogue
    #: an optimisation rather than a precondition.
    countries: dict[str, int]


@router.get("/subdivisions", response_model=SubdivisionCatalogueResponse)
def get_subdivision_catalogue() -> SubdivisionCatalogueResponse:
    """
    Every country that has subdivisions, and what each one costs to fetch.

    An index over the collection, not a change to what a member of it is —
    2.5 kB against the 6.4 MB it describes, fetched once a session and never
    invalidated, because Natural Earth publishes a few times a decade.

    It exists because the client's question changed. It used to be "what is
    under the middle of the frame", which is one country and needs no plan; it
    is now "what is in front of the reader", which over Europe is thirty
    countries whose files run from 4 kB to 618 kB. A budget in countries would
    be a budget in the wrong unit — the United States alone is eight Bolivias —
    and a budget in bytes needs the bytes before it spends them, not after.
    """
    return SubdivisionCatalogueResponse(countries=subdivision_data.catalogue())


@router.get(
    "/subdivisions/{country}",
    response_model=SubdivisionsResponse,
    response_class=Response,
)
def get_subdivisions(
    country: str = Path(
        ...,
        pattern=subdivision_data.COUNTRY_PATTERN,
        description="ISO 3166-1 numeric, the id the bundled country outlines carry",
    ),
) -> Response:
    """
    One country's first-level subdivisions: internal borders and names.

    **Still one country per request**, and the reason has held up better than
    the way it was first written down. That said serving the world would be
    2 MB for the 22 kB anyone looks at — right about the bytes and wrong about
    the scope, because what a reader looks at is a viewport and a viewport is
    not one country. So the client now asks for every country the camera
    intersects and this endpoint is unchanged: per-country is the granularity
    that makes a fan-out cacheable, since the next view overlaps this one and
    the countries they share are already in hand. A batch endpoint would have
    re-sent them, and a bundled file would still be 6.4 MB.

    The file is served as it sits on disk rather than parsed and rebuilt.
    Twenty requests where there was one turned that round trip from a rounding
    error into real work, and it is work that could only change the bytes —
    `catalogue` promises the client a length, and the promise is kept by there
    being nothing between the file and the socket. The shape above is still the
    declared contract and `test_geography` still checks the shipped files
    against it.

    404 when Natural Earth does not divide the country, and the client is
    expected to treat that as an answer rather than a failure — the map keeps
    the country's own name and draws nothing else.
    """
    found = subdivision_data.subdivisions(country)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No subdivisions for country {country!r}")
    return Response(content=found, media_type="application/json")
