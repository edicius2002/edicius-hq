"""Match actual Debian 13 systemd success messages, not stop/start attempts."""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

CUTOVER = Path(__file__).resolve().parents[1] / "cutover.ps1"
GIT_BASH = Path("C:/Program Files/Git/bin/bash.exe")


@pytest.mark.parametrize(
    ("collector", "message", "healthy"),
    [
        ("x-posts", "Started edicius-tweets.service - Edicius X post collector.", True),
        (
            "market",
            "Started edicius-market.service - Edicius market collector worker.",
            True,
        ),
        (
            "airfare",
            "Finished edicius-airfare.service - Edicius Airfare collector pass.",
            True,
        ),
        (
            "x-posts",
            "Stopped edicius-tweets.service - Edicius X post collector.",
            False,
        ),
        (
            "market",
            "Starting edicius-market.service - Edicius market collector worker...",
            False,
        ),
        (
            "airfare",
            "Starting edicius-airfare.service - Edicius Airfare collector pass...",
            False,
        ),
    ],
)
def test_collector_journal_gate_accepts_only_completed_systemd_transition(
    collector: str, message: str, healthy: bool
) -> None:
    source = CUTOVER.read_text(encoding="utf-8")
    if collector == "airfare":
        line = next(
            line.strip()
            for line in source.splitlines()
            if "journalctl -u edicius-airfare.service" in line and "grep -Fq" in line
        )
    else:
        mapping = next(
            line for line in source.splitlines() if f"Name = '{collector}'" in line
        )
        marker = re.search(r"JournalMarker = '([^']+)'", mapping)
        assert marker is not None
        line = next(
            line.strip()
            for line in source.splitlines()
            if "grep -Fq '$($Collector.JournalMarker)'" in line
        )
        line = line.replace("$($Collector.JournalMarker)", marker.group(1))
        line = line.replace("$($Collector.Service)", "test-collector.service")
    command = line.removeprefix('Invoke-PiChecked "').removesuffix('"')
    bash = (
        str(GIT_BASH) if os.name == "nt" and GIT_BASH.exists() else shutil.which("bash")
    )
    assert bash is not None
    result = subprocess.run(
        [
            bash,
            "--noprofile",
            "--norc",
            "-c",
            'sudo() { printf "%s\\n" "$TASK11_TEST_JOURNAL"; }; ' + command,
        ],
        env={**os.environ, "TASK11_TEST_JOURNAL": message},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == (0 if healthy else 1), result.stderr
