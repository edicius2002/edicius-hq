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
    assert "User=edicius-collector" in text
    assert "Group=edicius-collector" in text
    assert "User=edicius\n" not in text
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


@pytest.mark.parametrize("unit", TIMERS)
def test_timers_run_two_minutes_after_boot_without_losing_calendar_jitter_or_persistence(unit: Path) -> None:
    text = unit.read_text(encoding="utf-8")
    assert "OnBootSec=2min" in text
    assert "OnCalendar=" in text
    assert "Persistent=true" in text
    assert "RandomizedDelaySec=30" in text


def test_airfare_oneshot_has_a_bounded_twenty_minute_start_timeout() -> None:
    text = (SYSTEMD / "edicius-airfare.service").read_text(encoding="utf-8")
    assert "Type=oneshot" in text
    assert "TimeoutStartSec=20min" in text


@pytest.mark.parametrize("unit", (SYSTEMD / "edicius-airfare.service", SYSTEMD / "edicius-sentiment.service"))
def test_oneshots_delegate_process_locking_to_the_entrypoint(unit: Path) -> None:
    text = unit.read_text(encoding="utf-8")
    assert "Type=oneshot" in text
    assert "/usr/bin/flock" not in text


@pytest.mark.parametrize("unit", (SYSTEMD / "edicius-tweets.service", SYSTEMD / "edicius-market.service"))
def test_workers_restart_with_bounded_systemd_backoff(unit: Path) -> None:
    text = unit.read_text(encoding="utf-8")
    assert "Restart=on-failure" in text
    assert "RestartSec=15" in text
    assert "TimeoutStopSec=60" in text


@pytest.mark.parametrize("unit", (SYSTEMD / "edicius-tweets.service", SYSTEMD / "edicius-market.service"))
def test_long_running_workers_can_be_enabled_only_at_controlled_cutover(unit: Path) -> None:
    text = unit.read_text(encoding="utf-8")
    assert "[Install]" in text
    assert "WantedBy=multi-user.target" in text


@pytest.mark.parametrize(
    "unit,script_name",
    (
        (SYSTEMD / "edicius-tweets.service", "tweets-watch.py"),
        (SYSTEMD / "edicius-market.service", "market-worker.py"),
    ),
)
def test_long_running_workers_delegate_process_locking_to_the_entrypoint(
    unit: Path, script_name: str
) -> None:
    text = unit.read_text(encoding="utf-8")
    assert "/usr/bin/flock" not in text
    assert script_name in text


@pytest.mark.parametrize(
    "script_name,lock_name",
    (
        ("fares-collect.py", "airfare"),
        ("sentiment-collect.py", "sentiment"),
        ("tweets-watch.py", "tweets"),
        ("market-worker.py", "market"),
    ),
)
def test_each_entrypoint_owns_a_distinct_nonblocking_process_lock(
    script_name: str, lock_name: str
) -> None:
    text = (PI_ROOT.parents[1] / "scripts" / script_name).read_text(encoding="utf-8")
    assert "exclusive_process_lock" in text
    assert f'exclusive_process_lock("{lock_name}")' in text


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


def test_verify_only_runs_a_collector_after_an_explicit_live_gate() -> None:
    text = VERIFY.read_text(encoding="utf-8")
    assert 'readonly LIVE="${1:-}"' in text
    assert '[[ "$LIVE" == --live ]]' in text
    assert text.index('[[ "$LIVE" == --live ]]') < text.rindex("run_sentiment_test")
    assert "live collector test skipped (rerun with --live to run one)" in text


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


def test_installer_precreates_private_edicius_owned_entrypoint_locks() -> None:
    text = INSTALL.read_text(encoding="utf-8")
    for lock_name in ("airfare", "sentiment", "tweets", "market"):
        assert lock_name in text
    assert "readonly SERVICE_USER=edicius-collector" in text
    assert 'install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 /dev/null "$lock_path"' in text
    reject_directory_symlink = text.index('[[ ! -L "$STATE_ROOT/locks" ]]')
    create_directory = text.index(
        'install -d -o root -g "$SERVICE_USER" -m 0750 "$STATE_ROOT/locks"'
    )
    assert reject_directory_symlink < create_directory
    assert 'install -d -o root -g "$SERVICE_USER" -m 0750 "$STATE_ROOT/locks"' in text
    assert 'root:$SERVICE_USER:750' in text
    reject_symlink = text.index('[[ ! -L "$lock_path" ]]')
    create = text.index(
        'install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 /dev/null "$lock_path"'
    )
    assert reject_symlink < create
    assert '[[ -f "$lock_path" && ! -L "$lock_path" ]]' in text
    assert "stat -c '%U:%G:%a'" in text
    assert '$SERVICE_USER:$SERVICE_USER:600' in text


def test_installer_never_repairs_or_reuses_the_interactive_edicius_login() -> None:
    text = INSTALL.read_text(encoding="utf-8")
    assert "getent passwd edicius-collector" not in text
    assert 'getent passwd "$SERVICE_USER"' in text
    assert 'useradd --system --user-group --home-dir "$STATE_ROOT"' in text


def test_live_verification_runs_collectors_as_the_service_identity() -> None:
    text = VERIFY.read_text(encoding="utf-8")
    assert "readonly SERVICE_USER=edicius-collector" in text
    assert "systemd-run --quiet --wait --pipe --collect" in text
    assert '--uid="$SERVICE_USER"' in text
    assert 'EnvironmentFile=$ENV_FILE' in text
    assert 'Environment=HOME=$STATE_ROOT' in text
    assert 'Environment=LOCAL_DATA_DIR=$STATE_ROOT' in text
    assert 'Environment=X_SCRAPER_PROFILE=$STATE_ROOT/x-profile' in text
    assert "--preserve-environment" not in text


def test_installer_normalizes_existing_symlink_free_durable_state() -> None:
    text = INSTALL.read_text(encoding="utf-8")
    assert 'find "$STATE_ROOT" -xdev -type l -print -quit' in text
    assert 'chown -R --no-dereference "$SERVICE_USER:$SERVICE_USER" "$STATE_ROOT"' in text
    assert 'chown "$SERVICE_USER:$SERVICE_USER" "$lock_path"' in text
    assert 'chmod 0600 "$lock_path"' in text


def test_install_and_verify_reject_dirty_or_untracked_release_files() -> None:
    for script in (INSTALL, VERIFY):
        text = script.read_text(encoding="utf-8")
        assert "git -C" in text
        assert "status --porcelain --untracked-files=all" in text
        assert "release checkout is not clean" in text


def test_installer_accepts_debian_native_python_313_without_dropping_312_compatibility() -> None:
    text = INSTALL.read_text(encoding="utf-8")
    assert "(3, 12), (3, 13)" in text
    assert "Python 3.12 or 3.13 is required" in text


def test_installer_rejects_symlinked_or_non_root_secret_files() -> None:
    text = INSTALL.read_text(encoding="utf-8")
    assert '[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]]' in text
    assert 'stat -c \'%u\' -- "$ENV_FILE"' in text


def test_scripts_do_not_embed_or_print_secret_values() -> None:
    text = INSTALL.read_text(encoding="utf-8") + VERIFY.read_text(encoding="utf-8")
    assert "sb_secret_" not in text
    assert "SUPABASE_SECRET_KEY=" not in text
    assert "printenv" not in text
