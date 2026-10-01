"""Normalized USD/PEN observations; only safe context leaves this package."""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

SOURCES = (
    "kambista",
    "tu-cambista",
    "securex",
    "cambio-seguro",
    "dollarhouse",
    "rextie",
    "tkambio",
    "bcrp",
    "sbs",
)
REFERENCES = frozenset({"bcrp", "sbs"})
# Owner decision: every USD/PEN source's history starts at 2026-10-01 00:00 Lima.
HISTORY_START = datetime(2026, 10, 1, 5, tzinfo=UTC)


@dataclass(frozen=True)
class Observation:
    source: str
    observed_at: datetime
    effective_at: datetime
    buy: Decimal
    sell: Decimal
    context: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if (
            self.source not in SOURCES
            or not all(v.is_finite() and v > 0 for v in (self.buy, self.sell))
            or self.buy > self.sell
        ):
            raise ValueError("invalid FX observation")
        if any(t.tzinfo is None for t in (self.observed_at, self.effective_at)):
            raise ValueError("timestamps must be aware")
        if set(self.context) - {"variant", "method", "amount_usd", "direction", "via", "series"}:
            raise ValueError("invalid FX context")

    def wire(self) -> dict[str, Any]:
        return dict(
            source=self.source,
            observed_at=self.observed_at.isoformat(),
            effective_at=self.effective_at.isoformat(),
            buy=str(self.buy),
            sell=str(self.sell),
            context=self.context,
        )
