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
    # `focused` was here — whether this was the departure the reader meant to
    # take (12.130), which bought a place at the front of the queue when the
    # budget would not cover everything (12.134) and never a faster cadence
    # (12.135). Nothing names a departure now, so the flag is gone with the
    # ordering it fed rather than sitting False on every `Due` forever — 12.266.

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
) -> list[Due]:
    """
    Which departures to look at on this pass: the nearest first.

    Ordering matters when a budget bites, and only then. The near departures
    are the ones the measurement says actually move, so a truncated pass keeps
    them and drops the far ones — 12.111.

    **That is the whole rule again, and it was briefly not.** 12.134 put one
    departure in front of it: the focus, the day of the month the reader said
    they meant to fly, kept first so a truncation could not drop the answer
    that had been asked for. A watch names no departure any more (12.260), so
    nothing could ever be in that set; the parameter and the flag are gone
    rather than left as a sort key that is constant for every candidate —
    12.266. Nothing else about the ordering moved, because nothing else ever
    depended on the focus: the sort was readiness, then the focus, then
    distance, and readiness already outranked it.

    `budget` is still a per-pass ceiling and this function still knows nothing
    about days. What changed is where the number comes from: the caller now
    hands over what is **left of the day** rather than the whole daily figure,
    because spend is accumulated in a ledger across passes
    (`app.services.fare_budget`). Nothing here had to move for that, which is
    the point of it being arithmetic — the rule was always "fit this many, keep
    the nearest", and it does not care whether the many is a day's or a
    fraction of one.

    When the truncation bites is worth keeping written down. One pass has
    exactly as many candidates as there are watched departures — thirty-one per
    month — so against a full day's 600 the arithmetic is 600 / 31 and the
    answer is nineteen routes. Measured 2026-08-19 against the old 300, nine
    routes gave 279 candidates and none `over-budget`, ten gave 310 and ten
    `over-budget`; the same sweep against a `now` in February 2027 gave the same
    rows, because the number of candidates in a pass does not move with the
    date.

    What does move with the date is the daily *total* those months cost — the
    owner's are 442 a day now and climb steeply as a month approaches — and
    that climb is what `poll_minutes` exists for and what the day's ledger now
    actually enforces. A day that has already spent its 600 arrives here as a
    budget of zero, and every ready departure comes back `over-budget` by name
    rather than being collected on a ceiling nobody was keeping.

    Everything is returned, ready or not, because a caller that can only see
    the work it is about to do cannot report the work it skipped — decisions
    8.8 and 8.41 again.
    """
    today = now.date()
    considered: list[Due] = []

    for origin, destination, flight_date in watched:
        days_out = days_until(flight_date, today)
        if days_out is None:
            considered.append(
                Due(origin, destination, flight_date, -1, 0, None, False, "unreadable-date")
            )
            continue
        if days_out < 0:
            considered.append(
                Due(origin, destination, flight_date, days_out, 0, None, False, "departed")
            )
            continue
        if not within_horizon(days_out):
            considered.append(
                Due(origin, destination, flight_date, days_out, 0, None, False, "beyond-horizon")
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
            Due(origin, destination, flight_date, days_out, every, seen, ready, reason)
        )

    # Ready first, then nearest. Readiness outranks distance because a
    # departure that was looked at ten minutes ago is not worth a request
    # however close it is, and the cadence is what decided that.
    considered.sort(key=lambda due: (not due.ready, due.days_out))

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
                    )
                )
                continue
            if due.ready:
                spent += 1
            capped.append(due)
        return capped

    return considered
