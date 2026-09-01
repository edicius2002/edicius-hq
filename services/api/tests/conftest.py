"""
Every test gets its own data directory, whether it asks for one or not.

Most tests already did this by hand — `monkeypatch.setenv("LOCAL_DATA_DIR",
str(tmp_path))` appears in `test_kv` half a dozen times — and the ones that
didn't got away with it because they passed a `tmp_path` straight to
`FareHistory` or `FareCalendar` and never touched a default. `fare_budget`'s
ledger has no store to be handed: it is module state beside `HISTORY`, because
there is one address and therefore one day's spend, and a collector test that
fell back to the default would write into whatever `.local-data` the working
directory happens to name.

So the redirect moves up here and applies to everything. A test that wants a
different directory still sets one; this only decides where "no directory was
named" points, and it points somewhere that is thrown away afterwards.
"""

import pytest


@pytest.fixture(autouse=True)
def _own_data_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path / "local-data"))
    # Lifespan tests must never reach the real X profile or launch Chromium.
    # Individual lifecycle tests opt in and replace the watcher at its boundary.
    monkeypatch.setenv("X_TWEET_WATCH_ON_START", "false")


@pytest.fixture(autouse=True)
def _unpaced_between_tests():
    """
    Each test starts with no Google request behind it.

    `GOOGLE_PACER` holds the last upstream start for the life of the process,
    which is what keeps two passes from addressing Google faster than the gap.
    Across tests that same memory is a leak: a pass that ran microseconds ago
    makes the next test really sleep three seconds before its first request,
    and `wait_for_the_pass` gives a pass five.
    """
    from app.services.fare_collector import GOOGLE_PACER

    GOOGLE_PACER.reset()
    yield
    GOOGLE_PACER.reset()
