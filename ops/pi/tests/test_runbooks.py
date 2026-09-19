"""Static safety checks for the Pi cutover operator tooling."""

from pathlib import Path


PI_ROOT = Path(__file__).resolve().parents[1]
CUTOVER = PI_ROOT / "cutover.ps1"
ROLLBACK = PI_ROOT / "rollback.ps1"
IMPORT_X_PROFILE = PI_ROOT / "import-x-profile.sh"
CHECK_RUN = PI_ROOT / "check-collector-run.py"
SMOKE_COLLECTOR = PI_ROOT / "smoke-collector.py"
STAGED_TRANSFER = PI_ROOT / "install-staged-transfer.sh"
RUNBOOK = PI_ROOT.parents[1] / "docs" / "pi-collectors-runbook.md"


def test_cutover_checks_pi_before_disabling_windows_task() -> None:
    text = CUTOVER.read_text(encoding="utf-8")
    preflight = text.index("Assert-PiPreflight", text.index("$task = Get-ExactTask"))
    assert text.index("verify.sh") < text.index("Stop-WindowsAirfare", preflight)
    assert "Edicius airfare" in text
    assert "Get-ScheduledTask -TaskName $TaskName" in text
    assert "Where-Object { $_.TaskName -eq $TaskName }" in text
    assert "Remove-Item" not in text
    assert "Invoke-Expression" not in text


def test_cutover_requires_disabled_pi_units_before_windows_change() -> None:
    text = CUTOVER.read_text(encoding="utf-8")
    assert "is-enabled" in text
    assert "is-active" in text
    preflight = text.index("Assert-PiPreflight", text.index("$task = Get-ExactTask"))
    assert preflight < text.index("Stop-WindowsAirfare", preflight)
    assert "SupportsShouldProcess" in text


def test_cutover_uses_a_read_only_loopback_watcher_probe_before_windows_airfare_is_disabled() -> (
    None
):
    text = CUTOVER.read_text(encoding="utf-8")
    assert "LegacyApiBase" in text
    assert "127\\.0\\.0\\.1" in text
    assert '"$LegacyApiBase/api/tweets/thsottiaux/refresh"' in text
    assert "Invoke-LegacyRefreshProbe" in text
    assert "-Method Get" in text
    assert "StatusCode -ne 200" in text
    preflight = text.index("Assert-PiPreflight")
    windows_disable = text.index("Stop-WindowsAirfare", preflight)
    assert text.index("Invoke-LegacyRefreshProbe", preflight) < windows_disable
    assert (
        "Invoke-LegacyWatchRequest -Method Delete"
        not in text[preflight:windows_disable]
    )


def test_cutover_gates_exact_collector_mappings_in_order_with_fresh_rows_and_logs() -> (
    None
):
    text = CUTOVER.read_text(encoding="utf-8")
    assert "edicius-airfare.timer" in text
    assert "edicius-sentiment.timer" in text
    assert "edicius-tweets.service" in text
    assert "edicius-market.service" in text
    assert (
        text.index("edicius-sentiment.timer")
        < text.index("edicius-tweets.service")
        < text.index("edicius-market.service")
        < text.index("edicius-airfare.timer")
    )
    assert "Get-Date).ToUniversalTime()" in text
    assert "check-collector-run.py" in text
    assert "--since" in text
    assert "--require-complete" in text
    assert "foreach ($unit in $Units)" not in text
    assert "grep -q ." not in text
    assert "JournalMarker" in text
    for marker in (
        "Finished Edicius Airfare collector pass.",
        "Finished Edicius sentiment collector pass.",
        "Started Edicius X post collector.",
        "Started Edicius market collector worker.",
    ):
        assert marker in text
    assert "grep -Eiq 'error|fatal|failed|failure'" in text
    assert text.index("JournalMarker") < text.index("error|fatal|failed|failure")


def test_airfare_cutover_stops_waits_disables_and_rechecks_windows_task_last() -> None:
    text = CUTOVER.read_text(encoding="utf-8")
    airfare_branch = text.index("if ($collector.Name -eq 'airfare')")
    handoff = text.index("Stop-WindowsAirfare", airfare_branch)
    pi_start = text.index("Start-And-GatePiCollector $collector", airfare_branch)
    function = text.index("function Stop-WindowsAirfare")
    stop = text.index("Stop-ScheduledTask", function)
    deadline = text.index("AddSeconds", function)
    wait = text.index("Start-Sleep", function)
    disable = text.index("Disable-ScheduledTask", function)
    recheck = text.index("Get-ExactTask", disable)
    assert stop < deadline < wait < disable < recheck
    assert handoff < pi_start
    assert "State -eq 'Running'" in text
    assert "State -ne 'Disabled'" in text
    declined = text.index("Windows Airfare stop was declined", airfare_branch)
    smoke = text.index("Invoke-PiDisabledSmoke $collector", airfare_branch)
    assert declined < smoke


