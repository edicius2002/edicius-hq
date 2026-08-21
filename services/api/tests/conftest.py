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
