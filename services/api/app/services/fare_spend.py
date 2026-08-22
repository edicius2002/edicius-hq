"""
Today's ledger, read rather than written.

`fare_budget` writes one line per request before it leaves and nothing has ever
read it back except the budget itself. That was survivable while a pass was
something a person pressed and watched; it is not survivable on a schedule,
where ninety-six passes a day run with nobody looking and the first sign of a
pass spending badly would be Google refusing to answer — an address that cannot
be replaced, because 12.9 records that datacenter ones are fingerprinted and
there is no second provider.

**Read-only, and deliberately so.** Nothing here changes what the collector does
or when. It asks `RequestLedger.spent` for the count and `daily_request_budget()`
for the ceiling, both of which the collector already asks, so a reader cannot
learn a different number from the one a pass is about to act on.

**The ceiling is now usually `None`, and the count is the whole answer.** With
nothing refusing at a number, `spent` stops being a fraction of something and
becomes the plain figure it always was underneath — which is why the endpoint
carries `BUSIEST_DAY_ON_RECORD` beside it. That is the only measured number a
reader can judge today against, and it is what tells somebody whether an
unbounded day has quietly become an unusual one.

**The count is the ledger's, and the breakdown is ours.** `RequestLedger.spent`
counts *lines* rather than parsing JSON, on the argument that a half-written last
line is still a request that left this address. Naming what those requests went
on does need the JSON, so this file parses — separately, and never in a way that
can move the total. A line that will not parse is counted in `spent` and
attributed to no kind, so the breakdown can sum to one less than the total, which
is the honest arrangement: the number that governs is the one the budget
enforces, and the breakdown is a second, weaker reading beside it.

**`spent` is `None` when the day cannot be read, and that is not zero.** Under a
configured ceiling `DailyBudget` treats an unreadable ledger as a day fully
spent, because guessing low is the one guess that spends the asset — so it stops
the pass and reports every departure as `over-budget`, and `remaining` says the
same thing here at zero while `spent` stays `None`. A reader is owed the
difference between "600 sent" and "we have no idea, and nothing will collect
until we do".

With no ceiling, an unreadable ledger stops nothing: `remaining` is `None`
because there is nothing to have left, and `spent` is still `None` because the
figure genuinely is not known. The two nulls mean different things and the page
has to say so — the collector is fine and the record of it is not, which is a
smaller alarm than the other one but is still not a quiet day.
"""

import json
import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from app.config import daily_request_budget
from app.services.fare_budget import LEDGER, RequestLedger

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class KindSpend:
    """How many of the day's requests one kind of look accounts for."""

    #: `board` or `calendar`, as `RequestLedger.spend` writes it. Not an enum:
    #: what the ledger holds is whatever was written on the day, and a reader
    #: of an old file should see a word it does not recognise rather than a
    #: `ValueError`.
    kind: str
    requests: int


@dataclass(frozen=True, slots=True)
class DaySpend:
    """What one day has cost, and what is left of it."""

    day: date
    #: When this day's file stops being the one that is written to, as an
    #: instant. The ledger names its file after the **UTC** date, so the roll is
    #: not midnight where the reader lives — in Lima it is seven in the evening.
    #: Sent as an instant rather than left to be worked out from `day`, because
    #: a client deriving it has to know the zone and would be wrong quietly.
    resets_at: datetime
    #: Requests recorded today, or `None` when the file cannot be read.
    spent: int | None
    #: The day's ceiling, or `None` when there is not one — which is the
    #: default. Not zero, and no reader may round it to one.
    ceiling: int | None
    #: What a pass starting now could still spend — `DailyBudget.remaining`'s
    #: answer: zero on an unreadable ledger under a ceiling, and `None` whenever
    #: there is no ceiling for anything to be left of.
    remaining: int | None
    #: Requests by kind, largest first, ties by name. Empty on a day with no
    #: file, and on one that cannot be read.
    kinds: tuple[KindSpend, ...]


def _resets_at(day: date) -> datetime:
    return datetime.combine(day + timedelta(days=1), time.min, tzinfo=UTC)


def _kinds(ledger: RequestLedger, day: date) -> tuple[KindSpend, ...]:
    """
    What the day's requests went on, as far as the file can say.

    Every failure is the same answer — nothing to attribute — because this is
    the weaker of the two readings and must never be able to cost the reader the
    stronger one. A missing file, an unreadable one and a line of half-written
    JSON all leave the total standing and the breakdown short.
    """
    path = ledger.path_for(day)
    if not path.exists():
        return ()
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        logger.error("fare spend could not read %s: %s", path, error)
        return ()

    counts: dict[str, int] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            # The last line of a file a crash interrupted. It is a request that
            # was sent — `spent` has it — and it is not a kind we can name.
            continue
        kind = row.get("kind") if isinstance(row, dict) else None
        if isinstance(kind, str) and kind:
            counts[kind] = counts.get(kind, 0) + 1
    return tuple(
        KindSpend(kind=kind, requests=requests)
        for kind, requests in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    )


def read_spend(
    *,
    ledger: RequestLedger | None = None,
    ceiling: int | None = None,
    now: datetime | None = None,
) -> DaySpend:
    """
    Today's spend, the way `daily_budget` would see it.

    The day is derived exactly as `fare_budget.daily_budget` derives it — the
    UTC date of the moment asked about — because the two must never disagree
    about which file is today's. `remaining` mirrors `DailyBudget.remaining`
    rather than calling it, so that reading the ledger cannot construct a budget
    object; the arithmetic is one `max` and there is a test pinning the two
    against each other.

    `ceiling=None` means "whatever is configured", which is itself usually
    `None`, exactly as in `fare_budget.daily_budget` — the same collapse of the
    two nulls, for the same reason, and the same escape for a caller with a
    number in hand.
    """
    moment = now if now is not None else datetime.now(UTC)
    day = (moment.astimezone(UTC) if moment.tzinfo is not None else moment).date()
    book = ledger if ledger is not None else LEDGER
    allowed = ceiling if ceiling is not None else daily_request_budget()

    spent = book.spent(day)
    # `None` when nothing bounds the day. The `spent is None` arm is the
    # fail-closed one and exists only under a ceiling: an unknown day counts as
    # fully spent, so what is left of it is nothing.
    remaining = None if allowed is None else max(0, allowed - (allowed if spent is None else spent))
    return DaySpend(
        day=day,
        resets_at=_resets_at(day),
        spent=spent,
        ceiling=allowed,
        remaining=remaining,
        kinds=_kinds(book, day),
    )
