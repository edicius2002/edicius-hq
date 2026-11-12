"""Recheck a selected Pi release against the approved ref before activation."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path

REPOSITORY = "https://github.com/edicius2002/edicius-hq.git"
PRODUCTION_REF = "refs/heads/pi-production"
COMMIT = re.compile(r"[0-9a-f]{40}\Z")


def _git(checkout: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(checkout), *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def verify(repository: str, previous_release: Path, selected: str) -> None:
    """Reject a moved ref or a non-descendant while the deploy lock is held."""
    if not COMMIT.fullmatch(selected):
        raise ValueError("selected release is not a full commit SHA")
    active = _git(previous_release, "rev-parse", "HEAD")
    if active != previous_release.name or not COMMIT.fullmatch(active):
        raise ValueError("active release does not match its pinned checkout")
    lines = _git(
        previous_release, "ls-remote", "--exit-code", repository, PRODUCTION_REF
    ).splitlines()
    if lines != [f"{selected}\t{PRODUCTION_REF}"]:
        raise ValueError("production ref changed after release selection")
    _git(
        previous_release,
        "fetch",
        "--quiet",
        "--no-tags",
        repository,
        PRODUCTION_REF,
    )
    if _git(previous_release, "rev-parse", "FETCH_HEAD") != selected:
        raise ValueError("production ref changed during final verification")
    ancestry = subprocess.run(
        [
            "git",
            "-C",
            str(previous_release),
            "merge-base",
            "--is-ancestor",
            active,
            selected,
        ],
        check=False,
    )
    if ancestry.returncode != 0:
        raise ValueError("active release is not an ancestor of approved commit")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("previous_release", type=Path)
    parser.add_argument("selected_commit")
    args = parser.parse_args()
    try:
        verify(REPOSITORY, args.previous_release, args.selected_commit)
    except (ValueError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
