"""
When a watched departure is due to be looked at again.

Pure arithmetic, no clock of its own and no I/O, so the rules can be read in a
test rather than inferred from a running collector.

The shape of the cadence is not a preference. Measured 2026-08-18 against the
daily history Google ships with every search:

| departure | days that moved | median move |
| --------- | --------------- | ----------- |
| +14 days  | 27%             | 14.0%       |
| +60 days  | 37%             | 11.9%       |
| +150 days | 22%             | 1.7%        |

A distant departure changes about as often and says a twentieth as much, so
polling it at the same rate spends the one budget that matters — requests from
this address — on news that is not there. Everything is configurable because a
watchlist is personal; the bounds are not, because they came from the endpoint.
"""

import calendar
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from app.config import (
    DEFAULT_CADENCE_MINUTES,
    MAX_DEPARTURE_HORIZON_DAYS,
    MAX_POLL_MINUTES,
    MIN_POLL_MINUTES,
)

#: `YYYY-MM`, and nothing that only starts like one. `2027-3` would format
#: back into `2027-3-01`, which is a departure no provider will parse.
MONTH_PATTERN = re.compile(r"\d{4}-(0[1-9]|1[0-2])")


def clamp_minutes(minutes: int) -> int:
    """A poll interval the endpoint and the data both justify."""
    return max(MIN_POLL_MINUTES, min(MAX_POLL_MINUTES, int(minutes)))


def month_dates(month: str) -> list[str]:
    """
    Every departure in a `YYYY-MM` month, in order.

    This is the whole of what 12.110 added to the scheduler: a watched month is
    expanded here and everything downstream still reasons about one departure
    at a time, which is why `poll_minutes`, `within_horizon` and `due_now` are
    untouched by the change. The month gets no cadence of its own — each of its
    days is measured against today separately, so the near end of a month can
    be on the half-hourly rate while the far end is still daily.

    The length comes from `calendar` rather than a table of twelve numbers, so
    February 2028 is 29 days without anybody remembering to say so. An
    unreadable month yields nothing rather than raising: the caller reports it
    as a skip with a reason, which is more useful than a stack trace in a
    scheduled task.
    """
    if not isinstance(month, str) or not MONTH_PATTERN.fullmatch(month):
        return []
    span = calendar.monthrange(int(month[:4]), int(month[5:]))[1]
    return [f"{month}-{day:02d}" for day in range(1, span + 1)]


def days_until(departure: str, today: date) -> int | None:
    """Whole days from `today` to a `YYYY-MM-DD` departure, or None if unreadable."""
    try:
        return (date.fromisoformat(departure) - today).days
    except (TypeError, ValueError):
        return None


def poll_minutes(
    days_out: int,
    cadence: tuple[tuple[int, int], ...] = DEFAULT_CADENCE_MINUTES,
) -> int:
    """
    How long to wait between looks at a departure this far away.

    The table is read as upper bounds in order, so the first row that still
    covers `days_out` wins. A departure past the last row falls to the slowest
    rate rather than being dropped — deciding it is uncollectable belongs with
    the horizon check, not here.
    """
    for limit, minutes in cadence:
        if days_out <= limit:
            return clamp_minutes(minutes)
    return clamp_minutes(cadence[-1][1] if cadence else MAX_POLL_MINUTES)


def within_horizon(days_out: int) -> bool:
    """
    Whether Google will answer about a departure this far out at all.

    Measured: +330 days returned itineraries, +340 and beyond returned an
    error. A route past this does not collect slowly, it never collects, and
    the honest place to say so is when it is added rather than once a day
    forever in a failure report.
    """
    return 0 <= days_out <= MAX_DEPARTURE_HORIZON_DAYS


@dataclass(frozen=True, slots=True)
class Due:
    """One watched departure and why it is, or is not, ready to be polled."""

    origin: str
    destination: str
    flight_date: str
    days_out: int
    every_minutes: int
    #: None when nothing has ever been collected for it.
    last_checked_at: str | None
    ready: bool
    reason: str
    #: Whether this is the departure the reader actually means to take —
    #: 12.130. It buys no faster cadence (12.135); it buys a place at the front
    #: of the queue when the budget will not cover everything.
    focused: bool = False

    @property
    def route(self) -> str:
        return f"{self.origin}-{self.destination}"


