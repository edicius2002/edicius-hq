"""Retention is packaged but cannot run before the migration preflight."""

from pathlib import Path

PI = Path(__file__).resolve().parents[1]


def test_retention_unit_is_a_bounded_daily_collector_job():
    service = (PI / "systemd/edicius-retention.service").read_text(encoding="utf-8")
    timer = (PI / "systemd/edicius-retention.timer").read_text(encoding="utf-8")
    assert "Type=oneshot" in service
    assert "User=edicius-collector" in service
    assert "EnvironmentFile=/etc/edicius-hq/collectors.env" in service
    assert "scripts/prune-operational-history.py --apply" in service
    assert "ProtectSystem=strict" in service
    assert "NoNewPrivileges=true" in service
    assert "OnCalendar=*-*-* 08:15:00 UTC" in timer
    assert "Persistent=true" in timer
    assert "RandomizedDelaySec=30" in timer


def test_install_and_verify_gate_the_timer_without_early_activation():
    install = (PI / "install.sh").read_text(encoding="utf-8")
    verify = (PI / "verify.sh").read_text(encoding="utf-8")
    for name in ("edicius-retention.service", "edicius-retention.timer"):
        assert name in install
        assert f'"$SCRIPT_DIR/systemd/{name}"' in verify
    assert '"$CURRENT_LINK/scripts/prune-operational-history.py"' in verify
    assert "systemctl enable" not in install


def test_release_tracks_retention_timer_and_stops_service_on_rollback():
    deploy = (PI / "deploy-release.sh").read_text(encoding="utf-8")
    assert "optional_timers+=(edicius-retention.timer)" in deploy
    assert "systemctl enable edicius-retention.timer" not in deploy
    assert "systemctl stop edicius-retention.service" in deploy
    assert deploy.index('"$release/ops/pi/verify.sh"') < deploy.rindex(
        'systemctl start "${workers[@]}" "${timers[@]}"'
    )
