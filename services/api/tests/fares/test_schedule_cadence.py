"""
How often a departure is polled, and which ones are due right now.

The rule exists because of one measurement. On 2026-08-18 two real snapshots
taken 23 seconds apart were identical, and so were two taken 8 minutes apart;
the first change appeared across 11.5 hours, where 3 of 25 flights moved.
Meanwhile a fare 14 days out moved on 27% of days by a median 14%, and one 150
days out moved on 22% of days by 1.7%. So: poll near departures often and far
ones rarely.

Out of `test_fares_schedule.py`. What gets written when a poll comes back is in
`test_schedule_writes.py`.
"""

import asyncio
from datetime import datetime

import httpx
import pytest
from conftest import FIXTURES, NOW, TODAY, transport

from app.config import MAX_DEPARTURE_HORIZON_DAYS, MAX_POLL_MINUTES, MIN_POLL_MINUTES
from app.services.fare_collector import FareWatch, collect_due, expand
from app.services.fare_history import FareHistory
from app.services.fare_schedule import (
    clamp_minutes,
    days_until,
    due_now,
    month_dates,
    poll_minutes,
    within_horizon,
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


def test_a_truncated_pass_keeps_the_nearest_departures_and_drops_the_far_ones():
    """
    12.111, and it is the whole ordering rule again — 12.266.

    Thirty-one days of March 2027 against a budget of three. The near
    departures are the ones the measurement says actually move, so those are
    what a pass that cannot afford everything buys.

    12.134 briefly put one day in front of this: the focus, the departure the
    reader said they meant to take, so that a truncation could not drop the
    answer that had been asked for. Nothing names a departure any more, so
    nearest-first is what every candidate is ordered by, with no key in front
    of it that is the same for all of them.

    Handed in reverse, which is the part that measures the sort rather than the
    input: Python's sort is stable, so a candidate list already in date order
    comes back in date order however the key is spelled — including with the
    distance dropped from it entirely.
    """
    watched = [("LIM", "MAD", f"2027-03-{day:02d}") for day in range(31, 0, -1)]
    plan = due_now(watched, {}, NOW, budget=3)

    ready = [d.flight_date for d in plan if d.ready]
    assert ready == ["2027-03-01", "2027-03-02", "2027-03-03"]
    # Everything else comes back named and reasoned rather than omitted — 8.8.
    over = [d.flight_date for d in plan if d.reason == "over-budget"]
    assert len(over) == 28
    assert "2027-03-20" in over


def test_ten_watched_routes_is_where_the_budget_starts_dropping_a_departure():
    """
    When the truncation bites at the real budget of 300.

    Measured 2026-08-19 and pinned here because the docstring 12.134 first
    carried got it wrong: it compared a day's worth of requests against
    `budget`, which is a per-pass ceiling. A pass has exactly as many
    candidates as there are watched departures, so the arithmetic is 300 / 31 =
    9.67 and the threshold is a watchlist of ten routes. Nine never truncates;
    ten always can, and the last departure of the last route is what it reaches
    last.
    """
    days = month_dates("2027-03")
    assert len(days) == 31

    def furthest(routes: int) -> str:
        watched = [("LIM", f"D{i:02d}", day) for i in range(routes) for day in days]
        last = watched[-1]
        plan = {
            (d.origin, d.destination, d.flight_date): d
            for d in due_now(watched, {}, NOW, budget=300)
        }
        return plan[last].reason

    assert furthest(9) == "never-collected"
    assert furthest(10) == "over-budget"
    assert furthest(12) == "over-budget"


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


def test_a_departure_that_has_gone_is_reported_departed_rather_than_polled():
    """
    A real case by March, and readiness is the outer sort key.

    It comes back named and with its reason rather than omitted, which is what
    lets the page say so instead of leaving the reader to work it out from a
    series that stopped — 8.8 and 8.41.
    """
    key = ("LIM", "MAD", "2026-08-01")
    (due,) = due_now([key], {}, NOW, budget=1)
    assert not due.ready and due.reason == "departed"


def test_the_cadence_is_what_decides_a_poll_and_nothing_outranks_it():
    """
    12.135's arithmetic, which outlived the focus it was written about.

    A departure 150 days out moved on 22% of days by a median 1.7%, so polling
    it every half hour would spend 47 of its 48 daily requests rewriting the
    same number. Ordering is free and rate is not, which is why the ordering
    changed twice this week (12.134, then 12.266) and `poll_minutes` did not.
    """
    key = ("LIM", "MAD", "2027-01-15")
    seen = {key: "2026-08-18T11:59:00+00:00"}
    (due,) = due_now([key], seen, NOW)

    assert due.every_minutes == poll_minutes(days_until("2027-01-15", TODAY))
    assert not due.ready and due.reason == "not-due"


def test_a_truncated_pass_through_collect_due_buys_the_nearest_days(tmp_path):
    """
    The same ordering through `collect_due`, which is where a watch becomes
    departures.

    It used to derive a focus set here from membership in the expanded month —
    the containment check that stopped a watch starring a departure it was not
    collecting. With no focus there is nothing to contain and nothing to check:
    the expansion is the whole of what a pass considers.
    """
    html = (FIXTURES / "google_flights_lim_scl.html").read_text(encoding="utf-8")
    history = FareHistory(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", "2026-10")],
                now=NOW,
                budget=2,
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert [result.flight_date for result in report.results] == ["2026-10-01", "2026-10-02"]
    assert ("LIM-SCL 2026-10-28", "over-budget") in report.skipped


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
