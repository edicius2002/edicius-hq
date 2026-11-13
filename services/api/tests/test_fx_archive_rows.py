import json
from decimal import Decimal
from uuid import UUID

import pytest

OWNER = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")


def wire(**changes):
    return dict(
        owner_id=str(OWNER),
        source="kambista",
        effective_at="2026-10-02T18:00:00+00:00",
        observed_at="2026-10-02T18:00:00+00:00",
        buy="3.400",
        sell="3.50",
        context={"variant": "standard", "method": "public-quote"},
        **changes,
    )


def test_normalization_preserves_identity_and_safe_content():
    from app.services.fx.archive_rows import canonical_bytes, normalize_row, row_key

    first = wire()
    second = {
        **first,
        "effective_at": "2026-10-02T13:00:00-05:00",
        "buy": "3.4",
        "context": {"method": "public-quote", "variant": "standard"},
    }
    assert canonical_bytes(first) == canonical_bytes(second)
    assert (
        row_key(first)
        == row_key(second)
        == ("kambista", "2026-10-02T18:00:00.000000+00:00", "2026-10-02T18:00:00.000000+00:00")
    )
    assert normalize_row(first, OWNER)["buy"] == "3.4"
    precise = json.loads('{"buy":3.1234567890123456789012345678901}', parse_float=Decimal)
    assert normalize_row({**first, **precise}, OWNER)["buy"] == "3.1234567890123456789012345678901"


@pytest.mark.parametrize(
    "change",
    [
        {"owner_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"},
        {"secret": "bad"},
        {"context": {"cookie": "bad"}},
        {"context": {"method": "<html>secret</html>"}},
        {"observed_at": "2026-10-02T18:00:00"},
        {"buy": "NaN"},
        {"sell": "Infinity"},
        {"buy": "0"},
        {"buy": "4"},
        {"source": "unknown"},
        {"context": {"method": "x" * 2049}},
    ],
)
def test_normalization_rejects_unsafe_rows(change):
    from app.services.fx.archive_rows import normalize_row

    with pytest.raises(ValueError):
        normalize_row({**wire(), **change}, OWNER)


def test_context_uses_existing_database_size_limit_not_provider_value_enum():
    from app.services.fx.archive_rows import normalize_row

    context = {"method": "historical-method-" + "x" * 300}
    assert normalize_row({**wire(), "context": context}, OWNER)["context"] == context
