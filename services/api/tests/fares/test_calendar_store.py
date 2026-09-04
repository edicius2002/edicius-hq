"""
What `FareCalendar` writes, and the year read back out of several curves.

`FareCalendar.horizon` against the shapes the collector actually produces. The
fault each test names is the fault, not the function: a chart that lost five
months the archive still held is what any of these failing would mean.

Out of `test_fares_calendar.py`, and almost autonomous — a curve, a window and
a temporary directory.
"""

import json
import logging
from datetime import UTC, datetime

from conftest import curve

from app.adapters.fares.models import CalendarPrice
from app.services.fare_calendar import CalendarCurve, FareCalendar
from app.services.fare_history import FareHistory

# --- the store ---------------------------------------------------------------


def test_a_curve_round_trips_through_the_store(tmp_path):
    store = FareCalendar(tmp_path)
    store.append(curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87)]))

    read = store.read("LIM", "CUZ")
    assert len(read) == 1
    assert [(p.departure_date, p.price) for p in read[0].prices] == [("2026-12-09", 59.87)]
    assert (read[0].start, read[0].end) == ("2026-08-19", "2027-07-15")


def test_a_day_with_no_flights_survives_the_round_trip_as_a_null(tmp_path):
    """
    Written as `null`, read back as `None`, and never as a zero.

    A zero would draw a free flight; dropping the key would lose the difference
    between a day nobody flies and a day the collection never reached.
    """
    store = FareCalendar(tmp_path)
    store.append(
        curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", None), ("2026-12-10", 60.0)])
    )
    read = store.read("LIM", "CUZ")[0]
    assert [(p.departure_date, p.price) for p in read.prices] == [
        ("2026-12-09", None),
        ("2026-12-10", 60.0),
    ]
    assert read.cheapest.price == 60.0


def test_the_window_asked_for_is_stored_beside_the_prices(tmp_path):
    """
    Which is what makes a missing date readable as a gap rather than as a date
    nobody wanted. Without `from` and `to` the file cannot say the difference.
    """
    store = FareCalendar(tmp_path)
    store.append(curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87)]))
    row = json.loads((tmp_path / "LIM-CUZ.jsonl").read_text(encoding="utf-8"))
    assert row["from"] == "2026-08-19" and row["to"] == "2027-07-15"
    assert row["prices"] == {"2026-12-09": 59.87}


def test_an_unchanged_curve_is_not_written_a_second_time(tmp_path):
    """
    Measured on the first real curve — ARI-SCL, 331 dates, 7,145 bytes — a
    by-the-clock daily write is 2.6 MB a route a year of lines that mostly say
    nothing. Same rule as 12.16, one level up from a board.
    """
    store = FareCalendar(tmp_path)
    same = [("2026-12-09", 59.87), ("2026-12-10", 60.0)]
    assert store.append_if_changed(curve("2026-08-19T12:00:00+00:00", prices=same)) is True
    assert store.append_if_changed(curve("2026-08-20T12:00:00+00:00", prices=same)) is False
    assert len(store.read("LIM", "CUZ")) == 1

    moved = [("2026-12-09", 59.87), ("2026-12-10", 71.0)]
    assert store.append_if_changed(curve("2026-08-21T12:00:00+00:00", prices=moved)) is True
    assert len(store.read("LIM", "CUZ")) == 2


def test_a_day_losing_its_last_flight_counts_as_the_curve_changing(tmp_path):
    """A price going away is news, and a fingerprint that ignored it would hide it."""
    store = FareCalendar(tmp_path)
    store.append_if_changed(curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87)]))
    assert (
        store.append_if_changed(curve("2026-08-20T12:00:00+00:00", prices=[("2026-12-09", None)]))
        is True
    )


def test_the_curves_live_beside_the_boards_and_not_among_them(tmp_path):
    """
    Why this is not a fifth kind of file inside `FareHistory` — the reason is
    `last_checked()`, which is the board scheduler's own input and reads that
    directory. A curve is keyed by `capturedAt` where every file there is keyed
    by `flightDate`, and the board collection is not touched by this feature.
    """
    from app.adapters.fares.models import FareSnapshot

    history = FareHistory(tmp_path)
    history.append(
        FareSnapshot(
            captured_at="2026-08-19T12:00:00+00:00",
            source="google-flights",
            origin="LIM",
            destination="CUZ",
            flight_date="2027-03-09",
            return_date=None,
            currency="USD",
            offers=[],
        )
    )
    store = FareCalendar(tmp_path / "calendar")
    store.append(curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87)]))

    assert [path.name for path in sorted(tmp_path.glob("*.jsonl"))] == ["LIM-CUZ.jsonl"]
    assert history.last_checked() == {}
    assert history.read("LIM", "CUZ")[0].flight_date == "2027-03-09"
    assert len(store.read("LIM", "CUZ")) == 1


