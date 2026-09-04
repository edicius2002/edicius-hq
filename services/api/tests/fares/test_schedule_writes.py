"""
What a finished poll writes: a snapshot only on a change, a heartbeat always.

The other half of the measurement in `test_schedule_cadence.py`. Writing a
snapshot every time would fill the archive with copies of itself, and writing
nothing when nothing moved would leave a stretch of archive with no snapshots
indistinguishable from a stretch with no collector — so the heartbeat goes down
every single time, and the baseline is what the two are read against.

Out of `test_fares_schedule.py`. `offer` and `snapshot` are local rather than
taken from `conftest`: that pair has the same two names and a different shape,
and bolting the two signatures together would be worse than the homonym.
"""

import json

from app.adapters.fares.models import FareInsights, FareOffer, FareSnapshot, PricePoint
from app.services.fare_history import BaselinePoint, FareHistory


def offer(price: float, *, airline: str = "LA", number: str = "529", at: str = "2026-10-17T08:00"):
    return FareOffer(
        airline=airline,
        airline_name="LATAM",
        flight_number=number,
        departure_at=at,
        arrival_at=None,
        transfers=0,
        duration_minutes=120,
        price=price,
        currency="USD",
    )


def snapshot(*offers, captured_at="2026-08-18T12:00:00+00:00", flight_date="2026-10-17"):
    return FareSnapshot(
        captured_at=captured_at,
        source="google-flights",
        origin="LIM",
        destination="CUZ",
        flight_date=flight_date,
        return_date=None,
        currency="USD",
        offers=list(offers),
    )


# ------------------------------------------------------- writing on change ----


def test_the_first_snapshot_is_always_written(tmp_path):
    history = FareHistory(tmp_path)
    assert history.append_if_changed(snapshot(offer(100.0))) is True
    assert len(history.read("LIM", "CUZ")) == 1


def test_an_identical_board_is_not_written_again(tmp_path):
    """
    Four of five real snapshots were byte-identical to the one before. At a
    half-hourly cadence a by-the-clock archive is mostly copies of itself.
    """
    history = FareHistory(tmp_path)
    history.append_if_changed(snapshot(offer(100.0)))
    assert (
        history.append_if_changed(snapshot(offer(100.0), captured_at="2026-08-18T12:30:00+00:00"))
        is False
    )
    assert len(history.read("LIM", "CUZ")) == 1


def test_a_moved_price_is_written(tmp_path):
    history = FareHistory(tmp_path)
    history.append_if_changed(snapshot(offer(100.0)))
    assert (
        history.append_if_changed(snapshot(offer(87.0), captured_at="2026-08-18T12:30:00+00:00"))
        is True
    )
    assert [s.cheapest.price for s in history.read("LIM", "CUZ")] == [100.0, 87.0]


def test_a_flight_appearing_or_leaving_counts_as_a_change(tmp_path):
    history = FareHistory(tmp_path)
    history.append_if_changed(snapshot(offer(100.0)))
    two = snapshot(
        offer(100.0), offer(150.0, number="530"), captured_at="2026-08-18T13:00:00+00:00"
    )
    assert history.append_if_changed(two) is True


def test_two_departures_on_one_route_are_two_series(tmp_path):
    """A change in October is not a change in December, even in one file."""
    history = FareHistory(tmp_path)
    history.append_if_changed(snapshot(offer(100.0), flight_date="2026-10-17"))
    assert history.append_if_changed(snapshot(offer(100.0), flight_date="2026-12-16")) is True


def test_the_fingerprint_ignores_when_it_was_captured(tmp_path):
    history = FareHistory(tmp_path)
    a = snapshot(offer(100.0), captured_at="2026-08-18T12:00:00+00:00")
    b = snapshot(offer(100.0), captured_at="2026-08-19T04:00:00+00:00")
    assert history.fingerprint(a) == history.fingerprint(b)


def test_a_fingerprint_written_by_an_older_reader_is_recognised_as_such(tmp_path):
    """
    Otherwise a change to the parser reads as a change to the fares.

    Reading Google's best-departing block added offers to every watched route
    at once, so the next poll after it ships differs from the stored
    fingerprint on all of them for a reason no airline had anything to do with.
    A state file written before the recipe was numbered carries a bare digest,
    which is what this recognises.
    """
    history = FareHistory(tmp_path)
    board = snapshot(offer(100.0))
    history.append_if_changed(board)
    assert history.is_rebaseline(board) is False

    (tmp_path / "state" / "LIM-CUZ.json").write_text(
        json.dumps({"2026-10-17": "0123456789abcdef"}), encoding="utf-8"
    )
    assert history.is_rebaseline(board) is True


