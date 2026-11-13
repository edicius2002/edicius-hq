"""Validated, deterministic FX archive rows shared by import and comparison."""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from .models import SOURCES

FxKey = tuple[str, str, str]
_COLUMNS = {"owner_id", "source", "effective_at", "observed_at", "buy", "sell", "context"}
_TEXT_CONTEXT = {"variant", "method", "direction", "via", "series"}


def _timestamp(value: Any) -> str:
    try:
        parsed = datetime.fromisoformat(value) if isinstance(value, str) else value
        if not isinstance(parsed, datetime) or parsed.utcoffset() is None:
            raise ValueError("invalid FX timestamp")
        return parsed.astimezone(UTC).isoformat(timespec="microseconds")
    except (TypeError, OverflowError) as exc:
        raise ValueError("invalid FX timestamp") from exc


def _decimal(value: Any) -> str:
    try:
        if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
            raise ValueError("invalid FX numeric value")
        number = Decimal(str(value))
        if not number.is_finite() or number <= 0:
            raise ValueError("invalid FX numeric value")
        # Decimal.normalize() rounds to the active precision; fixed formatting does not.
        result = format(number, "f")
        return result.rstrip("0").rstrip(".") if "." in result else result
    except (InvalidOperation, TypeError) as exc:
        raise ValueError("invalid FX numeric value") from exc


def normalize_row(row: Mapping[str, Any], owner_id: UUID) -> dict[str, Any]:
    """Accept only normalized observation fields, never provider response payloads."""
    if not isinstance(row, Mapping) or set(row) != _COLUMNS:
        raise ValueError("invalid FX columns")
    try:
        owner = UUID(str(row["owner_id"]))
        if owner != UUID(str(owner_id)):
            raise ValueError("FX owner mismatch")
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("invalid FX owner") from exc
    if not isinstance(row["source"], str) or row["source"] not in SOURCES:
        raise ValueError("invalid FX source")
    context = row["context"]
    if not isinstance(context, Mapping) or set(context) - (_TEXT_CONTEXT | {"amount_usd"}):
        raise ValueError("invalid FX context")
    safe: dict[str, Any] = {}
    for key, value in context.items():
        if key == "amount_usd":
            amount = _decimal(value)
            safe[key] = int(amount) if "." not in amount else amount
        elif not isinstance(value, str) or any(ord(c) < 32 or c in "<>" for c in value):
            raise ValueError("invalid FX context")
        else:
            safe[key] = value
    if len(json.dumps(safe, ensure_ascii=False).encode("utf-8")) > 2048:
        raise ValueError("invalid FX context size")
    buy, sell = _decimal(row["buy"]), _decimal(row["sell"])
    if Decimal(buy) > Decimal(sell):
        raise ValueError("invalid FX spread")
    return dict(
        owner_id=str(owner),
        source=row["source"],
        effective_at=_timestamp(row["effective_at"]),
        observed_at=_timestamp(row["observed_at"]),
        buy=buy,
        sell=sell,
        context=safe,
    )


def row_key(row: Mapping[str, Any]) -> FxKey:
    return row["source"], _timestamp(row["effective_at"]), _timestamp(row["observed_at"])


def canonical_bytes(row: Mapping[str, Any]) -> bytes:
    try:
        owner = UUID(str(row["owner_id"]))
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        raise ValueError("invalid FX owner") from exc
    return json.dumps(
        normalize_row(row, owner),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
