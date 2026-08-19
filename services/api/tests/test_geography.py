"""
Serving one country's subdivisions.

Against the real shipped files rather than a fixture, for the reason
`test_airport_search` gives: this is reference data that changes only when
somebody deliberately regenerates it, and what is worth defending is that the
countries this reader's routes actually touch come back with borders and names
on them. A three-shape fixture would never have caught a build that quietly
wrote 167 empty files.
"""

import itertools
import math

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.geography import SubdivisionsResponse
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


def test_the_catalogue_lists_every_country_that_has_a_file_and_no_others():
    body = client.get("/api/geography/subdivisions").json()["countries"]
    assert set(body) == set(subdivisions.available())
    assert WESTERN_SAHARA not in body


def test_the_catalogue_promises_the_number_of_bytes_that_actually_arrive():
    """
    The whole point of the index is that the client can spend a byte budget
    before the bytes are spent, so a number that were merely nearly right would
    be a budget that were merely nearly kept. It is exact because the endpoint
    serves the file rather than rebuilding it.
    """
    promised = client.get("/api/geography/subdivisions").json()["countries"]
    for country in (PERU, CHILE, UNITED_STATES):
        assert len(get(country).content) == promised[country], country


def test_the_catalogue_is_small_enough_to_fetch_before_deciding_anything():
    # 167 entries against the 6.4 MB they describe. Past a few kilobytes it
    # would be cheaper to guess.
    assert len(client.get("/api/geography/subdivisions").content) < 4_000


def test_a_countrys_file_still_matches_the_shape_the_endpoint_declares():
    """
    Serving the file verbatim takes the per-request validation out, so the
    contract is checked here instead — once, against the shipped data, which is
    where a build that wrote something malformed should be caught.
    """
    for country in (PERU, CHILE, SPAIN, UNITED_STATES, JAPAN):
        SubdivisionsResponse.model_validate_json(get(country).content)


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


def test_every_country_also_ships_its_own_outline_at_the_same_resolution():
    """
    The bundled atlas is 1:110m, whose median segment is 63 km — sixty-one
    pixels at the map's 32x ceiling, which reads as a straight line where a
    coast should be. So a country's own outline is served with the borders
    inside it, dissolved out of the same units, which is what guarantees the
    coast and the provincial borders meet: taken from `countries-50m` instead
    they would not, and every coastal province would hang off the edge of its
    own country.
    """
    for country in (PERU, CHILE, SPAIN, UNITED_STATES, JAPAN):
        objects = get(country).json()["borders"]["objects"]
        assert objects["land"]["type"] in ("MultiPolygon", "Polygon"), country
        assert objects["land"]["arcs"], country


def test_the_outline_covers_the_whole_country_and_not_just_its_mainland():
    # Chile runs from 17 degrees south to past 55, and an outline that stopped
    # at the mainland would drop Tierra del Fuego and the Juan Fernandez
    # islands - which are exactly the pieces the coarse atlas already loses.
    _, south, _, north = get(CHILE).json()["borders"]["bbox"]
    assert south < -54
    assert north > -18


def test_the_outline_and_the_borders_share_one_set_of_arcs():
    """
    One topology, not two. It halves what the coast costs where a provincial
    border runs down to it, and more to the point it is what makes the two
    meet exactly rather than nearly.
    """
    body = get(PERU).json()["borders"]
    used = set()

    def walk(arcs):
        if arcs and isinstance(arcs[0], int):
            used.update(index if index >= 0 else ~index for index in arcs)
        else:
            for nested in arcs:
                walk(nested)

    for obj in body["objects"].values():
        walk(obj["arcs"])
    # Every arc in the file is reached by one of the two objects: the build
    # prunes the rest, which for Chile was 93% of them.
    assert used == set(range(len(body["arcs"])))


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


def _decode(topology) -> list[list[list[float]]]:
    """TopoJSON delta-encoded arcs, back to longitude and latitude."""
    scale_x, scale_y = topology["transform"]["scale"]
    shift_x, shift_y = topology["transform"]["translate"]
    arcs = []
    for arc in topology["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            x += dx
            y += dy
            points.append([x * scale_x + shift_x, y * scale_y + shift_y])
        arcs.append(points)
    return arcs


def _segments_km(topology) -> list[float]:
    lengths = []
    for arc in _decode(topology):
        for (lon1, lat1), (lon2, lat2) in itertools.pairwise(arc):
            phi1, phi2 = math.radians(lat1), math.radians(lat2)
            haversine = (
                math.sin((phi2 - phi1) / 2) ** 2
                + math.cos(phi1) * math.cos(phi2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
            )
            km = 2 * math.asin(min(1.0, math.sqrt(haversine))) * 6371
            if km > 0:
                lengths.append(km)
    return sorted(lengths)


# The map's zoom stops at 32x on a stage at least 460px on its short side, so
# the globe's radius never passes 0.42 x 460 x 32 = 6182px and one pixel is
# 6371 / 6182 km of ground.
KM_PER_PIXEL_AT_FULL_ZOOM = 6371 / (0.42 * 460 * 32)


@pytest.mark.parametrize("country", [PERU, CHILE, SPAIN, UNITED_STATES, JAPAN])
def test_the_geometry_is_cut_fine_enough_for_the_zoom_the_map_allows(country):
    """
    The data and the zoom ceiling have to be regenerated together, and this is
    what says so if they are not.

    A vertex spacing of a few pixels is a visibly faceted coastline. The
    threshold this ships at leaves the median segment at 1.5-2.2 km against
    1.03 km to the pixel; the 1e-8 it was cut at when zoom stopped at 8x gives
    about 3.3 km, which is three pixels and plainly polygonal. Three is the
    line: past it, somebody has rebuilt coarser than the map can now show.
    """
    segments = _segments_km(get(country).json()["borders"])
    median = segments[len(segments) // 2]
    assert median / KM_PER_PIXEL_AT_FULL_ZOOM < 3.0, f"{country}: {median:.2f} km a segment"


def test_the_source_is_the_floor_and_the_data_sits_just_above_it():
    """
    Not cut finer than the source can carry, either. Raw 1:10m Natural Earth
    measures 2.61 km to a segment on average and 1.62 km at the median, so a
    file whose median came out far under a kilometre would mean the build had
    started inventing vertices rather than keeping them.
    """
    segments = _segments_km(get(PERU).json()["borders"])
    assert 0.5 < segments[len(segments) // 2] < 4.0


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
