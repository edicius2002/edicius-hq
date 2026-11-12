"""Production-marked Pi updates preserve the active release on failures."""

from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

import pytest

PI_ROOT = Path(__file__).resolve().parents[1]


def load_updater():
    spec = importlib.util.spec_from_file_location(
        "auto_update", PI_ROOT / "auto_update.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_verifier():
    spec = importlib.util.spec_from_file_location(
        "verify_approved_release", PI_ROOT / "verify_approved_release.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def repository(tmp_path: Path) -> tuple[Path, Path, Path, str]:
    origin = tmp_path / "origin"
    origin.mkdir()
    git(origin, "init", "-q")
    git(origin, "config", "user.name", "Test")
    git(origin, "config", "user.email", "test@example.invalid")
    script = origin / "ops" / "pi" / "deploy-release.sh"
    script.parent.mkdir(parents=True)
    script.write_text("#!/usr/bin/env bash\necho initial\n", encoding="utf-8")
    git(origin, "add", ".")
    git(origin, "commit", "-qm", "initial")
    first = git(origin, "rev-parse", "HEAD")
    git(origin, "branch", "pi-production")
    root = tmp_path / "app"
    releases = root / "releases"
    releases.mkdir(parents=True)
    active = releases / first
    subprocess.run(["git", "clone", "-q", str(origin), str(active)], check=True)
    git(active, "checkout", "-q", "--detach", first)
    (root / "current").symlink_to(active, target_is_directory=True)
    return origin, root, script, first


def promote(origin: Path, script: Path, content: str) -> str:
    script.write_text(content, encoding="utf-8")
    git(origin, "add", ".")
    git(origin, "commit", "-qm", "promote")
    commit = git(origin, "rev-parse", "HEAD")
    git(origin, "branch", "-f", "pi-production", commit)
    return commit


@pytest.mark.skipif(os.name == "nt", reason="fcntl and directory symlinks need Linux")
def test_unchanged_production_ref_skips_deployment(tmp_path: Path) -> None:
    origin, root, _script, _first = repository(tmp_path)

    def unexpected(*_args):
        raise AssertionError("unchanged ref must not deploy")

    assert (
        load_updater().update(str(origin), root, tmp_path / "deploy.lock", unexpected)
        is None
    )


@pytest.mark.skipif(os.name == "nt", reason="fcntl and directory symlinks need Linux")
def test_new_descendant_uses_its_script_while_holding_deployment_lock(
    tmp_path: Path,
) -> None:
    import fcntl

    origin, root, script, first = repository(tmp_path)
    target = promote(origin, script, "#!/usr/bin/env bash\necho promoted\n")
    observed: list[str] = []
    lock = tmp_path / "deploy.lock"

    def invoke(staged: Path, commit: str, fd: int) -> None:
        observed.append(staged.read_text(encoding="utf-8"))
        assert commit == target
        assert os.readlink(f"/proc/self/fd/{fd}") == str(lock)
        with lock.open("rb") as second_handle, pytest.raises(BlockingIOError):
            fcntl.flock(second_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    assert load_updater().update(str(origin), root, lock, invoke) == target
    assert observed == ["#!/usr/bin/env bash\necho promoted\n"]
    assert (root / "current").resolve().name == first


@pytest.mark.skipif(os.name == "nt", reason="fcntl and directory symlinks need Linux")
def test_production_ref_rewind_cannot_downgrade_active_release(tmp_path: Path) -> None:
    origin, root, script, _first = repository(tmp_path)
    active_commit = promote(origin, script, "#!/usr/bin/env bash\necho active\n")
    active = root / "releases" / active_commit
    subprocess.run(["git", "clone", "-q", str(origin), str(active)], check=True)
    git(active, "checkout", "-q", "--detach", active_commit)
    (root / "current").unlink()
    (root / "current").symlink_to(active, target_is_directory=True)
    first = git(origin, "rev-list", "--max-parents=0", "HEAD")
    git(origin, "branch", "-f", "pi-production", first)

    with pytest.raises(ValueError, match="ancestor"):
        load_updater().update(
            str(origin), root, tmp_path / "deploy.lock", lambda *_: None
        )
    assert (root / "current").resolve().name == active_commit


@pytest.mark.skipif(os.name == "nt", reason="fcntl and directory symlinks need Linux")
def test_unavailable_remote_leaves_current_release_untouched(tmp_path: Path) -> None:
    _origin, root, _script, first = repository(tmp_path)

    with pytest.raises(subprocess.CalledProcessError):
        load_updater().update(
            str(tmp_path / "missing-repository"),
            root,
            tmp_path / "deploy.lock",
            lambda *_: None,
        )
    assert (root / "current").resolve().name == first


@pytest.mark.skipif(
    os.name == "nt", reason="fcntl and inherited file descriptors need Linux"
)
def test_child_deployment_can_reuse_parent_lock_descriptor(tmp_path: Path) -> None:
    import fcntl

    lock = tmp_path / "deploy.lock"
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        environment = os.environ.copy()
        environment["EDICIUS_DEPLOY_LOCK_FD"] = str(fd)
        environment["EXPECTED_LOCK"] = str(lock)
        subprocess.run(
            [
                "bash",
                "-c",
                '[[ "$(readlink -f -- "/proc/self/fd/$EDICIUS_DEPLOY_LOCK_FD")" == "$EXPECTED_LOCK" ]] && flock -n "$EDICIUS_DEPLOY_LOCK_FD"',
            ],
            env=environment,
            pass_fds=(fd,),
            check=True,
        )
    finally:
        os.close(fd)


def test_timer_and_installer_use_approved_ref_only() -> None:
    service = (PI_ROOT / "systemd/edicius-pi-update.service").read_text(
        encoding="utf-8"
    )
    timer = (PI_ROOT / "systemd/edicius-pi-update.timer").read_text(encoding="utf-8")
    installer = (PI_ROOT / "install.sh").read_text(encoding="utf-8")
    deploy = (PI_ROOT / "deploy-release.sh").read_text(encoding="utf-8")
    updater = (PI_ROOT / "auto_update.py").read_text(encoding="utf-8")

    assert "refs/heads/pi-production" in updater
    assert "refs/heads/main" not in updater
    assert "OnCalendar=*-*-* 08:11:00 UTC" in timer
    assert "Persistent=true" in timer
    assert "auto_update.py" in service
    assert "edicius-pi-update.service" in installer
    assert "edicius-pi-update.timer" in installer
    assert "optional_timers+=(edicius-pi-update.timer)" in deploy
    assert "systemctl enable edicius-pi-update.timer" not in deploy


@pytest.mark.skipif(os.name == "nt", reason="Bash deployment runs on Linux")
def test_deployment_wait_does_not_wait_for_its_own_update_service() -> None:
    deploy = (PI_ROOT / "deploy-release.sh").read_text(encoding="utf-8")
    wait = deploy.split("echo 'Waiting for scheduled collector passes to finish.'", 1)[
        1
    ].split("# Hold the same lock as manual Airfare work", 1)[0]
    result = subprocess.run(
        [
            "bash",
            "-c",
            """set -euo pipefail
timers=(edicius-airfare.timer edicius-pi-update.timer)
paused=0
systemctl() {
  if [[ "$1" == show && "$4" == edicius-pi-update.service ]]; then
    echo active
  elif [[ "$1" == show ]]; then
    echo inactive
  fi
}
sleep() { return 42; }
"""
            + wait,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(os.name == "nt", reason="Git fixture uses Linux symlinks")
def test_final_verification_rejects_ref_advance_after_selection(tmp_path: Path) -> None:
    origin, root, script, first = repository(tmp_path)
    selected = promote(origin, script, "#!/usr/bin/env bash\necho selected\n")
    promote(origin, script, "#!/usr/bin/env bash\necho newer\n")

    with pytest.raises(ValueError, match="changed"):
        load_verifier().verify(str(origin), root / "releases" / first, selected)


@pytest.mark.skipif(os.name == "nt", reason="Git fixture uses Linux symlinks")
def test_final_verification_accepts_current_descendant(tmp_path: Path) -> None:
    origin, root, script, first = repository(tmp_path)
    selected = promote(origin, script, "#!/usr/bin/env bash\necho selected\n")

    load_verifier().verify(str(origin), root / "releases" / first, selected)


def test_automatic_deployment_rechecks_before_preparation() -> None:
    deploy = (PI_ROOT / "deploy-release.sh").read_text(encoding="utf-8")
    updater = (PI_ROOT / "auto_update.py").read_text(encoding="utf-8")

    assert '["bash", str(script), commit, "--auto"]' in updater
    assert deploy.index('verify_approved_release.py"') < deploy.index(
        'prepare_venv.py"'
    )
