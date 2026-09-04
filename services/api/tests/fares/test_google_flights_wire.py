"""
The request Google Flights is asked in, byte for byte.

The varint writer and the `?tfs=` protobuf built on it. It is a positional
encoding with no field names, so a wrong number does not fail — it asks a
different question and gets a plausible answer back, which is why the bytes are
pinned against the spec's own examples and against a query observed working.

Out of `test_fares.py`. What comes back is parsed in
`test_google_flights_parsing.py`.
"""

import base64

import pytest

from app.adapters import wire
from app.adapters.fares import google_flights
from app.adapters.fares.models import FareQuery

# --- protobuf writer -------------------------------------------------------


def test_varint_matches_the_spec_examples():
    assert wire.write_varint(1) == b"\x01"
    assert wire.write_varint(150) == b"\x96\x01"
    assert wire.write_varint(300) == b"\xac\x02"


def test_writer_round_trips_through_the_reader():
    """The two halves of `wire` must agree, or one of them is wrong."""
    message = wire.write_string(2, "LIM") + wire.write_varint_field(9, 1)
    fields = wire.read_message(message)
    assert wire.as_text(fields[2]) == "LIM"
    assert fields[9] == 1


def test_writer_refuses_a_negative_varint():
    with pytest.raises(wire.WireError):
        wire.write_varint(-1)


# --- tfs query building ----------------------------------------------------


def test_one_way_tfs_is_stable():
    """
    Pinned against a value captured from a working request on 2026-08-17.

    If this changes, every collected route silently starts searching for
    something other than what was asked for — which no other test would catch,
    because a wrong-but-valid query still returns flights.
    """
    tfs = google_flights.build_tfs(FareQuery("LIM", "SCL", "2026-10-16"))
    assert tfs == "GhoSCjIwMjYtMTAtMTZqBRIDTElNcgUSA1NDTEIBAUgBmAEC"


def test_round_trip_tfs_carries_both_legs_and_flips_the_trip_type():
    one_way = google_flights.build_tfs(FareQuery("LIM", "SCL", "2026-10-16"))
    returning = google_flights.build_tfs(
        FareQuery("LIM", "SCL", "2026-10-16", return_date="2026-10-23")
    )
    assert returning != one_way
    decoded = base64.b64decode(returning).decode("latin-1")
    assert "2026-10-23" in decoded
    assert decoded.count("SCL") == 2  # destination out, origin back


def test_airport_codes_are_normalised_into_the_query():
    lower = google_flights.build_tfs(FareQuery(" lim ", "scl", "2026-10-16"))
    upper = google_flights.build_tfs(FareQuery("LIM", "SCL", "2026-10-16"))
    assert lower == upper
