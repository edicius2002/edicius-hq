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

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from app.config import (
    DEFAULT_CADENCE_MINUTES,
    MAX_DEPARTURE_HORIZON_DAYS,
    MAX_POLL_MINUTES,
    MIN_POLL_MINUTES,
)


def clamp_minutes(minutes: int) -> int:
    """A poll interval the endpoint and the data both justify."""
    return max(MIN_POLL_MINUTES, min(MAX_POLL_MINUTES, int(minutes)))


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
    Which departures to look at on this pass, nearest departure first.

    Ordering matters when a budget bites: the near departures are the ones the
    measurement says actually move, so a truncated pass should keep them and
    drop the far ones. Everything is returned, ready or not, because a caller
    that can only see the work it is about to do cannot report the work it
    skipped — decisions 8.8 and 8.41 again.
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
