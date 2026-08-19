"""
When a departure is due, what gets written, and what a quiet week looks like.

The rules under test all exist because of the same measurement. On 2026-08-18
two real snapshots taken 23 seconds apart were identical, and so were two taken
8 minutes apart; the first change appeared across 11.5 hours, where 3 of 25
flights moved. Meanwhile a fare 14 days out moved on 27% of days by a median
14%, and one 150 days out moved on 22% of days by 1.7%.

So: poll near departures often and far ones rarely, write a snapshot only when
something moved, and write a heartbeat every single time — because a stretch of
archive with no snapshots has to be distinguishable from a stretch with no
collector.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from app.adapters.fares.models import FareInsights, FareOffer, FareQuery, FareSnapshot, PricePoint
from app.config import MAX_DEPARTURE_HORIZON_DAYS, MAX_POLL_MINUTES, MIN_POLL_MINUTES
from app.services.fare_collector import collect, collect_due
from app.services.fare_history import FareHistory
from app.services.fare_schedule import (
    clamp_minutes,
    days_until,
    due_now,
    poll_minutes,
    within_horizon,
)

NOW = datetime(2026, 8, 18, 12, 0, tzinfo=UTC)
TODAY = NOW.date()


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


# ------------------------------------------------------------------ cadence --


@pytest.mark.parametrize(
    ("days_out", "expected"),
    [(0, 30), (14, 30), (15, 60), (45, 60), (46, 240), (120, 240), (121, 1440), (330, 1440)],
)
def test_the_cadence_follows_how_far_away_the_departure_is(days_out, expected):
    assert poll_minutes(days_out) == expected


def test_a_configured_interval_cannot_escape_the_measured_bounds():
    """
    The table is configurable; the bounds are not. Below 15 minutes nothing was
    ever observed to change, and slower than daily is coarser than the free
    history Google already gives away.
    """
    assert poll_minutes(1, ((14, 1),)) == MIN_POLL_MINUTES
    assert poll_minutes(1, ((14, 10_000),)) == MAX_POLL_MINUTES
    assert clamp_minutes(0) == MIN_POLL_MINUTES
    assert clamp_minutes(99_999) == MAX_POLL_MINUTES


def test_a_departure_past_the_last_row_still_gets_a_rate():
    """Deciding a departure is uncollectable is the horizon's job, not this one."""
    assert poll_minutes(9_999) == MAX_POLL_MINUTES


@pytest.mark.parametrize(
    ("days_out", "ok"),
    [
        (0, True),
        (1, True),
        (MAX_DEPARTURE_HORIZON_DAYS, True),
        (MAX_DEPARTURE_HORIZON_DAYS + 1, False),
        (-1, False),
    ],
)
def test_the_horizon_is_where_google_stops_answering(days_out, ok):
    """Measured: +330 days returned itineraries, +340 returned an error."""
    assert within_horizon(days_out) is ok


def test_an_unreadable_date_is_none_rather_than_a_guess():
    assert days_until("not-a-date", TODAY) is None
    assert days_until("2026-10-17", TODAY) == 60


# ---------------------------------------------------------------- due_now ----


def test_something_never_collected_is_always_due():
    (due,) = due_now([("LIM", "CUZ", "2026-10-17")], {}, NOW)
    assert due.ready and due.reason == "never-collected"


def test_something_looked_at_a_moment_ago_is_not_due():
    seen = {("LIM", "CUZ", "2026-10-17"): "2026-08-18T11:59:00+00:00"}
    (due,) = due_now([("LIM", "CUZ", "2026-10-17")], seen, NOW)
    assert not due.ready and due.reason == "not-due"
    assert due.every_minutes == 240


def test_something_looked_at_longer_ago_than_its_interval_is_due():
    seen = {("LIM", "CUZ", "2026-08-25"): "2026-08-18T11:00:00+00:00"}
    (due,) = due_now([("LIM", "CUZ", "2026-08-25")], seen, NOW)
    assert due.ready and due.reason == "due" and due.every_minutes == 30


def test_a_departed_flight_and_one_past_the_horizon_are_reported_not_dropped():
    """
    Both would otherwise be a failure line every single pass forever, and a
    report full of failures nobody can act on is a report nobody reads.
    """
    watched = [("LIM", "CUZ", "2026-08-01"), ("LIM", "CUZ", "2028-08-01"), ("LIM", "CUZ", "nope")]
    reasons = {d.flight_date: d.reason for d in due_now(watched, {}, NOW)}
    assert reasons["2026-08-01"] == "departed"
    assert reasons["2028-08-01"] == "beyond-horizon"
    assert reasons["nope"] == "unreadable-date"
    assert not any(d.ready for d in due_now(watched, {}, NOW))


def test_the_budget_keeps_the_near_departures_and_drops_the_far_ones():
    """
    When a pass cannot afford everything, what it keeps matters: the near
    departures are the ones the measurement says actually move.
    """
    watched = [
        ("LIM", "MAD", "2027-01-15"),
        ("LIM", "CUZ", "2026-08-25"),
        ("LIM", "SCL", "2026-09-20"),
    ]
    plan = due_now(watched, {}, NOW, budget=2)
    ready = [d.flight_date for d in plan if d.ready]
    over = [d.flight_date for d in plan if d.reason == "over-budget"]
    assert ready == ["2026-08-25", "2026-09-20"]
    assert over == ["2027-01-15"]


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
    assert history.read_baseline("LIM", "CUZ", "2026-10-17") == points
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
    assert history.read_baseline("LIM", "CUZ", "2026-10-17") == [PricePoint("2026-06-19", 48.0)]


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


