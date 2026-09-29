from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from uuid import UUID

import pytest

NOW = datetime(2026, 9, 29, 18, tzinfo=UTC)
OWNER = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")


class Cloud:
    owner_id = OWNER

    def __init__(self):
        self.rows = {}
        self.offline = False

    def begin_run(self, *a):
        if self.offline:
            raise OSError("offline")
        return OWNER

    def heartbeat_run(self, *a):
        pass

    def finish_run(self, *a):
        pass

    def fail_run(self, *a):
        pass

    def upsert_fx(self, rows):
        if self.offline:
            raise OSError("offline")
        for r in rows:
            self.rows[
                tuple(r[k] for k in ("owner_id", "source", "effective_at", "observed_at"))
            ] = r
        return len(rows)


def observation(source, now):
    from app.services.fx.models import Observation

    return Observation(source, now, now, Decimal("3.43"), Decimal("3.46"))


def test_outage_preserves_capture_and_replays_without_duplicates(tmp_path):
    from app.services.fx.collector import collect_once
    from app.services.fx.store import Store

    cloud = Cloud()
    cloud.offline = True
    path = tmp_path / "fx.sqlite"
    with Store(path, OWNER) as store:
        result = collect_once(
            store, cloud, ["kambista"], now=NOW, fetcher=lambda s, c, n, *a: [observation(s, n)]
        )
        assert result["seen"] == 1 and len(store.pending()) == 1
    cloud.offline = False
    with Store(path, OWNER) as store:
        rows = store.pending()
        cloud.upsert_fx(rows)  # crash before acknowledgement
        result = collect_once(
            store,
            cloud,
            ["kambista"],
            now=NOW + timedelta(minutes=1),
            fetcher=lambda *a: pytest.fail("not due"),
        )
        assert len(cloud.rows) == 1 and store.pending() == []


def test_partial_failure_persisted_due_and_retry_after(tmp_path):
    from app.services.fx.collector import collect_once
    from app.services.fx.providers import ProviderError
    from app.services.fx.store import Store

    def fetcher(s, c, n, *a):
        if s == "tkambio":
            raise ProviderError("rate-limited", 1800)
        return [observation(s, n)]

    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        result = collect_once(store, Cloud(), ["tkambio", "kambista"], now=NOW, fetcher=fetcher)
        assert result["failed"] == 1 and result["written"] == 1
        assert not store.due("tkambio", NOW + timedelta(minutes=29))
        assert store.due("tkambio", NOW + timedelta(minutes=30))
        assert store.due("kambista", NOW + timedelta(minutes=15))


def test_dry_run_has_no_writes(tmp_path):
    from app.services.fx.collector import collect_once

    cloud = Cloud()
    result = collect_once(
        None,
        cloud,
        ["kambista"],
        now=NOW,
        dry_run=True,
        fetcher=lambda s, c, n, *a: [observation(s, n)],
    )
    assert result["seen"] == 1 and not cloud.rows
    assert list(tmp_path.iterdir()) == []


def test_backfill_years():
    from app.services.fx.collector import year_ranges

    assert list(year_ranges(date(1997, 6, 1), date(1999, 2, 1))) == [
        (date(1997, 6, 1), date(1997, 12, 31)),
        (date(1998, 1, 1), date(1998, 12, 31)),
        (date(1999, 1, 1), date(1999, 2, 1)),
    ]
    with pytest.raises(ValueError):
        list(year_ranges(date(1996, 1, 1), date(1997, 1, 1)))


def test_backfill_restart_keeps_successful_years(tmp_path):
    from app.services.fx.collector import collect_once
    from app.services.fx.providers import ProviderError
    from app.services.fx.store import Store

    calls = []

    def first(s, c, n, start, end):
        calls.append(start.year)
        if start.year == 1998:
            raise ProviderError()
        return [observation(s, n)]

    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        collect_once(
            store,
            Cloud(),
            ["bcrp"],
            now=NOW,
            fetcher=first,
            backfill=(date(1997, 1, 1), date(1998, 12, 31)),
        )
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        collect_once(
            store,
            Cloud(),
            ["bcrp"],
            now=NOW + timedelta(days=1),
            fetcher=first,
            backfill=(date(1997, 1, 1), date(1998, 12, 31)),
        )
    assert calls == [1997, 1998, 1998]


