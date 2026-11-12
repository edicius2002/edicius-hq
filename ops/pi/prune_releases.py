"""Keep recent pinned Pi releases after a verified deployment.

Only the deployment path calls this with --apply. Manual runs are dry runs.
Durable collector state under /var/lib/edicius-hq is never inspected or removed.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

APP_ROOT = Path("/opt/edicius-hq")
RELEASES = APP_ROOT / "releases"
CURRENT = APP_ROOT / "current"
KEEP_RECENT = 4
COMMIT_NAME = re.compile(r"[0-9a-f]{40}\Z")


def _require_release(root: Path, path: Path) -> None:
    if (
        path.parent != root
        or not COMMIT_NAME.fullmatch(path.name)
        or path.is_symlink()
        or not path.is_dir()
    ):
        raise ValueError(f"release is not a direct pinned directory: {path}")


def select_candidates(root: Path, active: Path, previous: Path) -> list[Path]:
    """Select oldest releases while always retaining rollback and four newest."""
    if root.is_symlink() or not root.is_dir():
        raise ValueError("release root must be a real directory")
    _require_release(root, active)
    _require_release(root, previous)
    paths = list(root.iterdir())
    for path in paths:
        if (
            path.is_symlink()
            or not path.is_dir()
            or not COMMIT_NAME.fullmatch(path.name)
        ):
            raise ValueError(f"unexpected release-root entry: {path}")
    newest = sorted(
        paths, key=lambda path: (path.stat().st_mtime_ns, path.name), reverse=True
    )
    retained = set(newest[:KEEP_RECENT]) | {active, previous}
    return list(reversed([path for path in newest if path not in retained]))


def _has_mount(root: Path) -> bool:
    """Avoid traversing a bind mount hidden inside an otherwise valid release."""
    mountinfo = Path("/proc/self/mountinfo")
    if not mountinfo.exists():
        return False
    prefix = f"{root}/"
    for line in mountinfo.read_text(encoding="utf-8").splitlines():
        mountpoint = line.split()[4].replace("\\040", " ")
        if mountpoint == str(root) or mountpoint.startswith(prefix):
            return True
    return False


def _is_clean_checkout(path: Path) -> bool:
    if not (path / ".git").is_dir():
        return False
    result = subprocess.run(
        [
            "git",
            "-C",
            str(path),
            "status",
            "--porcelain=v1",
            "--ignored",
            "--untracked-files=normal",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0 and all(
        line == "!! services/api/.venv/" for line in result.stdout.splitlines()
    )


def prune(
    root: Path,
    active: Path,
    previous: Path,
    *,
    apply: bool = False,
    current_link: Path | None = None,
) -> list[Path]:
    """Remove only clean, unmounted, old checkouts from the direct release root."""
    candidates = select_candidates(root, active, previous)
    removed: list[Path] = []
    for path in candidates:
        if not _is_clean_checkout(path) or _has_mount(path):
            print(f"Keeping unverified release: {path.name}", file=sys.stderr)
            continue
        if apply:
            # Recheck immediately before deleting; rmtree unlinks nested symlinks.
            if current_link is not None and current_link.resolve(strict=True) != active:
                raise ValueError("active release changed during pruning")
            _require_release(root, path)
            if _has_mount(path):
                continue
            shutil.rmtree(path)
        removed.append(path)
        action = "Removed" if apply else "Would remove"
        print(f"{action} old release: {path.name}")
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous", required=True, type=Path)
    parser.add_argument(
        "--apply", action="store_true", help="delete eligible old releases"
    )
    args = parser.parse_args()
    if args.apply and os.geteuid() != 0:
        parser.error("--apply requires root")
    if RELEASES.is_symlink() or RELEASES.resolve() != RELEASES:
        parser.error("release root must be the real /opt/edicius-hq/releases directory")
    if not CURRENT.is_symlink():
        parser.error("current must be a symlink to a pinned release")
    try:
        active = CURRENT.resolve(strict=True)
        previous = args.previous.resolve(strict=True)
        _require_release(RELEASES, active)
        _require_release(RELEASES, previous)
        prune(RELEASES, active, previous, apply=args.apply, current_link=CURRENT)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
