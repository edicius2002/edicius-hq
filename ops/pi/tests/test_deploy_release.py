"""Operator-facing checks for the reusable Pi release launcher."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

PI_ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = PI_ROOT.parents[1] / "deploy-pi.cmd"
POWERSHELL = PI_ROOT / "deploy.ps1"
REMOTE = PI_ROOT / "deploy-release.sh"
COMMIT = "aeb835d32c1d4cbfeceafcf2edd56b3d190b1a24"


@pytest.mark.skipif(shutil.which("pwsh") is None, reason="PowerShell is unavailable")
def test_whatif_accepts_a_pinned_commit_without_contacting_pi() -> None:
    output = subprocess.run(
        [
            "pwsh",
            "-NoProfile",
            "-File",
            str(POWERSHELL),
            "-Commit",
            COMMIT,
            "-WhatIf",
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert output.returncode == 0, output.stderr
    assert COMMIT in output.stdout
    assert "pi-bodas" in output.stdout


@pytest.mark.skipif(shutil.which("pwsh") is None, reason="PowerShell is unavailable")
def test_whatif_resolves_main_once_without_contacting_pi(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    if os.name == "nt":
        fake_git = fake_bin / "git.cmd"
        fake_git.write_text(f"@echo {COMMIT} refs/heads/main\n", encoding="utf-8")
    else:
        fake_git = fake_bin / "git"
        fake_git.write_text(
            f"#!/bin/sh\necho '{COMMIT} refs/heads/main'\n", encoding="utf-8"
        )
        fake_git.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = str(fake_bin) + os.pathsep + env["PATH"]

    output = subprocess.run(
        ["pwsh", "-NoProfile", "-File", str(POWERSHELL), "-WhatIf"],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
        env=env,
    )

    assert output.returncode == 0, output.stderr
    assert COMMIT in output.stdout


def test_launcher_is_reusable_and_remote_script_guards_the_switch() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")
    powershell = POWERSHELL.read_text(encoding="utf-8")
    remote = REMOTE.read_text(encoding="utf-8")

    assert "deploy.ps1" in launcher
    assert "refs/heads/main" in powershell
    assert "-tt" in powershell
    assert "sudo" in powershell
    assert powershell.index("ShouldProcess") < powershell.index("mktemp -d")
    assert "git pull" not in remote
    assert "set -euo pipefail" in remote
    assert remote.index("pip install") < remote.index('systemctl stop "${timers[@]}"')
    assert remote.index("flock -n") < remote.index('ln -sfn -- "$release"')
    assert "restore_previous_release" in remote
    assert "systemctl is-active --quiet" in remote


def test_rollback_stops_new_workers_before_restoring_old_release() -> None:
    remote = REMOTE.read_text(encoding="utf-8")
    rollback = remote[
        remote.index("restore_previous_release()") : remote.index(
            "trap restore_previous_release EXIT"
        )
    ]
    stop = rollback.index('systemctl stop "${workers[@]}" "${timers[@]}"')
    relink = rollback.index('ln -sfn -- "$previous_release"')
    start = rollback.rindex('systemctl start "${workers[@]}" "${timers[@]}"')
    assert stop < relink < start
