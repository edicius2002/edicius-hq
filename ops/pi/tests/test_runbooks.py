"""Static safety checks for the Pi cutover operator tooling."""

from pathlib import Path


PI_ROOT = Path(__file__).resolve().parents[1]
CUTOVER = PI_ROOT / "cutover.ps1"
ROLLBACK = PI_ROOT / "rollback.ps1"
IMPORT_X_PROFILE = PI_ROOT / "import-x-profile.sh"
RUNBOOK = PI_ROOT.parents[1] / "docs" / "pi-collectors-runbook.md"


def test_cutover_checks_pi_before_disabling_windows_task() -> None:
    text = CUTOVER.read_text(encoding="utf-8")
    assert text.index("verify.sh") < text.index("Disable-ScheduledTask")
    assert 'Edicius airfare' in text
    assert 'Get-ScheduledTask -TaskName $TaskName' in text
    assert 'Where-Object { $_.TaskName -eq $TaskName }' in text
    assert "Remove-Item" not in text
    assert "Invoke-Expression" not in text


def test_cutover_requires_disabled_pi_units_before_windows_change() -> None:
    text = CUTOVER.read_text(encoding="utf-8")
    assert "is-enabled" in text
    assert "is-active" in text
    assert text.index("Assert-PiPreflight") < text.index("Disable-ScheduledTask")
    assert "SupportsShouldProcess" in text


def test_rollback_stops_pi_before_reenabling_exact_windows_task() -> None:
    text = ROLLBACK.read_text(encoding="utf-8")
    assert text.index("systemctl disable --now") < text.index("Enable-ScheduledTask")
    assert 'Edicius airfare' in text
    assert "Remove-Item" not in text
    assert "truncate" not in text.lower()
    assert "SupportsShouldProcess" in text


def test_x_profile_import_refuses_unsafe_paths_and_live_replacement() -> None:
    text = IMPORT_X_PROFILE.read_text(encoding="utf-8")
    assert "set -euo pipefail" in text
    assert "--replace-with-backup" in text
    assert "diff -qr --no-dereference" in text
    assert "readlink -f" in text
    assert "-L" in text
    assert "find" in text and "-type l" in text
    assert "chown -R edicius:edicius" in text
    assert "chmod -R go-rwx" in text
    assert "rm -rf" not in text
    assert "Cookies" not in text


def test_runbook_declares_only_two_human_only_actions_and_required_checkpoints() -> None:
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
    ):
        assert required.lower() in text.lower()
