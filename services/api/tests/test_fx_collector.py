import subprocess
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from uuid import UUID

import pytest

NOW = datetime(2026, 10, 2, 18, tzinfo=UTC)
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
        assert store.due("kambista", NOW + timedelta(minutes=5))


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


def test_reference_reconcile_only_writes_history_from_lima_october_first(tmp_path):
    from app.services.fx.collector import collect_once
    from app.services.fx.models import HISTORY_START, Observation
    from app.services.fx.store import Store

    cloud = Cloud()
    days = [HISTORY_START - timedelta(days=1), HISTORY_START, HISTORY_START + timedelta(days=1)]
    rows = [Observation("bcrp", NOW, day, Decimal("3.43"), Decimal("3.46")) for day in days]
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        result = collect_once(store, cloud, ["bcrp"], now=NOW, fetcher=lambda *args: rows)
        assert store.pending() == []
    assert result == dict(seen=3, written=2, failed=0)
    assert {row["effective_at"] for row in cloud.rows.values()} == {
        day.isoformat() for day in days[1:]
    }


def test_commercial_capture_before_history_start_is_not_written(tmp_path):
    from app.services.fx.collector import collect_once
    from app.services.fx.models import HISTORY_START
    from app.services.fx.store import Store

    clock = HISTORY_START - timedelta(seconds=1)
    cloud = Cloud()
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        result = collect_once(
            store,
            cloud,
            ["kambista"],
            now=clock,
            fetcher=lambda source, _client, now, *_range: [observation(source, now)],
        )
        assert store.pending() == []
    assert result == dict(seen=1, written=0, failed=0)
    assert cloud.rows == {}


def test_existing_outbox_drops_pre_start_rows_before_replay(tmp_path):
    from app.services.fx.collector import collect_once
    from app.services.fx.models import HISTORY_START
    from app.services.fx.store import Store

    cloud = Cloud()
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        store.save("bcrp", [observation("bcrp", HISTORY_START - timedelta(days=1))], NOW)
        result = collect_once(store, cloud, ["kambista"], now=NOW, fetcher=lambda *_args: [])
        assert store.pending() == []
    assert result == dict(seen=0, written=0, failed=0)
    assert cloud.rows == {}


def test_cli_rejects_backfill_option():
    script = Path(__file__).resolve().parents[3] / "scripts" / "fx-collect.py"
    result = subprocess.run(
        [sys.executable, str(script), "--backfill-from", "1997-01-02"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert "unrecognized arguments: --backfill-from" in result.stderr


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


def test_reference_sources_share_one_http_request_per_reconcile(tmp_path, monkeypatch):
    import json
    from pathlib import Path

    import httpx

    from app.services.fx.collector import collect_once
    from app.services.fx.store import Store

    payload = json.loads((Path(__file__).parent / "fixtures/fx/bcrp.txt").read_text())
    payload["periods"][0]["name"] = "01.Oct.26"
    payload["periods"] = payload["periods"][:1]
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


@pytest.mark.parametrize(
    ("source", "interval"), (("kambista", timedelta(minutes=5)), ("bcrp", timedelta(hours=4)))
)
def test_next_timer_pass_is_due_even_when_it_starts_with_less_jitter(tmp_path, source, interval):
    from app.services.fx.collector import collect_once
    from app.services.fx.store import Store

    # edicius-fx.timer fires every 5 minutes with up to 30 seconds of random delay.
    previous = NOW + timedelta(seconds=30)
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        collect_once(
            store, Cloud(), [source], now=previous, fetcher=lambda s, c, n, *a: [observation(s, n)]
        )
        assert not store.due(source, previous + interval - timedelta(minutes=1, seconds=1))
        assert store.due(source, NOW + interval)
        if source == "bcrp":
            assert not store.due(source, NOW + timedelta(minutes=5))
