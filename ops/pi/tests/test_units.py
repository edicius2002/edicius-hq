"""Static safety checks for the Raspberry Pi systemd package.

These tests intentionally inspect the shipped files rather than a host system:
the package is authored on Windows but executes only on the Pi.
"""

from __future__ import annotations

from pathlib import Path

import pytest


PI_ROOT = Path(__file__).resolve().parents[1]
SYSTEMD = PI_ROOT / "systemd"
INSTALL = PI_ROOT / "install.sh"
VERIFY = PI_ROOT / "verify.sh"
SERVICES = tuple(SYSTEMD / f"edicius-{name}.service" for name in ("airfare", "sentiment", "tweets", "market"))
TIMERS = tuple(SYSTEMD / f"edicius-{name}.timer" for name in ("airfare", "sentiment"))


@pytest.mark.parametrize("unit", SERVICES)
def test_services_are_unprivileged_network_aware_and_secret_file_backed(unit: Path) -> None:
    text = unit.read_text(encoding="utf-8")
    assert "User=edicius" in text
    assert "After=network-online.target" in text
    assert "Wants=network-online.target" in text
    assert "EnvironmentFile=/etc/edicius-hq/collectors.env" in text
    assert "0.0.0.0" not in text
    assert "--host" not in text
    assert "ServiceRole" not in text


@pytest.mark.parametrize("unit", SERVICES)
def test_services_are_pinned_and_write_only_under_durable_state(unit: Path) -> None:
    text = unit.read_text(encoding="utf-8")
    assert "/opt/edicius-hq/current/" in text
    assert "WorkingDirectory=/opt/edicius-hq/current" in text
    assert "LOCAL_DATA_DIR=/var/lib/edicius-hq" in text
    assert "ProtectSystem=strict" in text
    assert "ReadWritePaths=/var/lib/edicius-hq" in text
    assert "NoNewPrivileges=true" in text
    assert "PrivateTmp=true" in text


@pytest.mark.parametrize("unit", TIMERS)
def test_oneshot_timers_are_persistent_and_jittered(unit: Path) -> None:
    text = unit.read_text(encoding="utf-8")
    assert "OnCalendar=" in text
    assert "Persistent=true" in text
    assert "RandomizedDelaySec=30" in text


def test_airfare_timer_runs_every_fifteen_minutes() -> None:
    assert "OnCalendar=*-*-* *:0/15:00" in (SYSTEMD / "edicius-airfare.timer").read_text(encoding="utf-8")


def test_sentiment_timer_runs_every_four_hours() -> None:
    assert "OnCalendar=*-*-* 0/4:00:00" in (SYSTEMD / "edicius-sentiment.timer").read_text(encoding="utf-8")


@pytest.mark.parametrize("unit", (SYSTEMD / "edicius-airfare.service", SYSTEMD / "edicius-sentiment.service"))
def test_oneshots_use_nonblocking_flock(unit: Path) -> None:
    text = unit.read_text(encoding="utf-8")
    assert "Type=oneshot" in text
    assert "/usr/bin/flock -n" in text


@pytest.mark.parametrize("unit", (SYSTEMD / "edicius-tweets.service", SYSTEMD / "edicius-market.service"))
def test_workers_restart_with_bounded_systemd_backoff(unit: Path) -> None:
    text = unit.read_text(encoding="utf-8")
    assert "Restart=on-failure" in text
    assert "RestartSec=15" in text
    assert "TimeoutStopSec=60" in text


def test_verify_uses_fixed_state_and_active_release_working_directory() -> None:
    text = VERIFY.read_text(encoding="utf-8")
    assert 'export LOCAL_DATA_DIR="$STATE_ROOT"' in text
    assert 'cd -- "$CURRENT_LINK"' in text
    assert 'readonly PYTHON="$CURRENT_LINK/services/api/.venv/bin/python"' in text


def test_verify_validates_then_loads_a_non_symlink_root_owned_secret_file() -> None:
    text = VERIFY.read_text(encoding="utf-8")
    assert '[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]]' in text
    assert 'stat -c \'%u\' -- "$ENV_FILE"' in text
    assert 'stat -c \'%a\' -- "$ENV_FILE"' in text
    assert "validate_env" in text and "load_env" in text
    assert text.index("validate_env") < text.index("load_env")
    assert 'export "$name=$value"' in text
    assert '. "$ENV_FILE"' not in text


def test_verify_only_runs_sentiment_after_an_explicit_live_gate() -> None:
    text = VERIFY.read_text(encoding="utf-8")
    assert 'readonly LIVE="${1:-}"' in text
    assert '[[ "$LIVE" == --live ]]' in text
    assert text.index('[[ "$LIVE" == --live ]]') < text.rindex("run_sentiment_test")
    assert "sentiment live test skipped (rerun with --live to run it)" in text


def test_verify_market_discovery_is_read_only_and_never_starts_the_worker() -> None:
    text = VERIFY.read_text(encoding="utf-8")
    assert "cloud.documents" in text
    assert "market-worker.py" not in text
    assert "market:worker" not in text


def test_installer_refuses_unpinned_releases_and_never_enables_or_starts_units() -> None:
    text = INSTALL.read_text(encoding="utf-8")
    assert 'expected="$RELEASES_ROOT/$commit"' in text
    assert '[[ "$active" == "$expected" ]]' in text
    assert "systemctl daemon-reload" in text
    assert "systemctl enable" not in text
    assert "systemctl start" not in text


def test_installer_rejects_symlinked_or_non_root_secret_files() -> None:
    text = INSTALL.read_text(encoding="utf-8")
    assert '[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]]' in text
    assert 'stat -c \'%u\' -- "$ENV_FILE"' in text


def test_scripts_do_not_embed_or_print_secret_values() -> None:
    text = INSTALL.read_text(encoding="utf-8") + VERIFY.read_text(encoding="utf-8")
    assert "sb_secret_" not in text
    assert "SUPABASE_SECRET_KEY=" not in text
    assert "printenv" not in text
