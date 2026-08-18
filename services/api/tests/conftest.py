"""
Shared test setup.

One job so far, and it exists because of a real divergence rather than a
hypothetical one: `scripts/api.mjs` loads `.env` before it spawns pytest, so a
developer with a Travelpayouts token in `.env` runs a different suite from CI,
which has none. The fare registry falls back to that provider when the primary
cannot answer — so the same test would exercise the fallback on one machine and
skip it on the other, and the one where it skipped is the one that gates merges.

Credentials are therefore cleared for every test, and any test that wants one
sets it explicitly. A test that depends on the machine it runs on is not a test.
"""

import pytest

CREDENTIAL_VARS = ("TRAVELPAYOUTS_TOKEN", "TRAVELPAYOUTS_MARKER")


@pytest.fixture(autouse=True)
def _no_ambient_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in CREDENTIAL_VARS:
        monkeypatch.delenv(name, raising=False)
