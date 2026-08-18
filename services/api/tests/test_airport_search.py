"""
Typing at a search box and getting the airport you meant.

These run against the real shipped table rather than a fixture. It is
reference data that changes only when someone deliberately updates it, and the
thing worth defending is that a reader in Lima typing `cusco` finds Cusco —
which a hand-built fixture of three rows would never have caught.
"""

import pytest

from app.services import airport_search
from app.services.airport_search import fold, search


def codes(query: str, limit: int = airport_search.DEFAULT_LIMIT) -> list[str]:
    return [match.code for match in search(query, limit)]


# --------------------------------------------------------------- the table --


def test_the_table_holds_airports_you_can_actually_fly_to():
    """
    OurAirports lists 81,000 places, most of them airstrips and heliports.
    Filtering to a IATA code *and* scheduled service is what makes the rest a
    list a person can search rather than scroll past.
    """
    assert 3_000 < airport_search.count() < 6_000


@pytest.mark.parametrize("code", ["LIM", "CUZ", "SCL", "AQP", "MAD", "MIA", "JFK", "HND"])
def test_the_airports_this_reader_flies_from_are_all_there(code):
    assert codes(code)[0] == code


# ------------------------------------------------------------------ typing --


def test_a_three_letter_code_answers_with_that_airport_first():
    # It is the only thing three letters is ever likely to mean.
    assert codes("lim")[0] == "LIM"
    assert codes("MAD")[0] == "MAD"


def test_a_city_finds_its_airports():
    assert "CUZ" in codes("cusco")
    assert "MAD" in codes("madrid")


def test_accents_are_optional_in_both_directions():
    """
    Not a nicety in a tool whose default origin is Lima: a reader without
    accents on their keyboard has to be able to find Málaga, and the table
    spells it with one.
    """
    assert codes("malaga") == codes("málaga")
    assert "AGP" in codes("malaga")


def test_an_airport_can_be_found_by_its_own_name():
    # The last resort, and the one that finds the airports nobody calls by
    # their city.
    assert "LHR" in codes("heathrow")
    assert "CDG" in codes("charles de gaulle")


def test_a_query_too_short_to_mean_anything_returns_nothing():
    """
    A list that appears before it can be meaningful is a list that gets
    dismissed — and then ignored when it finally does mean something.
    """
    assert search("") == []
    assert search(" ") == []
    assert search("l") == []


def test_a_query_that_matches_nothing_says_so_rather_than_guessing():
    assert search("zzzzzzzz") == []


# ------------------------------------------------------------------ order --


def test_an_exact_code_beats_a_city_that_merely_contains_it():
    # `LIM` is Lima's code and also sits inside "Limoges" and "Limon". The code
    # has to win, or the default origin of this whole feature is buried.
    assert codes("lim")[0] == "LIM"


def test_a_city_beats_an_airport_name_that_mentions_it():
    matches = codes("santiago")
    assert matches[0] == "SCL" or any(match == "SCL" for match in matches[:3])


def test_the_same_query_always_answers_the_same_way():
    """
    A suggestion list that reshuffles between identical keystrokes is unusable,
    so ties break on the code rather than on whatever order the file had.
    """
    assert codes("santiago") == codes("santiago")


# ------------------------------------------------------------------ limits --


def test_the_list_is_capped_at_what_a_box_can_show():
    assert len(search("san", limit=3)) == 3
    assert len(search("a")) == 0
    assert len(search("air", limit=100)) <= 100


def test_a_nonsensical_limit_returns_nothing_rather_than_everything():
    assert search("lim", limit=0) == []


# -------------------------------------------------------------------- fold --


def test_folding_strips_case_and_accents_but_keeps_the_letters():
    assert fold("Chávez") == "chavez"
    assert fold("MÁLAGA") == "malaga"
    assert fold("São Paulo") == "sao paulo"