def test_rollback_stops_pi_before_reenabling_exact_windows_task() -> None:
    text = ROLLBACK.read_text(encoding="utf-8")
    assert text.index("systemctl disable --now") < text.index("Enable-ScheduledTask")
    assert "Edicius airfare" in text
    assert "Remove-Item" not in text
    assert "truncate" not in text.lower()
    assert "SupportsShouldProcess" in text


def test_x_cutover_stops_and_verifies_pc_watcher_before_starting_pi_x() -> None:
    text = CUTOVER.read_text(encoding="utf-8")
    x_cutover = text.index("if ($collector.Name -eq 'x-posts')")
    stop = text.index("Assert-LegacyWatchStopped", x_cutover)
    x_start = text.index("Start-And-GatePiCollector $collector", x_cutover)
    assert stop < x_start
    assert "Invoke-LegacyWatchRequest -Method Delete" in text
    assert "@('stopped', 'idle')" in text
    assert "edicius-tweets.service" in text
    assert "PC X watcher remains stopped" in text


def test_cutover_consumes_disabled_unit_live_smokes_before_enabling_each_collector() -> None:
    text = CUTOVER.read_text(encoding="utf-8")
    smoke_function = text.index("function Invoke-PiDisabledSmoke")
    for command in (
        "--live sentiment",
        "--live x-posts",
        "--live market",
        "systemctl start edicius-airfare.service",
    ):
        assert text.index(command, smoke_function) < text.index("function Start-And-GatePiCollector")
    loop = text.index("foreach ($collector in $Collectors)")
    x_stop = text.index("Assert-LegacyWatchStopped", loop)
    airfare_stop = text.index("Stop-WindowsAirfare", loop)
    smoke = text.index("Invoke-PiDisabledSmoke $collector", loop)
    enable = text.index("Start-And-GatePiCollector $collector", loop)
    assert x_stop < smoke < enable
    assert airfare_stop < smoke < enable


def test_x_cutover_failure_state_marks_delete_attempt_before_its_outcome_is_confirmed() -> (
    None
):
    text = CUTOVER.read_text(encoding="utf-8")
    x_cutover = text.index("if ($collector.Name -eq 'x-posts')")
    attempted = text.index(
        "$legacyWatcherStopState = 'attempted-unconfirmed'", x_cutover
    )
    delete = text.index("Assert-LegacyWatchStopped", x_cutover)
    confirmed = text.index("$legacyWatcherStopState = 'confirmed-stopped'", x_cutover)
    assert attempted < delete < confirmed
    assert "$legacyWatcherStopState = 'not-attempted'" in text
    assert "PC X watcher stop was attempted but its outcome is unconfirmed" in text
    assert "PC X watcher was not changed" in text


def test_rollback_stops_and_confirms_every_pi_collector_before_restarting_pc_x() -> (
    None
):
    text = ROLLBACK.read_text(encoding="utf-8")
    assert "LegacyApiBase" in text
    assert '"$LegacyApiBase/api/tweets/thsottiaux/watch"' in text
    assert "Assert-AllPiCollectorsStopped" in text
    assert "Invoke-LegacyWatchRequest -Method Post" in text
    assert "StatusCode -ne 202" in text
    assert "state -ne 'watching'" in text
    rollback = text.index("try {")
    all_stopped = text.index("Assert-AllPiCollectorsStopped", rollback)
    restart = text.index("Invoke-LegacyWatchRequest -Method Post", all_stopped)
    assert all_stopped < restart < text.index("Enable-ScheduledTask")