def test_cloud_boundary_owns_idempotent_fx():
    import json

    import httpx

    from app.config import CollectorConfig
    from app.services.collector_cloud import CollectorCloud, CollectorCloudRejected

    requests = []

    def respond(r):
        requests.append(r)
        return httpx.Response(204)

    config = CollectorConfig(url="https://example.supabase.co", secret_key="test", owner_id=OWNER)
    with_client = CollectorCloud(config, transport=httpx.MockTransport(respond))
    row = observation("kambista", NOW).wire()
    assert with_client.upsert_fx([row]) == 1
    assert json.loads(requests[0].content)[0]["owner_id"] == str(OWNER)
    assert requests[0].url.params["on_conflict"] == "owner_id,source,effective_at,observed_at"
    with pytest.raises(CollectorCloudRejected):
        with_client.upsert_fx([{**row, "owner_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}])
    with_client.close()


def test_explicit_backfill_bypasses_live_cadence_but_respects_failure_cooldown(tmp_path):
    from app.services.fx.collector import collect_once
    from app.services.fx.providers import ProviderError
    from app.services.fx.store import Store

    calls = []

    def successful(s, c, n, *window):
        calls.append(window)
        return [observation(s, n)]

    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        collect_once(store, Cloud(), ["bcrp"], now=NOW, fetcher=successful)
        collect_once(
            store,
            Cloud(),
            ["bcrp"],
            now=NOW,
            fetcher=successful,
            backfill=(date(1997, 1, 1), date(1997, 12, 31)),
        )
        assert len(calls) == 2
    with Store(tmp_path / "blocked.sqlite", OWNER) as store:
        collect_once(
            store,
            Cloud(),
            ["bcrp"],
            now=NOW,
            fetcher=lambda *a: (_ for _ in ()).throw(ProviderError("forbidden", 21600)),
        )
        collect_once(
            store,
            Cloud(),
            ["bcrp"],
            now=NOW,
            fetcher=lambda *a: pytest.fail("cooldown bypassed"),
            backfill=(date(1997, 1, 1), date(1997, 12, 31)),
        )


def test_reference_sources_share_one_http_request_per_window(tmp_path, monkeypatch):
    import json
    from pathlib import Path

    import httpx

    from app.services.fx.collector import collect_once
    from app.services.fx.store import Store

    payload = json.loads((Path(__file__).parent / "fixtures/fx/bcrp.txt").read_text())
    payload["periods"][0]["values"] = ["3.41", "3.42", "3.43", "3.46"]
    requests = []

    def respond(request):
        requests.append(request)
        assert len(requests) == 1
        return httpx.Response(200, json=payload)

    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda: original(transport=httpx.MockTransport(respond)))
    cloud = Cloud()
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        result = collect_once(store, cloud, ["bcrp", "sbs"], now=NOW)
    assert result == dict(seen=2, written=2, failed=0)
    assert {r["source"]: r["buy"] for r in cloud.rows.values()} == {"bcrp": "3.41", "sbs": "3.43"}


@pytest.mark.parametrize("failure", ["series_name", "NaN", "Infinity"])
def test_malformed_source_allows_next_source_and_pending_replay(tmp_path, monkeypatch, failure):
    import json
    from pathlib import Path

    import httpx

    from app.services.fx.collector import collect_once
    from app.services.fx.store import Store

    payload = json.loads((Path(__file__).parent / "fixtures/fx/bcrp.txt").read_text())
    payload["config"]["series"][0]["name"] = None

    def respond(request):
        if request.url.host == "estadisticas.bcrp.gob.pe":
            if failure == "series_name":
                return httpx.Response(200, json=payload)
            return httpx.Response(429, headers={"Retry-After": failure})
        return httpx.Response(200, text='<b id="valcompra">3.43</b><b id="valventa">3.46</b>')

    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda: original(transport=httpx.MockTransport(respond)))
    cloud = Cloud()
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        store.save("dollarhouse", [observation("dollarhouse", NOW - timedelta(days=1))], NOW)
        result = collect_once(store, cloud, ["bcrp", "kambista"], now=NOW)
        assert result == dict(seen=1, written=2, failed=1)
        assert store.pending() == []
        assert not store.due("bcrp", NOW + timedelta(minutes=14))
        assert store.due("bcrp", NOW + timedelta(minutes=15))
    assert {row["source"] for row in cloud.rows.values()} == {"dollarhouse", "kambista"}