# ------------------------------------------------------------- collect_due ---


def transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_a_pass_polls_only_what_is_due_and_says_what_it_skipped(tmp_path):
    html = (Path(__file__).parent / "fixtures" / "google_flights_lim_scl.html").read_text(
        encoding="utf-8"
    )
    history = FareHistory(tmp_path)
    history.record_check(
        "LIM", "MAD", "2027-01-15", at="2026-08-18T11:59:00+00:00", outcome="unchanged"
    )

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect_due(
                [FareQuery("LIM", "SCL", "2026-10-17"), FareQuery("LIM", "MAD", "2027-01-15")],
                now=NOW,
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert [r.destination for r in report.results] == ["SCL"]
    assert report.skipped == [("LIM-MAD 2027-01-15", "not-due")]


def test_a_second_look_writes_a_heartbeat_and_no_snapshot(tmp_path):
    """
    The two halves of the design in one assertion: the archive grows only on
    change, and the heartbeat file grows every time. `collect` is used rather
    than `collect_due` because this is about what a look records, not about
    whether one was due — and the heartbeat carries the real clock, which a
    test cannot move.
    """
    html = (Path(__file__).parent / "fixtures" / "google_flights_lim_scl.html").read_text(
        encoding="utf-8"
    )
    history = FareHistory(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect(
                [FareQuery("LIM", "SCL", "2026-08-25")],
                history=history,
                client=client,
                gap_seconds=0,
            )

    first = asyncio.run(run())
    second = asyncio.run(run())

    assert first.results[0].changed is True
    assert second.results[0].changed is False
    assert len(history.read("LIM", "SCL")) == 1
    assert len(history.checks("LIM", "SCL")) == 2
    assert [row["outcome"] for row in history.checks("LIM", "SCL")] == ["changed", "unchanged"]


def test_the_first_pass_after_a_reader_change_is_not_recorded_as_a_fare_change(tmp_path):
    """
    The snapshot is written and the heartbeat says why.

    `/fares/watch` counts `changed` heartbeats and reports them as this route's
    changes. If the pass that first read the best-departing block wrote one of
    those on every watched route, the archive would carry a spike nobody could
    later tell from a real one — and the archive's whole value is that a change
    means something.
    """
    html = (Path(__file__).parent / "fixtures" / "google_flights_lim_scl.html").read_text(
        encoding="utf-8"
    )
    history = FareHistory(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect(
                [FareQuery("LIM", "SCL", "2026-08-25")],
                history=history,
                client=client,
                gap_seconds=0,
            )

    asyncio.run(run())
    # A state file as an older reader left it: a bare digest, no recipe.
    (tmp_path / "state" / "LIM-SCL.json").write_text(
        json.dumps({"2026-08-25": "0123456789abcdef"}), encoding="utf-8"
    )
    report = asyncio.run(run())

    assert report.results[0].changed is True
    assert len(history.read("LIM", "SCL")) == 2
    assert [row["outcome"] for row in history.checks("LIM", "SCL")][-1] == "rebaselined"


def test_the_free_history_is_seeded_once_and_not_on_every_poll(tmp_path):
    html = (Path(__file__).parent / "fixtures" / "google_flights_lim_scl.html").read_text(
        encoding="utf-8"
    )
    history = FareHistory(tmp_path)
    history.merge_baseline(
        "LIM",
        "SCL",
        "2026-08-25",
        [PricePoint("2026-06-19", 134.0)],
        source="google-flights-history",
        currency="USD",
    )

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect_due(
                [FareQuery("LIM", "SCL", "2026-08-25")],
                now=NOW,
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.results[0].seeded == 0


# ----------------------------------------------------------------- airports --


def test_airports_arrive_with_the_search_and_are_kept(tmp_path):
    """
    Before this the repository knew `LIM` only as three letters matching a
    regular expression. The coordinates were arriving in every response and
    being discarded, and any map would have needed a bundled lookup table
    heavier than the map itself.
    """
    from app.adapters.fares import google_flights

    payload = json.loads(
        (Path(__file__).parent / "fixtures" / "google_flights_airports.json").read_text(
            encoding="utf-8"
        )
    )
    airports = google_flights.parse_airports(payload)
    codes = {airport.code for airport in airports}
    assert {"LIM", "SCL"} <= codes

    lima = next(airport for airport in airports if airport.code == "LIM")
    assert -13 < lima.latitude < -11
    assert -78 < lima.longitude < -76

    history = FareHistory(tmp_path)
    assert history.merge_airports(airports) == len(airports)
    # Seeing them again is not seeing new ones.
    assert history.merge_airports(airports) == 0
    assert history.airports()["LIM"].city


def test_a_payload_without_airports_is_not_an_error():
    from app.adapters.fares import google_flights

    assert google_flights.parse_airports([None, None]) == []
    assert google_flights.parse_airports("nonsense") == []


def test_a_coordinate_off_the_planet_is_dropped():
    """Repair what you can, drop what you cannot, invent nothing."""
    from app.adapters.fares import google_flights

    payload = [None, [[[[["XXX", 0], "Nowhere", ["/m", "Nowhere"], [999.0, 0.0], "ZZ", 0, "Z"]]]]]
    assert google_flights.parse_airports(payload) == []
