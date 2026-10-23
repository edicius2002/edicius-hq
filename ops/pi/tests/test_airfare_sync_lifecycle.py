"""Independent replica recovery must survive failed Airfare collection passes."""

from configparser import ConfigParser
from pathlib import Path

PI_ROOT = Path(__file__).resolve().parents[1]
SYSTEMD = PI_ROOT / "systemd"


def unit_settings(name: str) -> ConfigParser:
    # systemd permits repeated Environment directives; only LOCAL_DATA_DIR is
    # compared here, and it is the final Environment directive in both units.
    config = ConfigParser(interpolation=None, strict=False)
    config.optionxform = str
    config.read_string((SYSTEMD / name).read_text(encoding="utf-8"))
    return config


def test_global_sync_runs_the_unscoped_cli_with_the_collector_identity_and_archive() -> (
    None
):
    service = unit_settings("edicius-airfare-sync.service")["Service"]
    collector = unit_settings("edicius-airfare.service")["Service"]
    for setting in (
        "User",
        "Group",
        "WorkingDirectory",
        "EnvironmentFile",
        "ReadWritePaths",
    ):
        assert service[setting] == collector[setting]
    assert "LOCAL_DATA_DIR=/var/lib/edicius-hq" in service["Environment"]
    assert "Type" in service and service["Type"] == "oneshot"
    assert service["TimeoutStartSec"] == "10min"
    assert service["ProtectSystem"] == "strict"
    assert service["NoNewPrivileges"] == "true"
    command = service["ExecStart"]
    assert command.endswith("/scripts/fares-supabase.py --apply --incremental")
    assert "/current/services/api/.venv/bin/python " in command
    assert "fares-collect.py" not in command


def test_global_sync_skips_a_busy_collector_without_competing_for_archive_cursors() -> (
    None
):
    service = unit_settings("edicius-airfare-sync.service")["Service"]
    assert service["ExecStart"].startswith(
        "/usr/bin/flock -n -E 75 /var/lib/edicius-hq/locks/airfare.lock "
    )
    assert service["SuccessExitStatus"] == "75"
    repo = PI_ROOT.parents[1]
    process_lock = (repo / "services/api/app/services/process_lock.py").read_text(
        encoding="utf-8"
    )
    assert 'lock_dir = local_data_dir() / "locks"' in process_lock
    assert 'lock_path = lock_dir / f"{name}.lock"' in process_lock
    scheduled = (repo / "scripts/fares-collect.py").read_text(encoding="utf-8")
    manual = (repo / "services/api/app/services/airfare_request_worker.py").read_text(
        encoding="utf-8"
    )
    assert 'exclusive_process_lock("airfare")' in scheduled
    assert 'self._lock_factory("airfare")' in manual


def test_global_sync_timer_retries_after_failure_and_catches_up_after_restart() -> None:
    timer = unit_settings("edicius-airfare-sync.timer")
    assert timer["Timer"]["OnCalendar"] == "*-*-* *:07,37:00"
    assert timer["Timer"]["OnBootSec"] == "3min"
    assert timer["Timer"]["Persistent"] == "true"
    assert timer["Timer"]["RandomizedDelaySec"] == "30"
    assert timer["Timer"]["Unit"] == "edicius-airfare-sync.service"
    assert timer["Install"]["WantedBy"] == "timers.target"
    service = unit_settings("edicius-airfare-sync.service")
    for config in (timer, service):
        unit = config["Unit"]
        assert not any(
            "edicius-airfare.service" in unit.get(setting, "")
            for setting in ("Requires", "Requisite", "BindsTo", "After", "PartOf")
        )


def test_global_sync_units_are_installed_and_verified_without_installer_activation() -> (
    None
):
    install = (PI_ROOT / "install.sh").read_text(encoding="utf-8")
    verify = (PI_ROOT / "verify.sh").read_text(encoding="utf-8")
    for name in ("edicius-airfare-sync.service", "edicius-airfare-sync.timer"):
        assert name in install[install.index("install_units() {") :]
        assert f'"$SCRIPT_DIR/systemd/{name}"' in verify
    assert "systemctl enable" not in install
    assert "systemctl start" not in install


