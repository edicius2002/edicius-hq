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
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from app.adapters.fares.models import FareInsights, FareOffer, FareQuery, FareSnapshot, PricePoint
from app.config import MAX_DEPARTURE_HORIZON_DAYS, MAX_POLL_MINUTES, MIN_POLL_MINUTES
from app.services.fare_collector import FareWatch, collect, collect_due, expand
from app.services.fare_history import BaselinePoint, FareHistory
from app.services.fare_schedule import (
    clamp_minutes,
    days_until,
    due_now,
    month_dates,
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


def transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_the_focused_departure_survives_a_budget_that_cuts_the_rest():
    """
    The whole reason a reading preference is stored rather than kept in the UI.

    Two months of March 2027 against a budget of three. Plain nearest-first
    ordering would spend all three on the 1st, 2nd and 3rd of the month and
    report the reader's own flight on the 20th as `over-budget` — every pass,
    forever, because the next pass would make the same choice. The focus is
    ordered ahead of the distance so the day they mean to take is bought first
    and the remaining budget falls back to nearest-first behind it.
    """
    watched = [("LIM", "MAD", f"2027-03-{day:02d}") for day in range(1, 32)]
    plan = due_now(
        watched,
        {},
        NOW,
        budget=3,
        focused=frozenset({("LIM", "MAD", "2027-03-20")}),
    )

    ready = [d.flight_date for d in plan if d.ready]
    assert ready == ["2027-03-20", "2027-03-01", "2027-03-02"]
    assert "2027-03-20" not in [d.flight_date for d in plan if d.reason == "over-budget"]
    # And without it the reader's flight is exactly what gets dropped.
    plain = due_now(watched, {}, NOW, budget=3)
    assert "2027-03-20" not in [d.flight_date for d in plain if d.ready]


def test_ten_watched_routes_is_where_the_budget_starts_dropping_a_departure():
    """
    What actually makes the focus ordering bite, at the real budget of 300.

    Measured 2026-08-19 and pinned here because the docstring 12.134 first
    carried got it wrong: it compared a day's worth of requests against
    `budget`, which is a per-pass ceiling. A pass has exactly as many
    candidates as there are watched departures, so the arithmetic is 300 / 31 =
    9.67 and the threshold is a watchlist of ten routes. Nine never truncates;
    ten always can, and the day the reader named is the one it reaches last.
    """
    days = month_dates("2027-03")
    assert len(days) == 31

    def sweep(routes: int) -> tuple[str, str]:
        watched = [("LIM", f"D{i:02d}", day) for i in range(routes) for day in days]
        star = watched[-1]
        plain = {
            (d.origin, d.destination, d.flight_date): d
            for d in due_now(watched, {}, NOW, budget=300)
        }
        kept = {
            (d.origin, d.destination, d.flight_date): d
            for d in due_now(watched, {}, NOW, budget=300, focused=frozenset({star}))
        }
        return plain[star].reason, kept[star].reason

    assert sweep(9) == ("never-collected", "never-collected")
    assert sweep(10) == ("over-budget", "never-collected")
    assert sweep(12) == ("over-budget", "never-collected")


def test_the_truncation_threshold_does_not_move_with_the_calendar():
    """
    The claim 12.134 originally made, and the one the measurement refutes.

    Two watched months are 62 candidates in a pass whether the flight is most
    of a year away or next week, so 300 is never spent and nothing is ever
    dropped. What climbs with the date is the number of *passes* a day, which
    `poll_minutes` decides and this ceiling never sees.
    """
    watched = [
        (o, d, day) for o, d in (("LIM", "SCL"), ("LIM", "MAD")) for day in month_dates("2027-03")
    ]
    assert len(watched) == 62

    for when in ("2026-08-19", "2026-11-24", "2027-02-01", "2027-03-01"):
        moment = datetime.fromisoformat(f"{when}T12:00:00+00:00")
        plan = due_now(watched, {}, moment, budget=300)
        assert [d for d in plan if d.reason == "over-budget"] == [], when


def test_a_focus_buys_a_place_in_the_queue_and_not_a_faster_cadence():
    """
    12.135, and the arithmetic is the argument.

    A departure 150 days out moved on 22% of days by a median 1.7%, so polling
    it every half hour would spend 47 of its 48 daily requests rewriting the
    same number. Starring a date does not change what the endpoint answers, so
    the focused day gets the interval its distance earns and is skipped by name
    when it is not due, exactly like the thirty days beside it.
    """
    key = ("LIM", "MAD", "2027-01-15")
    seen = {key: "2026-08-18T11:59:00+00:00"}
    (due,) = due_now([key], seen, NOW, focused=frozenset({key}))

    assert due.focused is True
    assert due.every_minutes == poll_minutes(days_until("2027-01-15", TODAY))
    assert not due.ready and due.reason == "not-due"


def test_a_focused_departure_that_has_gone_is_reported_departed_like_any_other():
    """
    A real case by March, and it must not be rescued by the ordering.

    Being kept first is about a truncation, not about skipping the rules, so
    readiness is the outer sort key and a departed day is never ready. It comes
    back named and with its reason, which is what lets the page say so instead
    of leaving the reader to work it out from a series that stopped.
    """
    key = ("LIM", "MAD", "2026-08-01")
    (due,) = due_now([key], {}, NOW, budget=1, focused=frozenset({key}))
    assert due.focused is True
    assert not due.ready and due.reason == "departed"


def test_a_pass_keeps_the_focused_departure_when_the_budget_will_not_stretch(tmp_path):
    """
    The same ordering through `collect_due`, where the watch names its own day.

    `collect_due` derives the focus set from membership in the expanded month,
    so a watch cannot star a departure it is not collecting — there is no
    second containment rule to disagree with the first.
    """
    html = (Path(__file__).parent / "fixtures" / "google_flights_lim_scl.html").read_text(
        encoding="utf-8"
    )
    history = FareHistory(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", "2026-10", focus="2026-10-28")],
                now=NOW,
                budget=2,
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert [result.flight_date for result in report.results] == ["2026-10-28", "2026-10-01"]
    assert ("LIM-SCL 2026-10-28", "over-budget") not in report.skipped


def test_a_focus_outside_its_own_month_is_ignored_rather_than_collected(tmp_path):
    """
    Nothing can send one — the normalizer drops it and the router 422s it — so
    this is the last line rather than the first. Pulling `2026-11-04` into a
    pass over October would collect a departure nobody is watching.
    """
    html = (Path(__file__).parent / "fixtures" / "google_flights_lim_scl.html").read_text(
        encoding="utf-8"
    )
    history = FareHistory(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", "2026-10", focus="2026-11-04")],
                now=NOW,
                budget=2,
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert [result.flight_date for result in report.results] == ["2026-10-01", "2026-10-02"]


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


# --------------------------------------------------------------- the month ---


def test_a_month_expands_into_the_days_the_calendar_actually_has():
    assert month_dates("2026-10")[0] == "2026-10-01"
    assert month_dates("2026-10")[-1] == "2026-10-31"
    assert len(month_dates("2026-11")) == 30
    # Asked of the calendar rather than looked up in a table of twelve numbers,
    # so a leap year is right without anybody remembering to say so.
    assert len(month_dates("2028-02")) == 29
    assert len(month_dates("2026-02")) == 28


def test_a_month_that_is_not_one_expands_to_nothing_rather_than_to_nonsense():
    # `2026-3` would format back into `2026-3-01`, a departure no provider will
    # parse — and the caller reports the refusal rather than sending it.
    for not_a_month in ("2026-3", "2026-13", "2026-00", "2026-10-17", "soon", ""):
        assert month_dates(not_a_month) == []


def test_expanding_a_month_names_it_when_it_cannot_be_read():
    """8.8 and 8.41: a watch that vanishes between the list and the report."""
    queries, unreadable = expand([FareWatch("LIM", "SCL", "2026-10"), FareWatch("LIM", "MAD", "?")])
    assert len(queries) == 31
    assert unreadable == ["LIM-MAD ?"]


# ------------------------------------------------------------- collect_due ---


def test_a_pass_polls_only_what_is_due_and_says_what_it_skipped(tmp_path):
    html = (Path(__file__).parent / "fixtures" / "google_flights_lim_scl.html").read_text(
        encoding="utf-8"
    )
    history = FareHistory(tmp_path)
    # Every departure in January bar one was looked at a minute ago, so the
    # month is due for exactly one of its thirty-one days.
    for day in range(1, 32):
        if day == 15:
            continue
        history.record_check(
            "LIM", "MAD", f"2027-01-{day:02d}", at="2026-08-18T11:59:00+00:00", outcome="unchanged"
        )

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect_due(
                [FareWatch("LIM", "MAD", "2027-01")],
                now=NOW,
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    # One departure polled and thirty declined, each of them by name.
    assert [r.flight_date for r in report.results] == ["2027-01-15"]
    assert len(report.skipped) == 30
    assert {reason for _, reason in report.skipped} == {"not-due"}
    assert ("LIM-MAD 2027-01-01", "not-due") in report.skipped


def test_a_half_departed_month_polls_the_rest_and_names_the_days_it_skipped(tmp_path):
    """
    A month is not collectable or not — half of it can be behind us.

    NOW is the 18th of August, so the first seventeen days of the month have
    gone and the rest have not. Each one is refused by name rather than the
    whole watch being dropped, because "August collected nothing" and "August
    is half over" are different things and only one of them is a fault.
    """
    html = (Path(__file__).parent / "fixtures" / "google_flights_lim_scl.html").read_text(
        encoding="utf-8"
    )
    history = FareHistory(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", "2026-08")],
                now=NOW,
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    departed = [what for what, reason in report.skipped if reason == "departed"]
    assert len(departed) == 17
    assert "LIM-SCL 2026-08-01" in departed
    assert "LIM-SCL 2026-08-17" in departed
    # The 18th onwards were never looked at, so all fourteen are polled.
    assert [result.flight_date for result in report.results] == [
        f"2026-08-{day:02d}" for day in range(18, 32)
    ]


def test_a_month_past_the_horizon_is_refused_a_day_at_a_time_and_says_why(tmp_path):
    """
    Measured: +330 days returned itineraries and +340 answered an error. A
    month straddling that edge collects its near days and refuses the rest —
    and "beyond-horizon" is a different answer from "not due", because waiting
    will never fix it.
    """
    html = (Path(__file__).parent / "fixtures" / "google_flights_lim_scl.html").read_text(
        encoding="utf-8"
    )
    history = FareHistory(tmp_path)
    edge = TODAY + timedelta(days=MAX_DEPARTURE_HORIZON_DAYS)
    month = f"{edge.year:04d}-{edge.month:02d}"

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", month)],
                now=NOW,
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    beyond = [what for what, reason in report.skipped if reason == "beyond-horizon"]
    assert len(beyond) == len(month_dates(month)) - edge.day
    assert [result.flight_date for result in report.results][-1] == edge.isoformat()


def test_a_pass_spends_its_budget_on_the_nearest_departures_first(tmp_path):
    """
    A month of thirty-one days against a budget of three.

    Truncating is not a failure mode here, it is the design: the near
    departures are the ones the measurement says actually move, so a pass that
    cannot afford everything keeps those and reports the rest as `over-budget`.
    The next pass picks them up, because the archive remembers what was looked
    at rather than the pass remembering what it meant to do.
    """
    html = (Path(__file__).parent / "fixtures" / "google_flights_lim_scl.html").read_text(
        encoding="utf-8"
    )
    history = FareHistory(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", "2026-10")],
                now=NOW,
                budget=3,
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert [result.flight_date for result in report.results] == [
        "2026-10-01",
        "2026-10-02",
        "2026-10-03",
    ]
    assert sum(1 for _, reason in report.skipped if reason == "over-budget") == 28


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
                [FareWatch("LIM", "SCL", "2026-08")],
                now=NOW,
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    seeded = next(r for r in report.results if r.flight_date == "2026-08-25")
    assert seeded.seeded == 0


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