def test_a_departure_never_seen_before_is_not_a_rebaseline(tmp_path):
    """A first observation is news about the route, not news about the reader."""
    history = FareHistory(tmp_path)
    assert history.is_rebaseline(snapshot(offer(100.0))) is False


def test_insights_drifting_alone_is_not_a_fare_change(tmp_path):
    """Otherwise every poll would look like news."""
    history = FareHistory(tmp_path)
    first = snapshot(offer(100.0))
    history.append_if_changed(first)
    second = FareSnapshot(
        captured_at="2026-08-18T13:00:00+00:00",
        source=first.source,
        origin=first.origin,
        destination=first.destination,
        flight_date=first.flight_date,
        return_date=None,
        currency=first.currency,
        offers=first.offers,
        insights=FareInsights(typical=48.0, usual_low=35.0, usual_high=50.0),
    )
    assert history.append_if_changed(second) is False


def test_insights_survive_a_round_trip_through_the_file(tmp_path):
    history = FareHistory(tmp_path)
    written = FareSnapshot(
        captured_at="2026-08-18T12:00:00+00:00",
        source="google-flights",
        origin="LIM",
        destination="CUZ",
        flight_date="2026-10-17",
        return_date=None,
        currency="USD",
        offers=[offer(100.0)],
        insights=FareInsights(typical=48.0, usual_low=35.0, usual_high=50.0),
    )
    history.append(written)
    (read,) = history.read("LIM", "CUZ")
    assert read.insights == written.insights


# --------------------------------------------------------------- heartbeats --


def test_a_quiet_week_is_distinguishable_from_a_dead_collector(tmp_path):
    """
    The point of the heartbeat. Without it, an archive with no new snapshots
    means either no price movement or no collector, and nothing in the file
    says which.
    """
    history = FareHistory(tmp_path)
    for hour in range(4):
        history.record_check(
            "LIM",
            "CUZ",
            "2026-10-17",
            at=f"2026-08-18T{12 + hour:02d}:00:00+00:00",
            outcome="unchanged",
            offers=29,
        )
    checks = history.checks("LIM", "CUZ")
    assert len(checks) == 4
    assert history.read("LIM", "CUZ") == []
    assert history.last_checked()[("LIM", "CUZ", "2026-10-17")] == "2026-08-18T15:00:00+00:00"


def test_a_refusal_is_recorded_as_a_look_too(tmp_path):
    history = FareHistory(tmp_path)
    history.record_check(
        "LIM",
        "CUZ",
        "2026-10-17",
        at="2026-08-18T12:00:00+00:00",
        outcome="error",
        error_code="blocked",
    )
    (row,) = history.checks("LIM", "CUZ")
    assert row["outcome"] == "error" and row["errorCode"] == "blocked"


def test_a_heartbeat_file_never_looks_like_a_route(tmp_path):
    """`routes()` globs the archive directory; the checks live below it."""
    history = FareHistory(tmp_path)
    history.record_check(
        "LIM", "CUZ", "2026-10-17", at="2026-08-18T12:00:00+00:00", outcome="unchanged"
    )
    assert history.routes() == []


# ----------------------------------------------------------------- baseline --


def test_the_provider_history_is_kept_apart_from_our_snapshots(tmp_path):
    """
    One rounded integer a day with no airline and no departure time. Beside our
    observations it is two months of context; on the same line it would quietly
    change what the line measures.
    """
    history = FareHistory(tmp_path)
    points = [PricePoint("2026-06-19", 46.0), PricePoint("2026-06-20", 44.0)]
    added = history.merge_baseline(
        "LIM", "CUZ", "2026-10-17", points, source="google-flights-history", currency="USD"
    )
    assert added == 2
    assert history.read_baseline("LIM", "CUZ", "2026-10-17") == [
        BaselinePoint("2026-10-17", "2026-06-19", 46.0),
        BaselinePoint("2026-10-17", "2026-06-20", 44.0),
    ]
    assert history.read("LIM", "CUZ") == []


