"""Deploy only the newest commit explicitly promoted to pi-production."""

from __future__ import annotations

import argparse
import os
import re
import stat
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover - the Pi service runs on Linux
    fcntl = None  # type: ignore[assignment]

APP_ROOT = Path("/opt/edicius-hq")
LOCK = Path("/run/edicius-hq-deploy.lock")
REPOSITORY = "https://github.com/edicius2002/edicius-hq.git"
PRODUCTION_REF = "refs/heads/pi-production"
COMMIT_NAME = re.compile(r"[0-9a-f]{40}\Z")
Invoke = Callable[[Path, str, int], None]


def _git(*args: str) -> str:
    result = subprocess.run(["git", *args], capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _production_commit(repository: str, checkout: Path) -> str:
    lines = _git(
        "-C", str(checkout), "ls-remote", "--exit-code", repository, PRODUCTION_REF
    ).splitlines()
    if len(lines) != 1:
        raise ValueError("production ref did not resolve to exactly one commit")
    fields = lines[0].split()
    if (
        len(fields) != 2
        or not COMMIT_NAME.fullmatch(fields[0])
        or fields[1] != PRODUCTION_REF
    ):
        raise ValueError("production ref did not resolve to a pinned commit")
    return fields[0]


def _invoke_deployment(script: Path, commit: str, lock_fd: int) -> None:
    environment = os.environ.copy()
    environment["EDICIUS_DEPLOY_LOCK_FD"] = str(lock_fd)
    subprocess.run(
        ["bash", str(script), commit, "--auto"],
        check=True,
        env=environment,
        pass_fds=(lock_fd,),
    )


def update(
    repository: str,
    app_root: Path,
    lock_path: Path,
    invoke: Invoke = _invoke_deployment,
) -> str | None:
    """Check the promoted ref under the deployment lock and deploy if newer."""
    if fcntl is None:
        raise RuntimeError("Pi updates require Linux flock support")
    if lock_path.parent.is_symlink() or not lock_path.parent.is_dir():
        raise ValueError("deployment lock parent is unsafe")
    if lock_path.is_symlink():
        raise ValueError("deployment lock path is unsafe")
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    lock_fd = os.open(lock_path, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
            raise ValueError("deployment lock is not a regular file")
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        releases = app_root / "releases"
        current = app_root / "current"
        if releases.is_symlink() or not releases.is_dir() or not current.is_symlink():
            raise ValueError("Pi release layout is invalid")
        active = current.resolve(strict=True)
        if (
            active.parent != releases
            or not COMMIT_NAME.fullmatch(active.name)
            or active.is_symlink()
            or not active.is_dir()
        ):
            raise ValueError("active release is not a pinned checkout")
        active_commit = _git("-C", str(active), "rev-parse", "HEAD")
        if active_commit != active.name:
            raise ValueError("active release directory does not match its commit")
        target = _production_commit(repository, active)
        if target == active_commit:
            print(f"Pi production is current: {target}")
            return None

        _git(
            "-C",
            str(active),
            "fetch",
            "--quiet",
            "--no-tags",
            repository,
            PRODUCTION_REF,
        )
        fetched = _git("-C", str(active), "rev-parse", "FETCH_HEAD")
        if fetched != target:
            raise ValueError("production ref changed while preparing deployment")
        ancestry = subprocess.run(
            [
                "git",
                "-C",
                str(active),
                "merge-base",
                "--is-ancestor",
                active_commit,
                target,
            ],
            check=False,
        )
        if ancestry.returncode != 0:
            raise ValueError("active release is not an ancestor of promoted commit")
        content = subprocess.run(
            ["git", "-C", str(active), "show", f"{target}:ops/pi/deploy-release.sh"],
            capture_output=True,
            check=True,
        ).stdout
        with tempfile.TemporaryDirectory(prefix="edicius-pi-update-") as directory:
            script = Path(directory) / "deploy-release.sh"
            script.write_bytes(content)
            script.chmod(0o700)
            subprocess.run(["bash", "-n", str(script)], check=True)
            print(f"Deploying promoted Pi release: {target}", flush=True)
            invoke(script, target, lock_fd)
        return target
    finally:
        os.close(lock_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    if os.geteuid() != 0:
        parser.error("run as root")
    try:
        update(REPOSITORY, APP_ROOT, LOCK)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
