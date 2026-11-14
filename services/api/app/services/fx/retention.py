"""Retention for future successful captures, never historical imports."""

from collections.abc import Mapping
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from .models import REFERENCES, Observation


def _context(context: Mapping[str, Any]) -> dict[str, Any]:
    normalized = dict(context)
    if "amount_usd" in normalized:
        normalized["amount_usd"] = Decimal(str(normalized["amount_usd"]))
    return normalized


def should_persist(observation: Observation, previous: Mapping[str, Any] | None) -> bool:
    if previous is None:
        return True
    if (
        observation.buy != Decimal(str(previous["buy"]))
        or observation.sell != Decimal(str(previous["sell"]))
        or _context(observation.context) != _context(previous["context"])
    ):
        return True
    if observation.source in REFERENCES:
        return observation.effective_at != datetime.fromisoformat(previous["effective_at"])
    return observation.observed_at - datetime.fromisoformat(previous["observed_at"]) >= timedelta(
        minutes=10
    )