def test_a_hostile_route_code_cannot_escape_the_calendar_directory(tmp_path):
    """The one guard that must never be a second copy: `route_stem` is imported."""
    store = FareCalendar(tmp_path)
    store.append(
        curve("2026-08-19T12:00:00+00:00", prices=[], origin="../../etc", destination="p/w")
    )
    written = list(tmp_path.rglob("*.jsonl"))
    assert len(written) == 1
    assert written[0].parent == tmp_path


def test_a_corrupt_curve_costs_that_line_and_nothing_else(tmp_path):
    store = FareCalendar(tmp_path)
    store.append(curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87)]))
    with (tmp_path / "LIM-CUZ.jsonl").open("a", encoding="utf-8") as handle:
        handle.write("{ not json\n")
    store.append(curve("2026-08-20T12:00:00+00:00", prices=[("2026-12-09", 60.0)]))
    assert len(store.read("LIM", "CUZ")) == 2


def test_a_calendar_file_nobody_can_read_is_an_error_not_a_warning(tmp_path, caplog):
    """One bad line is a bad line; every bad line is a format change."""
    (tmp_path / "LIM-CUZ.jsonl").write_text('{"nope": 1}\n{"also": 2}\n', encoding="utf-8")
    with caplog.at_level(logging.ERROR):
        assert FareCalendar(tmp_path).read("LIM", "CUZ") == []
    assert "format has probably changed" in caplog.text


def test_the_store_decides_what_is_stale(tmp_path):
    """
    The collector asks and does not remember. Same division `due_now` and
    `last_checked` already draw for the boards.
    """
    store = FareCalendar(tmp_path)
    now = datetime(2026, 8, 19, 12, 0, tzinfo=UTC)
    assert store.due("LIM", "CUZ", now, every_minutes=1440) is True

    store.record_check("LIM", "CUZ", at="2026-08-19T06:00:00+00:00", outcome="unchanged")
    assert store.due("LIM", "CUZ", now, every_minutes=1440) is False
    assert store.due("LIM", "CUZ", now, every_minutes=60) is True


# --- reading the year back out of several curves -----------------------------
#
# `FareCalendar.horizon` against the shapes the collector actually produces. The
# fault each one names is the fault, not the function: a chart that lost five
# months the archive still held is what any of these failing would mean.


def window(captured_at: str, start: str, end: str, *, prices) -> CalendarCurve:
    """A curve that states its own window, which is what makes 12.154 legible."""
    return CalendarCurve(
        captured_at=captured_at,
        source="google-flights",
        origin="LIM",
        destination="CUZ",
        currency="USD",
        start=start,
        end=end,
        prices=[CalendarPrice(departure_date=day, price=price) for day, price in prices],
    )


