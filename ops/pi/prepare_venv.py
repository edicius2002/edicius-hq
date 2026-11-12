"""Prepare an immutable, shared Python environment for a pinned Pi release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import venv
from pathlib import Path

APP_ROOT = Path("/opt/edicius-hq")
RELEASES = APP_ROOT / "releases"
CACHE_ROOT = APP_ROOT / "venvs"
COMMIT_NAME = re.compile(r"[0-9a-f]{40}\Z")


def environment_key(requirements: Path, version: tuple[int, int]) -> str:
    """Identify an installed dependency set without moving a virtualenv."""
    digest = hashlib.sha256(requirements.read_bytes()).hexdigest()
    return f"py{version[0]}{version[1]}-{digest}"


def _python(environment: Path) -> Path:
    return environment / "bin" / "python"


def _check_environment(environment: Path) -> None:
    python = _python(environment)
    if not python.is_file() or not os.access(python, os.X_OK):
        raise ValueError(f"Python environment is incomplete: {environment}")
    subprocess.run([str(python), "-m", "pip", "check"], check=True)


def _build_environment(environment: Path, requirements: Path) -> None:
    venv.create(environment, with_pip=True)
    subprocess.run(
        [
            str(_python(environment)),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--requirement",
            str(requirements),
        ],
        check=True,
    )
    _check_environment(environment)


def _check_ready(environment: Path, key: str) -> None:
    marker = environment / "ready.json"
    if environment.is_symlink() or not environment.is_dir() or marker.is_symlink():
        raise ValueError(f"Python environment cache is incomplete: {environment}")
    try:
        ready = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(
            f"Python environment cache is incomplete: {environment}"
        ) from error
    if ready != {"key": key}:
        raise ValueError(f"Python environment cache is incomplete: {environment}")
    _check_environment(environment)


def prepare(release: Path, cache_root: Path) -> Path:
    """Link a release to a ready cache entry, creating it once if necessary."""
    if release.is_symlink() or not release.is_dir():
        raise ValueError("release must be a real directory")
    api = release / "services" / "api"
    requirements = api / "requirements.txt"
    if api.is_symlink() or requirements.is_symlink() or not requirements.is_file():
        raise ValueError("release requirements must be a regular file")
    if cache_root.is_symlink():
        raise ValueError("Python environment cache root must not be a symlink")
    cache_root.mkdir(mode=0o755, parents=True, exist_ok=True)
    if cache_root.is_symlink() or not cache_root.is_dir():
        raise ValueError("Python environment cache root must be a real directory")

    key = environment_key(requirements, sys.version_info[:2])
    cached = cache_root / key
    release_environment = api / ".venv"
    if release_environment.is_symlink():
        if release_environment.resolve(strict=True) != cached:
            raise ValueError("release points to a different Python environment")
        _check_ready(cached, key)
        return cached
    if release_environment.exists():
        if not release_environment.is_dir():
            raise ValueError("release Python environment is not a directory")
        # Legacy releases already contain their own environment. Keep that
        # location intact for rollback instead of moving its absolute paths.
        subprocess.run(
            [
                str(_python(release_environment)),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                "--requirement",
                str(requirements),
            ],
            check=True,
        )
        _check_environment(release_environment)
        return release_environment

    if cached.exists() or cached.is_symlink():
        _check_ready(cached, key)
    else:
        old_umask = os.umask(0o022)
        temporary: Path | None = None
        try:
            temporary = Path(tempfile.mkdtemp(prefix=".prepare-", dir=cache_root))
            temporary.chmod(0o755)
            _build_environment(temporary, requirements)
            (temporary / "ready.json").write_text(
                json.dumps({"key": key}) + "\n", encoding="utf-8"
            )
            temporary.rename(cached)
            temporary = None
        finally:
            if temporary is not None:
                shutil.rmtree(temporary)
            os.umask(old_umask)
        _check_ready(cached, key)
    release_environment.symlink_to(cached, target_is_directory=True)
    return cached


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("run as root")
    if sys.version_info[:2] not in ((3, 12), (3, 13)):
        parser.error("Python 3.12 or 3.13 is required")
    if (
        args.release.parent != RELEASES
        or not COMMIT_NAME.fullmatch(args.release.name)
        or args.release.is_symlink()
    ):
        parser.error("release must be a direct pinned checkout")
    try:
        environment = prepare(args.release, CACHE_ROOT)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    print(f"Python environment ready: {environment}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