def test_x_profile_import_refuses_unsafe_paths_and_live_replacement() -> None:
    text = IMPORT_X_PROFILE.read_text(encoding="utf-8")
    assert "set -euo pipefail" in text
    assert "--replace-with-backup" in text
    assert "diff -qr --no-dereference" in text
    assert '[[ -z "$(find "$TARGET" -mindepth 1 -print -quit)" ]]' in text
    assert '[[ ! -L "$BACKUP_ROOT" ]]' in text
    assert 'backup_root_real="$(readlink -f -- "$BACKUP_ROOT")"' in text
    assert "readlink -f" in text
    assert "-L" in text
    assert "find" in text and "-type l" in text
    assert "readonly SERVICE_USER=edicius-collector" in text
    assert 'chown -R "$SERVICE_USER:$SERVICE_USER"' in text
    assert "chmod -R go-rwx" in text
    identical = text.index("X profile is already imported")
    dry_run_guard = text.rfind('if [[ "$dry_run" == true ]]', 0, identical)
    ownership = text.rfind('chown -R "$SERVICE_USER:$SERVICE_USER" "$TARGET"', 0, identical)
    assert dry_run_guard > 0
    assert dry_run_guard < ownership
    assert text.rfind('chown -R "$SERVICE_USER:$SERVICE_USER" "$TARGET"', 0, identical) > 0
    assert text.rfind('chmod -R go-rwx "$TARGET"', 0, identical) > 0
    assert "rm -rf" not in text
    assert "Cookies" not in text


def test_collector_run_helper_reads_secret_file_locally_and_never_accepts_secrets() -> (
    None
):
    text = CHECK_RUN.read_text(encoding="utf-8")
    assert "/etc/edicius-hq/collectors.env" in text
    assert "SUPABASE_SECRET_KEY" in text
    assert "--cutoff" in text
    assert "--wait-seconds" in text
    assert "started_at" in text
    assert "--secret" not in text
    assert "metadata = ENV_FILE.stat()" in text
    assert "metadata.st_uid != 0" in text
    assert "metadata.st_gid != 0" in text
    assert "metadata.st_mode & 0o777 != 0o600" in text
    assert "ENV_FILE.is_symlink()" in text
    assert "ALLOWED_ENV_NAMES" in text
    assert "trust_env=False" in text


def test_live_smoke_uses_local_secret_file_and_bounded_one_shots() -> None:
    smoke = SMOKE_COLLECTOR.read_text(encoding="utf-8")
    verify = (PI_ROOT / "verify.sh").read_text(encoding="utf-8")
    assert "ENV_FILE.read_text" not in smoke
    assert "ALLOWED_ENV_NAMES" in smoke
    assert "trust_env=False" in smoke
    assert "SUPABASE_SECRET_KEY" in smoke
    assert "--secret" not in smoke
    assert '"--once"' in smoke
    assert "tweets-watch.py" in smoke
    assert "market-worker.py" in smoke
    assert "smoke-collector.py" in verify
    assert "/etc/edicius-hq/collectors.env" in verify
    assert "systemctl is-enabled" in verify
    assert "systemctl is-active" in verify


def test_staged_transfer_is_fixed_destination_and_removes_only_validated_tmp_stage() -> (
    None
):
    text = STAGED_TRANSFER.read_text(encoding="utf-8")
    assert "set -euo pipefail" in text
    assert 'case "$kind"' in text
    assert '[[ "$stage_real" == /tmp/edicius-transfer.* ]]' in text
    assert "readonly SERVICE_USER=edicius-collector" in text
    assert 'install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750' in text
    assert '[[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]]' in text
    assert '[[ -d "$MIGRATION_ROOT" && ! -L "$MIGRATION_ROOT" ]]' in text
    assert 'state_root_real="$(readlink -f -- "$STATE_ROOT")"' in text
    assert 'migration_root_real="$(readlink -f -- "$MIGRATION_ROOT")"' in text
    assert '[[ "$migration_root_real" == "$state_root_real/migration-input" ]]' in text
    assert 'find "$target_real" -type f -exec chmod 0600 {} +' in text
    assert 'rm -rf -- "$stage_real"' in text


def test_runbook_declares_only_two_human_only_actions_and_required_checkpoints() -> (
    None
):
    text = RUNBOOK.read_text(encoding="utf-8")
    assert text.count("HUMAN-ONLY") == 2
    for required in (
        "collectors.env",
        "MFA",
        "exact pinned commit",
        "schema",
        "owner bootstrap",
        "app-document import",
        "X JSONL",
        "Airfare",
        "Chromium",
        "disabled",
        "one-shot",
        "seven-day",
        "rollback",
        "supabase link",
        "db push",
        "sha256sum",
        "scp -r",
        "Docker",
        "python3 -m venv",
    ):
        assert required.lower() in text.lower()
