"""Exercise the real remote journal pipeline against Airfare log messages."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

CUTOVER = Path(__file__).resolve().parents[1] / "cutover.ps1"
GIT_BASH = Path("C:/Program Files/Git/bin/bash.exe")


@pytest.mark.parametrize(
    ("message", "healthy"),
    [
        (
            "51 looked at, 51 changed, 0 failed, 408 skipped -> /var/lib/edicius-hq/fares",
            True,
        ),
        (
            "51 looked at, 50 changed, 1 failed, 408 skipped -> /var/lib/edicius-hq/fares",
            False,
        ),
        (
            "51 looked at, 41 changed, 10 failed, 408 skipped -> /var/lib/edicius-hq/fares",
            False,
        ),
        (
            "51 looked at, 51 changed, 0 failed, 408 skipped\nERROR replica sync rejected",
            False,
        ),
        ("51 looked at, 51 changed, 0 failed, 408 skipped; fatal sync failure", False),
        ("Failed to start Edicius Airfare collector pass.", False),
    ],
)
def test_airfare_journal_gate_distinguishes_zero_failures_from_real_errors(
    message: str, healthy: bool
) -> None:
    bash = (
        str(GIT_BASH) if os.name == "nt" and GIT_BASH.exists() else shutil.which("bash")
    )
    assert bash is not None, "Bash is required to exercise the Pi journal pipeline"
    line = next(
        line.strip()
        for line in CUTOVER.read_text(encoding="utf-8").splitlines()
        if "journalctl -u edicius-airfare.service" in line and "grep -Eiq" in line
    )
    command = line.removeprefix('Invoke-PiChecked "').removesuffix('"')
    # Only the external journal source is replaced; sed/grep and exit semantics
    # execute exactly as the cutover invokes them on the Pi.
    script = 'sudo() { printf "%s\\n" "$TASK11_TEST_JOURNAL"; }; ' + command
    result = subprocess.run(
        [bash, "--noprofile", "--norc", "-c", script],
        env={**os.environ, "TASK11_TEST_JOURNAL": message},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == (0 if healthy else 1), result.stderr
