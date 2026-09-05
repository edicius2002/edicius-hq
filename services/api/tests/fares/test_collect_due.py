"""
`collect_due` end to end: what a pass picks up, a forced press, and the airports.

The scheduling rules are decided in `test_schedule_cadence.py` and the writing
in `test_schedule_writes.py`. What is tested here is the pass that uses both —
including the press that ignores the cadence entirely, which is what a reader
asking for a route now is.

Out of `test_fares_schedule.py`. `snapshot` is local for the reason
`test_schedule_writes.py` gives.
"""

import asyncio
import dataclasses
import json
from datetime import timedelta

import httpx
from conftest import FIXTURES, NOW, TODAY, transport

from app.adapters.fares.models import FareQuery, FareSnapshot, PricePoint
from app.config import MAX_DEPARTURE_HORIZON_DAYS
from app.services.fare_collector import FareWatch, collect, collect_due
from app.services.fare_history import FareHistory
from app.services.fare_schedule import (
    due_now,
    month_dates,
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


# ------------------------------------------------------------- collect_due ---


def test_a_pass_polls_only_what_is_due_and_says_what_it_skipped(tmp_path):
    html = (FIXTURES / "google_flights_lim_scl.html").read_text(encoding="utf-8")
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
    html = (FIXTURES / "google_flights_lim_scl.html").read_text(encoding="utf-8")
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
    html = (FIXTURES / "google_flights_lim_scl.html").read_text(encoding="utf-8")
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
    html = (FIXTURES / "google_flights_lim_scl.html").read_text(encoding="utf-8")
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


# -------------------------------------------------------- a forced press --
#
# `a-press-collects-the-month-it-is-on`, settling 12.212. The cadence stays the
# default for the scheduled pass, the command line and every other caller; what
# is added is that one reader pressing one row's control gets that route-month
# polled whether or not its turn has come.


def a_month_looked_at_a_minute_ago(history: FareHistory, month: str = "2027-01") -> None:
    """The state 12.212 reproduced: a pass has just run over the whole month."""
    for day in month_dates(month):
        history.record_check("LIM", "MAD", day, at="2026-08-18T11:59:00+00:00", outcome="unchanged")


def a_pass_over(history: FareHistory, *, force: bool, budget: int | None = None, month="2027-01"):
    html = (FIXTURES / "google_flights_lim_scl.html").read_text(encoding="utf-8")

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect_due(
                [FareWatch("LIM", "MAD", month)],
                now=NOW,
                budget=budget,
                history=history,
                client=client,
                gap_seconds=0,
                force=force,
            )

    return asyncio.run(run())


def test_a_press_at_2104_after_a_pass_at_1441_polls_the_month_rather_than_declining_it(tmp_path):
    """
    The complaint 12.212 reproduced, and the answer to it, in one test.

    A month every one of whose departures was looked at a minute ago is a month
    the cadence has nothing to say yes to: the unforced pass polls nothing and
    names all thirty-one as `not-due`, which is 12.111 working exactly as
    designed and is nevertheless the wrong thing to hand somebody who has just
    pressed a control to say they do not believe the last look.

    Forced, the same watch on the same archive polls all thirty-one. Both halves
    are asserted here rather than in two tests, because the pair is the
    decision: what changed is the answer to a press, not the cadence.
    """
    history = FareHistory(tmp_path)
    a_month_looked_at_a_minute_ago(history)

    declined = a_pass_over(history, force=False)
    assert declined.results == []
    assert len(declined.skipped) == 31
    assert {reason for _, reason in declined.skipped} == {"not-due"}

    forced = a_pass_over(history, force=True)
    assert len(forced.results) == 31
    assert forced.skipped == []
    assert [result.flight_date for result in forced.results] == month_dates("2027-01")


def test_a_forced_press_cannot_argue_a_day_back_out_of_the_past(tmp_path):
    """
    Force moves the cadence and nothing else.

    `departed`, `beyond-horizon` and `unreadable-date` are not the schedule
    declining to spend a request — they are the provider having nothing to
    answer about, and a reader pressing a button does not change that. NOW is
    the 18th of August, so seventeen days of that month have gone; a forced pass
    over it still names them and still polls the fourteen that are left.
    """
    history = FareHistory(tmp_path)
    report = a_pass_over(history, force=True, month="2026-08")

    departed = [what for what, reason in report.skipped if reason == "departed"]
    assert len(departed) == 17
    assert [result.flight_date for result in report.results] == [
        f"2026-08-{day:02d}" for day in range(18, 32)
    ]


def test_a_forced_press_still_stops_where_the_day_stops(tmp_path):
    """
    The budget is not a policy about pace and a press may not overrule it.

    The cadence is a judgement about when a fare is worth a request; a reader
    who disagrees is allowed to. The day's ceiling is a bound on how much this
    address is seen to send, which is the one thing here that can reach somebody
    outside this machine, and no press may move it. Three requests of room, a
    forced month of thirty-one: three polled, twenty-eight `over-budget` by
    name, and the three kept are the nearest — 12.111's ordering, unmoved.
    """
    history = FareHistory(tmp_path)
    a_month_looked_at_a_minute_ago(history)
    report = a_pass_over(history, force=True, budget=3)

    assert [result.flight_date for result in report.results] == [
        "2027-01-01",
        "2027-01-02",
        "2027-01-03",
    ]
    assert sum(1 for _, reason in report.skipped if reason == "over-budget") == 28


def test_force_replaces_not_due_and_leaves_every_other_answer_alone():
    """
    The one branch, read straight off `due_now` rather than through a pass.

    A departure whose turn has come is still `due` and one nothing has ever
    looked at is still `never-collected`: force does not relabel what was
    already going to be polled, so a plan read back says which departures were
    the reader's doing.
    """
    watched = [
        ("LIM", "MAD", "2027-01-01"),  # looked at a minute ago — not due
        ("LIM", "MAD", "2027-01-02"),  # looked at a week ago — due
        ("LIM", "MAD", "2027-01-03"),  # never looked at
    ]
    last_checked = {
        ("LIM", "MAD", "2027-01-01"): "2026-08-18T11:59:00+00:00",
        ("LIM", "MAD", "2027-01-02"): "2026-08-11T12:00:00+00:00",
    }

    ordinary = {
        due.flight_date: (due.ready, due.reason) for due in due_now(watched, last_checked, NOW)
    }
    assert ordinary["2027-01-01"] == (False, "not-due")
    assert ordinary["2027-01-02"] == (True, "due")
    assert ordinary["2027-01-03"] == (True, "never-collected")

    forced = {
        due.flight_date: (due.ready, due.reason)
        for due in due_now(watched, last_checked, NOW, force=True)
    }
    assert forced["2027-01-01"] == (True, "forced")
    assert forced["2027-01-02"] == (True, "due")
    assert forced["2027-01-03"] == (True, "never-collected")


def test_a_second_look_writes_a_heartbeat_and_no_snapshot(tmp_path):
    """
    The two halves of the design in one assertion: the archive grows only on
    change, and the heartbeat file grows every time. `collect` is used rather
    than `collect_due` because this is about what a look records, not about
    whether one was due — and the heartbeat carries the real clock, which a
    test cannot move.
    """
    html = (FIXTURES / "google_flights_lim_scl.html").read_text(encoding="utf-8")
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
    html = (FIXTURES / "google_flights_lim_scl.html").read_text(encoding="utf-8")
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
    html = (FIXTURES / "google_flights_lim_scl.html").read_text(encoding="utf-8")
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

    payload = json.loads((FIXTURES / "google_flights_airports.json").read_text(encoding="utf-8"))
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


def test_seeing_the_same_airports_again_does_not_rewrite_the_file(tmp_path):
    """
    12.213. `merge_airports` runs once per upstream request, and after a
    route's first look every later call has the identical handful of entries
    to fold in — so every later call was rewriting the file with what it
    already held.

    Measured on the owner's machine the median cost of that is 2.8ms, which is
    nothing, and the tail is not: the write goes through a temporary file and a
    rename, and those two syscalls were seen taking 1.6s and 4.9s inside a live
    pass. A count of zero was already returned and is not what this is about —
    the old code returned zero *after* writing.

    Asserted by leaving a mark in the file rather than by watching a
    timestamp: a modification time has a resolution this test would race, and
    a byte that survives is unambiguous.
    """
    from app.adapters.fares.models import Airport

    airports = [
        Airport(
            code="LIM",
            name="Jorge Chávez",
            city="Lima",
            country="PE",
            latitude=-12.0,
            longitude=-77.1,
        ),
    ]
    history = FareHistory(tmp_path)
    assert history.merge_airports(airports) == 1

    marked = history.airports_path.read_text(encoding="utf-8") + "\n"
    history.airports_path.write_text(marked, encoding="utf-8")

    assert history.merge_airports(airports) == 0
    assert history.airports_path.read_text(encoding="utf-8") == marked

    # An airport that genuinely moved is still written, or the saving would be
    # bought by dropping the data.
    moved = [dataclasses.replace(airports[0], city="Callao")]
    assert history.merge_airports(moved) == 0
    assert history.airports()["LIM"].city == "Callao"


def test_a_payload_without_airports_is_not_an_error():
    from app.adapters.fares import google_flights

    assert google_flights.parse_airports([None, None]) == []
    assert google_flights.parse_airports("nonsense") == []


def test_a_coordinate_off_the_planet_is_dropped():
    """Repair what you can, drop what you cannot, invent nothing."""
    from app.adapters.fares import google_flights

    payload = [None, [[[[["XXX", 0], "Nowhere", ["/m", "Nowhere"], [999.0, 0.0], "ZZ", 0, "Z"]]]]]
    assert google_flights.parse_airports(payload) == []
