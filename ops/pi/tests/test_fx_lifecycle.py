"""Checks that a pinned Pi release can install, pause, verify and drop the FX collector."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

PI_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PI_ROOT.parents[1]
SYSTEMD = PI_ROOT / "systemd"
SERVICE = SYSTEMD / "edicius-fx.service"
TIMER = SYSTEMD / "edicius-fx.timer"
INSTALL = PI_ROOT / "install.sh"
DEPLOY = PI_ROOT / "deploy-release.sh"
VERIFY = PI_ROOT / "verify.sh"
RUNBOOK = REPO_ROOT / "docs" / "pi-collectors-runbook.md"


def load_check_run():
    spec = importlib.util.spec_from_file_location("check_collector_run_fx", PI_ROOT / "check-collector-run.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_fx_service_is_a_hardened_oneshot_running_the_pinned_cli() -> None:
    text = SERVICE.read_text(encoding="utf-8")
    assert "Type=oneshot" in text
    assert "User=edicius-collector" in text
    assert "EnvironmentFile=/etc/edicius-hq/collectors.env" in text
    assert "LOCAL_DATA_DIR=/var/lib/edicius-hq" in text
    assert "ReadWritePaths=/var/lib/edicius-hq" in text
    assert "ProtectSystem=strict" in text
    assert "NoNewPrivileges=true" in text
    assert "/opt/edicius-hq/current/scripts/fx-collect.py" in text
    assert "TimeoutStartSec=10min" in text
    assert "/usr/bin/flock" not in text


def test_fx_timer_runs_every_five_minutes_with_jitter_and_catch_up() -> None:
    text = TIMER.read_text(encoding="utf-8")
    assert "OnCalendar=*-*-* *:0/5:00" in text
    assert "OnBootSec=2min" in text
    assert "Persistent=true" in text
    assert "RandomizedDelaySec=30" in text
    assert "Unit=edicius-fx.service" in text
    assert "WantedBy=timers.target" in text


def test_installer_ships_fx_units_and_precreates_its_outbox_and_lock() -> None:
    text = INSTALL.read_text(encoding="utf-8")
    units = text[text.index("install_units() {") :]
    assert "edicius-fx.service" in units and "edicius-fx.timer" in units
    # The state root and lock directory are root-owned, so the collector cannot create these itself.
    assert "for runtime_dir in x-profile kv bars sentiment codex-resets fx; do" in text
    assert "for lock_name in airfare sentiment tweets market fx; do" in text
    assert "systemctl enable" not in text


def test_entrypoint_owns_the_fx_lock_and_outbox_under_durable_state() -> None:
    text = (REPO_ROOT / "scripts" / "fx-collect.py").read_text(encoding="utf-8")
    assert 'exclusive_process_lock("fx")' in text
    assert 'local_data_dir() / "fx" / "outbox.sqlite"' in text


def test_deploy_pauses_the_fx_timer_only_when_it_was_enabled() -> None:
    text = DEPLOY.read_text(encoding="utf-8")
    assert "optional_timers=(edicius-fx.timer)" in text
    adopt = text.index('for unit in "${optional_timers[@]}"; do')
    assert text.index("timers=(edicius-airfare.timer edicius-sentiment.timer)") < adopt
    assert adopt < text.index('systemctl stop "${timers[@]}"')
    assert 'timers+=("$unit")' in text
    # Waiting covers every paused timer's service, FX included.
    assert 'for timer in "${timers[@]}"; do' in text
    assert 'service="${timer%.timer}.service"' in text


def test_rollback_does_not_restart_fx_on_a_release_without_its_unit() -> None:
    text = DEPLOY.read_text(encoding="utf-8")
    rollback = text[text.index("restore_previous_release()") : text.index("trap restore_previous_release EXIT")]
    relink = rollback.index('ln -sfn -- "$previous_release" "$current_link"')
    drop = rollback.index('drop_timers_missing_from "$previous_release"')
    start = rollback.rindex('systemctl start "${workers[@]}" "${timers[@]}"')
    assert relink < drop < start
    assert '[[ -e "$root/ops/pi/systemd/$unit" ]]' in text


def test_verify_checks_fx_units_and_offers_an_explicit_live_fx_pass() -> None:
    text = VERIFY.read_text(encoding="utf-8")
    assert '"$SCRIPT_DIR/systemd/edicius-fx.service" "$SCRIPT_DIR/systemd/edicius-fx.timer"' in text
    assert "fx) unit=edicius-fx.timer ;;" in text
    assert '"$CURRENT_LINK/scripts/fx-collect.py"' in text
    assert "usage: verify.sh [--live [sentiment|x-posts|market|fx]]" in text


def test_health_check_accepts_the_fx_oneshot() -> None:
    module = load_check_run()
    assert "fx" in module.COLLECTORS


def test_npm_exposes_fx_collect_through_the_api_dispatcher() -> None:
    scripts = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert scripts["fx:collect"] == "node scripts/api.mjs fx-collect"
    dispatcher = (REPO_ROOT / "scripts" / "api.mjs").read_text(encoding="utf-8")
    assert "'fx-collect': [['../../scripts/fx-collect.py', ...process.argv.slice(3)]]" in dispatcher
    assert "  'fx-collect',\n" in dispatcher


def test_runbook_documents_fx_activation_backfill_and_rollback() -> None:
    text = RUNBOOK.read_text(encoding="utf-8")
    section = text[text.index("## USD/PEN collector") :]
    assert "20260929000000_fx_observations.sql" in section
    assert "verify.sh --live fx" in section
    assert "systemctl enable --now edicius-fx.timer" in section
    assert "--backfill-from" in section
    assert "systemctl disable --now edicius-fx.timer" in section
    assert "begins at activation" in section