def test_merging_keeps_days_the_provider_has_since_forgotten(tmp_path):
    """
    The window rolls: sixty days from now, today's points are outside it and
    survive only here. Replacing would lose exactly the part worth keeping.
    """
    history = FareHistory(tmp_path)
    history.merge_baseline(
        "LIM",
        "CUZ",
        "2026-10-17",
        [PricePoint("2026-06-19", 46.0)],
        source="google-flights-history",
        currency="USD",
    )
    added = history.merge_baseline(
        "LIM",
        "CUZ",
        "2026-10-17",
        [PricePoint("2026-08-18", 60.0)],
        source="google-flights-history",
        currency="USD",
    )
    assert added == 1
    assert [p.date for p in history.read_baseline("LIM", "CUZ", "2026-10-17")] == [
        "2026-06-19",
        "2026-08-18",
    ]


def test_a_day_answered_twice_is_updated_rather_than_duplicated(tmp_path):
    history = FareHistory(tmp_path)
    for price in (46.0, 48.0):
        history.merge_baseline(
            "LIM",
            "CUZ",
            "2026-10-17",
            [PricePoint("2026-06-19", price)],
            source="google-flights-history",
            currency="USD",
        )
    assert history.read_baseline("LIM", "CUZ", "2026-10-17") == [
        BaselinePoint("2026-10-17", "2026-06-19", 48.0)
    ]


def test_two_departures_keep_separate_baselines(tmp_path):
    """Verified live: two dates on one route return different histories."""
    history = FareHistory(tmp_path)
    history.merge_baseline(
        "LIM", "CUZ", "2026-10-17", [PricePoint("2026-06-19", 46.0)], source="s", currency="USD"
    )
    history.merge_baseline(
        "LIM", "CUZ", "2026-12-16", [PricePoint("2026-06-19", 57.0)], source="s", currency="USD"
    )
    assert history.read_baseline("LIM", "CUZ", "2026-10-17")[0].price == 46.0
    assert history.read_baseline("LIM", "CUZ", "2026-12-16")[0].price == 57.0
    assert history.has_baseline("LIM", "CUZ", "2026-10-17")
    assert not history.has_baseline("LIM", "CUZ", "2027-01-01")


def test_a_month_of_baselines_can_be_read_as_a_month(tmp_path):
    """
    The archive did not have to move for 12.110 — 12.112.

    It was already keyed by departure inside a file named for the city pair, so
    a watched month is only more departures in the same file. All the read side
    needed was a prefix, and `2026-10` is a prefix of every departure in
    October the way `2026-10-17` is a prefix of one of them.
    """
    history = FareHistory(tmp_path)
    for departure, price in (("2026-10-17", 46.0), ("2026-10-18", 51.0), ("2026-11-02", 57.0)):
        history.merge_baseline(
            "LIM", "CUZ", departure, [PricePoint("2026-06-19", price)], source="s", currency="USD"
        )

    october = history.read_baseline("LIM", "CUZ", "2026-10")
    assert sorted(point.price for point in october) == [46.0, 51.0]
    # One day of it still reads as one day.
    assert history.read_baseline("LIM", "CUZ", "2026-10-17")[0].price == 46.0
    # And the whole pair still reads as the whole pair.
    assert len(history.read_baseline("LIM", "CUZ")) == 3


def test_health_counts_only_the_month_being_asked_about(tmp_path):
    """
    A pair watched across two months must not report April's looks under
    March's heading — the figure the reader trusts a series by would be
    counting a series they are not looking at.
    """
    history = FareHistory(tmp_path)
    history.record_check("LIM", "CUZ", "2026-10-17", at="2026-08-18T12:00:00+00:00", outcome="ok")
    history.record_check("LIM", "CUZ", "2026-10-18", at="2026-08-18T12:00:06+00:00", outcome="ok")
    history.record_check("LIM", "CUZ", "2026-11-02", at="2026-08-18T12:00:12+00:00", outcome="ok")

    assert len(history.checks("LIM", "CUZ", "2026-10")) == 2
    assert len(history.checks("LIM", "CUZ", "2026-10-17")) == 1
    assert len(history.checks("LIM", "CUZ")) == 3
