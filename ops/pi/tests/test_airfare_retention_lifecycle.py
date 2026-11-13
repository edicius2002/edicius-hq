"""Retention timer stays dormant until a supervised first run verifies."""

import os
import subprocess
import sys
from configparser import ConfigParser
from pathlib import Path

import pytest

PI_ROOT = Path(__file__).resolve().parents[1]
REPO = PI_ROOT.parents[1]


def unit(name: str) -> ConfigParser:
    config = ConfigParser(interpolation=None, strict=False)
    config.optionxform = str
    config.read_string((PI_ROOT / "systemd" / name).read_text(encoding="utf-8"))
    return config


def test_retention_service_shares_the_pi_archive_and_collection_exclusion() -> None:
    retention = unit("edicius-airfare-retention.service")["Service"]
    collector = unit("edicius-airfare.service")["Service"]
    for setting in ("User", "Group", "WorkingDirectory", "EnvironmentFile", "ReadWritePaths"):
        assert retention[setting] == collector[setting]
    assert "LOCAL_DATA_DIR=/var/lib/edicius-hq" in retention["Environment"]
    assert retention["ExecStart"].startswith(
        "/usr/bin/flock -n -E 75 /var/lib/edicius-hq/locks/airfare.lock "
    )
    assert retention["ExecStart"].endswith("/scripts/fares-retention.py --apply")
    assert retention["TimeoutStartSec"] == "2h"


def test_daily_utc_timer_is_installed_but_not_enabled() -> None:
    timer = unit("edicius-airfare-retention.timer")
    assert timer["Timer"]["OnCalendar"] == "*-*-* 04:17:00 UTC"
    assert timer["Timer"]["Persistent"] == "true"
    assert timer["Timer"]["Unit"] == "edicius-airfare-retention.service"
    install = (PI_ROOT / "install.sh").read_text(encoding="utf-8")
    verify = (PI_ROOT / "verify.sh").read_text(encoding="utf-8")
    for name in ("edicius-airfare-retention.service", "edicius-airfare-retention.timer"):
        assert name in install[install.index("install_units() {") :]
        assert f'"$SCRIPT_DIR/systemd/{name}"' in verify
    assert "systemctl enable" not in install


@pytest.mark.skipif(sys.platform == "win32", reason="Pi uses POSIX advisory locks")
def test_crashed_holder_releases_maintenance_lock(tmp_path: Path) -> None:
    code = (
        "from pathlib import Path; from app.services.airfare_retention_gate import maintenance_lock; "
        "import sys,time; "
        "\nwith maintenance_lock(Path(sys.argv[1])):\n print('ready',flush=True); time.sleep(60)"
    )
    env = {**os.environ, "PYTHONPATH": str(REPO / "services/api")}
    holder = subprocess.Popen(
        [sys.executable, "-c", code, str(tmp_path / "fares")],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "ready"
        holder.kill()
        holder.wait(timeout=3)
        successor = subprocess.run(
            [sys.executable, "-c", code.replace("time.sleep(60)", "pass"), str(tmp_path / "fares")],
            capture_output=True, text=True, env=env, timeout=3, check=True,
        )
        assert successor.stdout.strip() == "ready"
    finally:
        if holder.poll() is None:
            holder.kill()
            holder.wait(timeout=3)
