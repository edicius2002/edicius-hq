"""Bounded, expiring chart-focus leases received from the browser."""

from __future__ import annotations

from collections.abc import Mapping
from math import isfinite

from app.adapters import registry
from app.adapters.models import BarFocus
from app.config import TIMEFRAMES


def decode_focus(payload: Mapping[str, object]) -> BarFocus | None:
    """Decode the required focus fields, ignoring any other payload fields."""
    if payload.get("active") is not True:
        return None

    symbol = payload.get("symbol")
    timeframe = payload.get("timeframe")
    extended = payload.get("extended")
    if not isinstance(symbol, str) or not symbol.strip():
        return None
    if not isinstance(timeframe, str) or timeframe not in TIMEFRAMES:
        return None
    if not isinstance(extended, bool):
        return None

    return BarFocus(registry.normalize_symbol(symbol), timeframe, extended)


class ChartFocusBook:
    """Keep at most ``max_clients`` chart leases for a worker process."""

    __slots__ = ("_leases", "_max_clients", "_ttl_seconds")

    def __init__(self, *, ttl_seconds: float, max_clients: int) -> None:
        if not isfinite(ttl_seconds) or ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive and finite")
        if isinstance(max_clients, bool) or max_clients < 1:
            raise ValueError("max_clients must be positive")
        self._ttl_seconds = ttl_seconds
        self._max_clients = max_clients
        self._leases: dict[str, tuple[BarFocus, float]] = {}

    def accept(self, payload: object, now: float) -> bool:
        if not isinstance(payload, Mapping):
            return False
        client_id = payload.get("clientId")
        if not isinstance(client_id, str) or not 1 <= len(client_id) <= 64:
            return False
        if payload.get("active") is False:
            return self._leases.pop(client_id, None) is not None

        focus = decode_focus(payload)
        if focus is None:
            return False
        self._expire(now)
        if client_id not in self._leases and len(self._leases) >= self._max_clients:
            oldest = min(self._leases, key=lambda key: self._leases[key][1])
            self._leases.pop(oldest)
        self._leases[client_id] = (focus, now)
        return True

    def active(self, now: float) -> frozenset[BarFocus]:
        self._expire(now)
        return frozenset(focus for focus, _received_at in self._leases.values())

    def next_expiry(self, now: float) -> float | None:
        self._expire(now)
        if not self._leases:
            return None
        return min(received_at + self._ttl_seconds for _, received_at in self._leases.values())

    def _expire(self, now: float) -> None:
        expired = [
            client_id
            for client_id, (_focus, received_at) in self._leases.items()
            if received_at + self._ttl_seconds <= now
        ]
        for client_id in expired:
            self._leases.pop(client_id, None)


__all__ = ["ChartFocusBook", "decode_focus"]