def test_deployment_activates_global_sync_after_verification_and_tracks_existing_timer() -> (
    None
):
    deploy = (PI_ROOT / "deploy-release.sh").read_text(encoding="utf-8")
    assert "optional_timers+=(edicius-airfare-sync.timer " in deploy
    activate = deploy.index("systemctl enable edicius-airfare-sync.timer")
    assert deploy.index('"$release/ops/pi/verify.sh"') < activate
    assert activate < deploy.rindex('systemctl start "${workers[@]}" "${timers[@]}"')
    assert '[[ -f "$release/ops/pi/systemd/edicius-airfare-sync.service"' in deploy
    assert '-f "$release/ops/pi/systemd/edicius-airfare-sync.timer" ]]' in deploy
    assert "timers+=(edicius-airfare-sync.timer)" in deploy
    assert 'drop_timers_missing_from "$release"' in deploy


def test_rollback_stops_global_sync_and_disables_a_timer_missing_from_the_old_release() -> (
    None
):
    deploy = (PI_ROOT / "deploy-release.sh").read_text(encoding="utf-8")
    rollback = deploy[
        deploy.index("restore_previous_release()") : deploy.index(
            "trap restore_previous_release EXIT"
        )
    ]
    stop = rollback.index("systemctl stop edicius-airfare-sync.service")
    assert stop < rollback.index('ln -sfn -- "$previous_release"')
    drop = deploy[
        deploy.index("drop_timers_missing_from()") : deploy.index(
            "restore_previous_release()"
        )
    ]
    assert 'systemctl disable "$unit"' in drop


def test_rollback_restores_timers_enabled_before_a_downgrade() -> None:
    deploy = (PI_ROOT / "deploy-release.sh").read_text(encoding="utf-8")
    snapshot = deploy.index('previous_timers=("${timers[@]}")')
    assert snapshot < deploy.index('systemctl stop "${timers[@]}"')
    rollback = deploy[
        deploy.index("restore_previous_release()") : deploy.index(
            "trap restore_previous_release EXIT"
        )
    ]
    restore = rollback.index('for unit in "${previous_timers[@]}"; do')
    assert rollback.index('"$previous_release/ops/pi/install.sh"') < restore
    assert restore < rollback.index('drop_timers_missing_from "$previous_release"')
    assert 'systemctl enable "$unit"' in rollback
    assert 'timers+=("$unit")' in rollback


def test_release_transition_invalidates_baseline_ack_before_any_writer_restarts() -> (
    None
):
    deploy = (PI_ROOT / "deploy-release.sh").read_text(encoding="utf-8")
    invalidation = deploy[
        deploy.index("invalidate_baseline_ack()") : deploy.index(
            "restore_previous_release()"
        )
    ]
    assert "fares/sync/baseline-ack" in invalidation
    assert (
        'for component in "$state_root" "$state_root/fares" "$state_root/fares/sync" "$checkpoint_root"; do'
        in invalidation
    )
    assert '[[ ! -L "$component" ]]' in invalidation
    assert '[[ -d "$checkpoint_root" ]]' in invalidation
    assert 'rm -f -- "$checkpoint_root"/*.json' in invalidation

    normal = deploy[
        deploy.index("echo 'Waiting for scheduled collector passes to finish.'") :
    ]
    assert (
        normal.index("systemctl stop edicius-tweets.service edicius-market.service")
        < normal.index("invalidate_baseline_ack")
        < normal.index('systemctl start "${workers[@]}" "${timers[@]}"')
    )

    rollback = deploy[
        deploy.index("restore_previous_release()") : deploy.index(
            "trap restore_previous_release EXIT"
        )
    ]
    assert rollback.index("invalidate_baseline_ack") < rollback.index(
        'systemctl start "${workers[@]}" "${timers[@]}" || echo'
    )
