from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_preview_is_installed_without_automatic_activation():
    install = (ROOT / "install.sh").read_text()
    assert "systemd/edicius-seace-preview.service" in install
    assert "systemctl enable" not in install
    deploy = (ROOT / "deploy-release.sh").read_text()
    assert "is-enabled edicius-seace-preview.service" in deploy
    assert "workers+=(edicius-seace-preview.service)" in deploy
    assert "systemctl stop edicius-seace-preview.service" in deploy
    assert (
        '"$unit" != edicius-seace-preview.service || -e "$root/ops/pi/systemd/$unit"'
        in deploy
    )


def test_preview_is_an_outbound_unprivileged_service():
    unit = (ROOT / "systemd/edicius-seace-preview.service").read_text()
    for setting in (
        "User=edicius-collector",
        "ProtectSystem=strict",
        "ProtectHome=true",
        "Restart=on-failure",
        "EnvironmentFile=/etc/edicius-hq/seace-preview.env",
        "MemoryMax=384M",
        "TimeoutStopSec=10min",
    ):
        assert setting in unit
    assert "--host" not in unit


def test_failed_downgrade_restores_original_worker_activation_before_restart():
    deploy = (ROOT / "deploy-release.sh").read_text()
    assert 'previous_workers=("${workers[@]}")' in deploy
    rollback = deploy.split("restore_previous_release() {", 1)[1].split(
        "trap restore_previous_release", 1
    )[0]
    restore = rollback.index('workers=("${previous_workers[@]}")')
    enable = rollback.index("if (( preview_disabled_by_deploy == 1 ))", restore)
    drop = rollback.index('drop_timers_missing_from "$previous_release"', enable)
    restart = rollback.index('systemctl start "${workers[@]}" "${timers[@]}"', drop)
    assert restore < enable < drop < restart
    worker_restore = rollback[
        restore : rollback.index('for unit in "${previous_timers[@]}"', restore)
    ]
    assert (
        '" ${previous_workers[*]} " == *" edicius-seace-preview.service "*'
        in worker_restore
    )
    assert "systemctl enable edicius-seace-preview.service" in worker_restore
    assert 'systemctl enable "$unit"' not in worker_restore


def test_only_dropping_preview_records_that_activation_must_be_restored():
    deploy = (ROOT / "deploy-release.sh").read_text()
    drop = deploy.split("drop_timers_missing_from() {", 1)[1].split("\n}", 1)[0]
    timer_drop, worker_drop = drop.split('for unit in "${workers[@]}"; do', 1)
    assert "preview_disabled_by_deploy=1" not in timer_drop
    assert worker_drop.index('systemctl disable "$unit"') < worker_drop.index(
        "preview_disabled_by_deploy=1"
    )