def _parse_stamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def due_now(
    watched: list[tuple[str, str, str]],
    last_checked: dict[tuple[str, str, str], str],
    now: datetime,
    *,
    cadence: tuple[tuple[int, int], ...] = DEFAULT_CADENCE_MINUTES,
    budget: int | None = None,
    focused: frozenset[tuple[str, str, str]] = frozenset(),
) -> list[Due]:
    """
    Which departures to look at on this pass: focused first, then nearest.

    Ordering matters when a budget bites, and only then. The near departures
    are the ones the measurement says actually move, so a truncated pass keeps
    them and drops the far ones — that is 12.111 and it is unchanged. What
    12.134 puts in front of it is the departure the reader named: of thirty-one
    days in a month, one is the flight they mean to take, and a truncation that
    dropped it while polling the other thirty would be spending the budget on
    everything except the answer that was asked for.

    It costs nothing today, and what will change that is the **size of the
    watchlist**, not the calendar. `budget` is a per-pass ceiling, and one pass
    has exactly as many candidates as there are watched departures — thirty-one
    per month — so the arithmetic is 300 / 31 and the answer is ten routes.
    Measured 2026-08-19 by calling this function with every departure due, a
    budget of 300 and one day focused:

    | routes | departures | focused day without it | with it |
    | ------ | ---------- | ---------------------- | ------- |
    | 9      | 279        | `due`                  | `due`   |
    | 10     | 310        | `over-budget`          | `due`   |
    | 12     | 372        | `over-budget`          | `due`   |

    The same sweep run against a `now` in February 2027 gave the same two rows:
    the threshold does not move with the date, because the number of candidates
    in a pass does not. Two watched months are 62 candidates whether the flight
    is a year away or tomorrow, and 62 never truncates against 300.

    The daily *totals* those two months cost do climb with the date — 62 a day
    now, 302 by 24 November 2026, 2,208 by the March they depart in — and that
    climb is real and is what `poll_minutes` exists for. It is not what this
    ordering is for, and an earlier draft of this docstring said it was by
    comparing a daily sum against a per-pass cap. See `daily_request_budget` in
    `app.config`: nothing carries spend across passes, so the day's budget is
    not enforced anywhere. That gap predates the focus and is not closed here.

    **A focus buys no faster cadence** — 12.135. `poll_minutes` is not
    consulted about it and does not know it exists. The measurement behind the
    table did not change because someone starred a date: a departure 150 days
    out moved on 22% of days by a median 1.7%, so polling it every half hour
    would spend 47 of 48 daily requests rewriting the same number. Order is
    free; rate is not.

    Everything is returned, ready or not, because a caller that can only see
    the work it is about to do cannot report the work it skipped — decisions
    8.8 and 8.41 again. A focused departure that has already gone is in there
    as `departed` like any other, which is how the page learns to say so.
    """
    today = now.date()
    considered: list[Due] = []

    for origin, destination, flight_date in watched:
        starred = (origin, destination, flight_date) in focused
        days_out = days_until(flight_date, today)
        if days_out is None:
            considered.append(
                Due(
                    origin, destination, flight_date, -1, 0, None, False, "unreadable-date", starred
                )
            )
            continue
        if days_out < 0:
            considered.append(
                Due(origin, destination, flight_date, days_out, 0, None, False, "departed", starred)
            )
            continue
        if not within_horizon(days_out):
            considered.append(
                Due(
                    origin,
                    destination,
                    flight_date,
                    days_out,
                    0,
                    None,
                    False,
                    "beyond-horizon",
                    starred,
                )
            )
            continue

        every = poll_minutes(days_out, cadence)
        seen = last_checked.get((origin, destination, flight_date))
        previous = _parse_stamp(seen)
        if previous is None:
            reason, ready = "never-collected", True
        elif now - previous >= timedelta(minutes=every):
            reason, ready = "due", True
        else:
            reason, ready = "not-due", False
        considered.append(
            Due(origin, destination, flight_date, days_out, every, seen, ready, reason, starred)
        )

    # Readiness outranks the focus, and deliberately: a focused departure that
    # is not due is not a departure worth a request, it is one that was looked
    # at recently enough. Being kept first is about the truncation, not about
    # skipping the cadence.
    considered.sort(key=lambda due: (not due.ready, not due.focused, due.days_out))

    if budget is not None:
        spent = 0
        capped: list[Due] = []
        for due in considered:
            if due.ready and spent >= budget:
                capped.append(
                    Due(
                        due.origin,
                        due.destination,
                        due.flight_date,
                        due.days_out,
                        due.every_minutes,
                        due.last_checked_at,
                        False,
                        "over-budget",
                        due.focused,
                    )
                )
                continue
            if due.ready:
                spent += 1
            capped.append(due)
        return capped

    return considered
