from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.services.fx.models import Observation

NOW = datetime(2026, 10, 2, 18, tzinfo=UTC)


def test_commercial_heartbeat_uses_last_persisted_observation():
    from app.services.fx.retention import should_persist

    previous = None
    decisions = []
    for seconds in (0, 300, 599, 600):
        time = NOW + timedelta(seconds=seconds)
        row = Observation("kambista", time, time, Decimal("3.400"), Decimal("3.5"))
        keep = should_persist(row, previous)
        decisions.append(keep)
        if keep:
            previous = row.wire()
    assert decisions == [True, False, False, True]
    for changes in (
        {"buy": Decimal("3.41")},
        {"sell": Decimal("3.51")},
        {"context": {"variant": "new"}},
    ):
        assert should_persist(replace(row, **changes), previous)
    assert not should_persist(replace(row, observed_at=NOW), previous)


def test_reference_revision_retention():
    from app.services.fx.retention import should_persist

    row = Observation(
        "bcrp", NOW, NOW, Decimal("3.4"), Decimal("3.5"), {"amount_usd": "100.00", "method": "cash"}
    )
    previous = row.wire()
    assert not should_persist(
        replace(
            row, observed_at=NOW + timedelta(days=1), context={"method": "cash", "amount_usd": 100}
        ),
        previous,
    )
    for changes in (
        {"buy": Decimal("3.41")},
        {"context": {"method": "transfer"}},
        {"effective_at": NOW + timedelta(days=1)},
    ):
        assert should_persist(replace(row, **changes), previous)
