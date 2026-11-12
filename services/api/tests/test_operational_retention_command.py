"""The Pi maintenance command must be bounded and dry-run by default."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts/prune-operational-history.py"


def load_command():
    spec = importlib.util.spec_from_file_location("prune_operational_history", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class Client:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def rpc(self, name, params):
        self.calls.append((name, params))
        return next(self.responses)


def test_dry_run_queries_once_without_apply():
    command = load_command()
    client = Client([{"applied": False, "airfare_import_runs": 12, "collector_requests": 7}])
    result = command.prune(client, apply=False)
    assert result == {
        "applied": False,
        "airfare_import_runs": 12,
        "collector_requests": 7,
        "more_possible": False,
    }
    assert client.calls == [("prune_operational_history", {"p_apply": False, "p_batch_size": 500})]


def test_apply_repeats_only_until_both_tables_are_empty():
    command = load_command()
    client = Client(
        [
            {"applied": True, "airfare_import_runs": 500, "collector_requests": 3},
            {"applied": True, "airfare_import_runs": 2, "collector_requests": 0},
            {"applied": True, "airfare_import_runs": 0, "collector_requests": 0},
        ]
    )
    result = command.prune(client, apply=True)
    assert result == {
        "applied": True,
        "airfare_import_runs": 502,
        "collector_requests": 3,
        "more_possible": False,
    }
    assert len(client.calls) == 3


def test_apply_stops_at_bounded_batch_count():
    command = load_command()
    client = Client([{"applied": True, "airfare_import_runs": 500, "collector_requests": 500}] * 2)
    result = command.prune(client, apply=True, max_batches=2)
    assert result["more_possible"] is True
    assert len(client.calls) == 2


def test_rejects_malformed_rpc_result():
    command = load_command()
    client = Client([{"applied": True, "airfare_import_runs": -1, "collector_requests": 0}])
    with pytest.raises(ValueError, match="invalid retention response"):
        command.prune(client, apply=True)


def test_main_defaults_to_read_only(monkeypatch, capsys):
    command = load_command()
    client = Client([{"applied": False, "airfare_import_runs": 2, "collector_requests": 1}])
    monkeypatch.setattr(
        command,
        "collector_config",
        lambda: SimpleNamespace(
            url="https://testproject.supabase.co", secret_key="sb_secret_test", timeout_seconds=15
        ),
    )
    monkeypatch.setattr(command, "SupabaseAirfare", lambda *args, **kwargs: client)
    client.close = lambda: None
    assert command.main([]) == 0
    assert '"applied": false' in capsys.readouterr().out
    assert client.calls[0][1]["p_apply"] is False


def test_neon_retention_uses_database_rpc_and_stays_read_only(monkeypatch, capsys):
    command = load_command()

    class Cloud:
        def __init__(self):
            self.calls = []

        def prune_operational_history(self, *, apply, batch_size):
            self.calls.append((apply, batch_size))
            return {"applied": apply, "airfare_import_runs": 0, "collector_requests": 2}

        def close(self):
            pass

    cloud = Cloud()
    monkeypatch.setenv("COLLECTOR_DATA_BACKEND", "neon")
    monkeypatch.setattr(command.NeonCollectorCloud, "from_environment", lambda: cloud)

    assert command.main([]) == 0
    assert cloud.calls == [(False, 500)]
    assert '"collector_requests": 2' in capsys.readouterr().out
