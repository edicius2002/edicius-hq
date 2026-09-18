"""Static safety checks for the Raspberry Pi systemd package.

These tests intentionally inspect the shipped files rather than a host system:
the package is authored on Windows but executes only on the Pi.
"""

from __future__ import annotations

from pathlib import Path

import pytest


PI_ROOT = Path(__file__).resolve().parents[1]
SYSTEMD = PI_ROOT / "systemd"
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
    assert "OnBootSec=2min" in text
    assert "Persistent=true" in text
    assert "RandomizedDelaySec=30" in text


def test_airfare_timer_runs_every_fifteen_minutes() -> None:
    assert "OnUnitActiveSec=15min" in (SYSTEMD / "edicius-airfare.timer").read_text(encoding="utf-8")


def test_sentiment_timer_runs_every_four_hours() -> None:
    assert "OnUnitActiveSec=4h" in (SYSTEMD / "edicius-sentiment.timer").read_text(encoding="utf-8")


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
