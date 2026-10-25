import json
import os
import sqlite3
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


def test_existing_fx_sqlite_gains_durable_source_health(tmp_path):
    from app.services.fx.store import Store

    path = tmp_path / "fx.sqlite"
    with sqlite3.connect(path) as db:
        db.execute(
            "create table due(owner text, source text, next_at real not null, primary key(owner,source))"
        )
    with Store(path, OWNER) as store:
        store.save(
            "kambista",
            [observation("kambista", NOW)],
            NOW + timedelta(minutes=4),
            attempted_at=NOW,
        )
        store.save(
            "kambista",
            [],
            NOW + timedelta(minutes=9),
            attempted_at=NOW + timedelta(minutes=5),
            error_code="missing-quote",
        )
        assert store.status("kambista") == {
            "source": "kambista",
            "last_attempt": NOW + timedelta(minutes=5),
            "last_success": NOW,
            "last_error": "missing-quote",
            "consecutive_failures": 1,
            "next_due": NOW + timedelta(minutes=9),
        }
    with Store(path, OWNER) as store:
        assert store.status("kambista")["last_success"] == NOW
        store.save(
            "kambista",
            [observation("kambista", NOW + timedelta(minutes=10))],
            NOW + timedelta(minutes=14),
            attempted_at=NOW + timedelta(minutes=10),
        )
        assert store.status("kambista")["last_error"] is None
        assert store.status("kambista")["consecutive_failures"] == 0
        assert store.status("kambista")["last_success"] == NOW + timedelta(minutes=10)


def test_first_malformed_kambista_response_retries_next_slot_then_backs_off(tmp_path):
    from app.services.fx.collector import collect_once
    from app.services.fx.providers import ProviderError
    from app.services.fx.store import Store

    def malformed(*_args):
        raise ProviderError("missing-quote", delay=900)

    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        assert collect_once(store, Cloud(), ["kambista"], now=NOW, fetcher=malformed)["failed"] == 1
        assert store.due("kambista", NOW + timedelta(minutes=5))
        assert (
            collect_once(
                store, Cloud(), ["kambista"], now=NOW + timedelta(minutes=5), fetcher=malformed
            )["failed"]
            == 1
        )
        assert not store.due("kambista", NOW + timedelta(minutes=10))
        assert store.due("kambista", NOW + timedelta(minutes=20))


def test_kambista_rate_limit_keeps_provider_retry_after(tmp_path):
    from app.services.fx.collector import collect_once
    from app.services.fx.providers import ProviderError
    from app.services.fx.store import Store

    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        collect_once(
            store,
            Cloud(),
            ["kambista"],
            now=NOW,
            fetcher=lambda *_args: (_ for _ in ()).throw(ProviderError("rate-limited", 1800)),
        )
        assert not store.due("kambista", NOW + timedelta(minutes=5))
        assert store.due("kambista", NOW + timedelta(minutes=30))


def test_stale_skipped_source_marks_pass_failed_without_fetching(tmp_path):
    from app.services.fx.collector import collect_once
    from app.services.fx.store import Store

    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        store.save(
            "kambista",
            [observation("kambista", NOW - timedelta(minutes=20))],
            NOW + timedelta(minutes=10),
            attempted_at=NOW - timedelta(minutes=20),
        )
        result = collect_once(
            store,
            Cloud(),
            ["kambista"],
            now=NOW,
            fetcher=lambda *_args: pytest.fail("source should remain on cooldown"),
        )
    assert result == dict(seen=0, written=1, failed=1)


def test_fx_status_cli_reads_local_source_health_without_cloud(tmp_path):
    from app.services.fx.store import Store

    data_dir = tmp_path / "data"
    path = data_dir / "fx" / "outbox.sqlite"
    with Store(path, OWNER) as store:
        store.save("kambista", [], NOW + timedelta(minutes=4), attempted_at=NOW)
    env = {**os.environ, "LOCAL_DATA_DIR": str(data_dir), "EDICIUS_OWNER_ID": str(OWNER)}
    env.pop("SUPABASE_URL", None)
    env.pop("SUPABASE_SECRET_KEY", None)
    script = Path(__file__).resolve().parents[3] / "scripts" / "fx-collect.py"
    result = subprocess.run(
        [sys.executable, str(script), "--status"], env=env, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    rows = json.loads(result.stdout)
    kambista = next(row for row in rows if row["source"] == "kambista")
    assert kambista["last_success"] == NOW.isoformat()
    assert kambista["next_due"] == (NOW + timedelta(minutes=4)).isoformat()
    assert kambista["consecutive_failures"] == 0


def test_fx_status_cli_reports_missing_local_database_cleanly(tmp_path):
    script = Path(__file__).resolve().parents[3] / "scripts" / "fx-collect.py"
    env = {**os.environ, "LOCAL_DATA_DIR": str(tmp_path), "EDICIUS_OWNER_ID": str(OWNER)}
    result = subprocess.run(
        [sys.executable, str(script), "--status"], env=env, capture_output=True, text=True
    )
    assert result.returncode == 1
    assert "FX status unavailable" in result.stderr
    assert "Traceback" not in result.stderr


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


def test_reference_challenge_fails_both_sources_from_one_request(tmp_path, monkeypatch):
    import httpx

    from app.services.fx.collector import collect_once
    from app.services.fx.store import Store

    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, text="<script>/_Incapsula_Resource</script>")

    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda: original(transport=httpx.MockTransport(respond)))
    with Store(tmp_path / "fx.sqlite", OWNER) as store:
        result = collect_once(store, Cloud(), ["bcrp", "sbs"], now=NOW)
        for source in ("bcrp", "sbs"):
            health = store.status(source)
            assert health["last_error"] == "challenge-page"
            assert health["consecutive_failures"] == 1
    assert len(requests) == 1
    assert result == dict(seen=0, written=0, failed=2)


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
