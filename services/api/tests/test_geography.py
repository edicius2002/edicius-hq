"""
Serving one country's subdivisions.

Against the real shipped files rather than a fixture, for the reason
`test_airport_search` gives: this is reference data that changes only when
somebody deliberately regenerates it, and what is worth defending is that the
countries this reader's routes actually touch come back with borders and names
on them. A three-shape fixture would never have caught a build that quietly
wrote 167 empty files.
"""

from fastapi.testclient import TestClient

from app.main import app
from app.services import subdivisions

client = TestClient(app)

# The countries this reader's routes touch, plus two large ones.
PERU = "604"
CHILE = "152"
SPAIN = "724"
UNITED_STATES = "840"
JAPAN = "392"
# Natural Earth's admin-1 does not divide it, so it has no file at all.
WESTERN_SAHARA = "732"


def get(country: str):
    return client.get(f"/api/geography/subdivisions/{country}")


# ---------------------------------------------------------------- the data --


def test_most_of_the_world_the_map_draws_has_subdivisions_to_show():
    # 167 of the 177 shapes the bundled outlines carry. Well under that and the
    # build dropped countries; a number at 177 would mean it invented some.
    assert 150 < len(subdivisions.available()) < 177


def test_the_countries_this_readers_routes_touch_all_have_borders_and_names():
    for country in (PERU, CHILE, SPAIN, UNITED_STATES, JAPAN):
        body = get(country).json()
        assert body["borders"]["arcs"], country
        assert body["labels"], country


def test_perus_departments_come_back_by_their_own_names():
    names = {label["name"] for label in get(PERU).json()["labels"]}
    assert {"Loreto", "Cusco", "Arequipa", "Lima"} <= names


def test_a_subdivision_carries_where_its_name_goes_and_how_much_ground_it_has():
    """
    The map needs both: `at` to place the name and `area` to decide whether
    there is room for it at this zoom — the same pair a country label carries.
    """
    loreto = next(label for label in get(PERU).json()["labels"] if label["name"] == "Loreto")
    longitude, latitude = loreto["at"]
    assert -80 < longitude < -68
    assert -8 < latitude < 2
    # Steradians. Loreto is 369,000 km² against the Earth's 4π x 6371².
    assert 0.005 < loreto["area"] < 0.02


def test_the_biggest_subdivision_is_offered_first():
    """
    The order is the answer to two names landing on the same patch of screen:
    the bigger place keeps the ground, and `withoutOverlaps` reads them in the
    order they arrive.
    """
    areas = [label["area"] for label in get(UNITED_STATES).json()["labels"]]
    assert areas == sorted(areas, reverse=True)


def test_only_the_borders_between_two_subdivisions_are_shipped():
    """
    The coastline is already on screen, drawn from the bundled 1:110m outlines,
    and a second one four hundred times finer would not agree with the first.
    Meshing away the outer edge is also where the bytes went: Chile is 6.7 kB
    of Andean border where the whole polygon set was 96 kB of fjord.
    """
    chile = get(CHILE).json()
    assert chile["borders"]["objects"]["borders"]["type"] == "MultiLineString"
    # Chile spans 56 degrees of latitude; its internal borders do not reach
    # anything like the ends of it, because the ends are coast.
    _, south, _, north = chile["borders"]["bbox"]
    assert north - south < 45


# ------------------------------------------------------------- the fallback --


def test_a_country_natural_earth_does_not_divide_answers_404():
    """
    404 rather than an empty body, so the client can tell "there is nothing
    here" from "here is nothing" — and so a build that stopped writing files
    fails loudly instead of serving blanks.
    """
    assert get(WESTERN_SAHARA).status_code == 404
    assert subdivisions.subdivisions(WESTERN_SAHARA) is None


def test_a_country_that_is_not_a_country_code_is_refused_before_it_reaches_a_path():
    """
    This string names a file. Three digits is the whole of what a country code
    can be, and anything else is turned away by the route rather than by a
    check somebody can forget to write.
    """
    for nonsense in ("..", "../../etc/passwd", "6041", "abc", "60"):
        assert client.get(f"/api/geography/subdivisions/{nonsense}").status_code in (404, 422)
    assert subdivisions.subdivisions("../secrets") is None