def test_the_far_end_survives_a_curve_that_stopped_short(tmp_path):
    """
    The fault the owner saw: a refusal today took months off the chart.

    Yesterday priced the year to July. Today the provider refused the far window
    and the collector walked its end back to February — honest on disk, and it
    used to be the whole answer, so five months of departure dates left the
    chart while the longer curve sat beside it in the same file.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-20T12:00:00+00:00",
            "2026-08-20",
            "2027-07-16",
            prices=[("2026-09-01", 120.0), ("2027-03-01", 300.0), ("2027-07-01", 410.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert [(point.departure_date, point.price) for point in horizon.prices] == [
        ("2026-09-01", 118.0),
        ("2027-03-01", 300.0),
        ("2027-07-01", 410.0),
    ]
    # The far end is still reachable, and the near end has moved on with the
    # newest curve rather than reaching back to a departure that has gone.
    assert (horizon.start, horizon.end) == ("2026-08-21", "2027-07-16")


def test_an_inherited_price_says_when_it_was_seen_rather_than_passing_for_today(tmp_path):
    """
    The quiet lie this merge would otherwise tell.

    A price carried over from an older curve is on screen beside one collected
    minutes ago. Without a stamp of its own the reader has no way to tell them
    apart, and a three-day-old fare reads as today's.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-18T09:00:00+00:00",
            "2026-08-18",
            "2027-07-14",
            prices=[("2026-09-01", 120.0), ("2027-06-01", 400.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    stamps = {point.departure_date: point.observed_at for point in horizon.prices}
    assert stamps["2026-09-01"] == "2026-08-21T12:00:00+00:00"
    assert stamps["2027-06-01"] == "2026-08-18T09:00:00+00:00"
    # And the answer's own stamp is the freshest thing in it, never spread over
    # the June price three days behind it.
    assert horizon.captured_at == "2026-08-21T12:00:00+00:00"


def test_a_date_with_no_flights_is_not_overwritten_by_an_older_price(tmp_path):
    """
    12.154, surviving the merge: answered-and-empty beats never-answered.

    The provider answered about 2026-09-02 today and had nothing to sell, which
    is a real answer and the newest one. Merging on "is the price null" instead
    of "did this curve answer" would have filled it from last week and invented
    a fare out of two true facts.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-18T09:00:00+00:00",
            "2026-08-18",
            "2027-07-14",
            prices=[("2026-09-02", 150.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-02", None)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert [(point.departure_date, point.price) for point in horizon.prices] == [
        ("2026-09-02", None)
    ]
    assert horizon.prices[0].observed_at == "2026-08-21T12:00:00+00:00"


def test_a_date_no_curve_ever_answered_for_stays_absent(tmp_path):
    """
    The other half of 12.154: a gap in our collection is still a gap.

    2027-01-01 is inside the merged window and no curve holds it, so it must not
    appear at all. A merge that filled every date in the window with a `null`
    would turn "nobody looked" into "nothing flies", which is the absence the
    window exists to keep separate.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-20T12:00:00+00:00",
            "2026-08-20",
            "2027-07-16",
            prices=[("2026-09-01", 120.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0), ("2027-02-01", 260.0)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert [point.departure_date for point in horizon.prices] == ["2026-09-01", "2027-02-01"]
    # Inside the window and answered for by nobody, which the window is what
    # makes readable.
    assert horizon.start <= "2027-01-01" <= horizon.end


def test_a_departure_that_has_already_gone_is_not_carried_forward(tmp_path):
    """
    The near end moves for a different reason than the far end, and is not repaired.

    A window starts at today, so an older curve reaches back to departures that
    have since happened. Inheriting those would put unbookable flights on the
    chart and would grow this answer by a date a day forever.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-18T09:00:00+00:00",
            "2026-08-18",
            "2027-07-14",
            prices=[("2026-08-18", 80.0), ("2026-09-01", 120.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert [point.departure_date for point in horizon.prices] == ["2026-09-01"]
    assert horizon.start == "2026-08-21"


def test_three_curves_are_read_newest_first_rather_than_last_writer_wins(tmp_path):
    """
    Order is by `capturedAt`, not by position in the file, and each date is
    settled by the newest curve that answered for it — not by the newest curve
    that answered for anything.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-19T09:00:00+00:00",
            "2026-08-19",
            "2027-07-15",
            prices=[("2026-09-01", 130.0), ("2027-05-01", 350.0), ("2027-07-10", 500.0)],
        )
    )
    store.append(
        window(
            "2026-08-20T09:00:00+00:00",
            "2026-08-20",
            "2027-07-16",
            prices=[("2026-09-01", 125.0), ("2027-05-01", 345.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T09:00:00+00:00",
            "2026-08-21",
            "2027-07-17",
            prices=[("2026-09-01", 118.0)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert [(point.departure_date, point.price, point.observed_at) for point in horizon.prices] == [
        ("2026-09-01", 118.0, "2026-08-21T09:00:00+00:00"),
        ("2027-05-01", 345.0, "2026-08-20T09:00:00+00:00"),
        ("2027-07-10", 500.0, "2026-08-19T09:00:00+00:00"),
    ]


def test_one_curve_reads_back_as_itself(tmp_path):
    """
    The ordinary case, which is most of them: nothing to merge, nothing changed.

    Worth pinning because the merge is the only path now, so a pair collected
    once has to come back exactly as it went in — every price stamped with the
    one capture time, and the window untouched.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0), ("2026-09-02", None)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert horizon.captured_at == "2026-08-21T12:00:00+00:00"
    assert (horizon.start, horizon.end) == ("2026-08-21", "2027-07-16")
    assert all(point.observed_at == horizon.captured_at for point in horizon.prices)
    assert [(point.departure_date, point.price) for point in horizon.prices] == [
        ("2026-09-01", 118.0),
        ("2026-09-02", None),
    ]


def test_a_pair_with_no_curves_has_no_horizon(tmp_path):
    assert FareCalendar(tmp_path).horizon("LIM", "CUZ") is None


def test_nothing_is_merged_on_the_way_in(tmp_path):
    """
    The archive stays a record of what was observed when.

    A short curve after a long one is stored short. If a write ever started
    merging, the file would stop being able to answer "what did we see that
    day", and no later reader could separate the two again.
    """
    store = FareCalendar(tmp_path)
    store.append_if_changed(
        window(
            "2026-08-20T12:00:00+00:00",
            "2026-08-20",
            "2027-07-16",
            prices=[("2026-09-01", 120.0), ("2027-07-01", 410.0)],
        )
    )
    store.append_if_changed(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0)],
        )
    )

    stored = store.read("LIM", "CUZ")
    assert [len(curve.prices) for curve in stored] == [2, 1]
    assert stored[-1].prices[0].departure_date == "2026-09-01"
