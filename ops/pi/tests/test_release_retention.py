"""Release retention protects rollback paths while reclaiming old deployments."""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
from pathlib import Path

import pytest

PI_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = PI_ROOT / "prune_releases.py"


def load_script():
    spec = importlib.util.spec_from_file_location("prune_releases", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def release(root: Path, number: int) -> Path:
    path = root / f"{number:040x}"
    path.mkdir()
    os.utime(path, (number, number))
    return path


def test_retention_keeps_four_newest_plus_active_and_previous(tmp_path: Path) -> None:
    root = tmp_path / "releases"
    root.mkdir()
    paths = [release(root, number) for number in range(1, 9)]

    candidates = load_script().select_candidates(root, paths[0], paths[1])

    assert candidates == paths[2:4]
    assert all(path.exists() for path in paths)


def test_retention_refuses_unexpected_entries_before_any_deletion(
    tmp_path: Path,
) -> None:
    root = tmp_path / "releases"
    root.mkdir()
    paths = [release(root, number) for number in range(1, 7)]
    (root / "notes.txt").write_text("keep", encoding="utf-8")

    with pytest.raises(ValueError, match="unexpected"):
        load_script().prune(root, paths[-1], paths[-2], apply=True)

    assert all(path.exists() for path in paths)


@pytest.mark.skipif(shutil.which("git") is None, reason="git unavailable")
def test_prune_removes_clean_old_release_but_keeps_dirty_one(tmp_path: Path) -> None:
    root = tmp_path / "releases"
    root.mkdir()
    paths = [release(root, number) for number in range(1, 8)]
    for path in paths[:2]:
        subprocess.run(["git", "init", "-q", str(path)], check=True)
    (paths[1] / "untracked.txt").write_text("keep", encoding="utf-8")
    for number, path in enumerate(paths, start=1):
        os.utime(path, (number, number))

    removed = load_script().prune(root, paths[-1], paths[-2], apply=True)

    assert removed == [paths[0]]
    assert not paths[0].exists()
    assert paths[1].exists()
    assert all(path.exists() for path in paths[2:])


@pytest.mark.skipif(shutil.which("git") is None, reason="git unavailable")
def test_prune_preserves_release_with_ignored_secret(tmp_path: Path) -> None:
    root = tmp_path / "releases"
    root.mkdir()
    paths = [release(root, number) for number in range(1, 7)]
    old = paths[0]
    subprocess.run(["git", "init", "-q", str(old)], check=True)
    (old / ".git" / "info" / "exclude").write_text(".env\n", encoding="utf-8")
    (old / ".env").write_text("private", encoding="utf-8")
    os.utime(old, (1, 1))

    removed = load_script().prune(root, paths[-1], paths[-2], apply=True)

    assert removed == []
    assert (old / ".env").read_text(encoding="utf-8") == "private"


@pytest.mark.skipif(os.name == "nt", reason="directory symlinks require privileges")
def test_prune_unlinks_shared_venv_without_deleting_cache(tmp_path: Path) -> None:
    root = tmp_path / "releases"
    root.mkdir()
    paths = [release(root, number) for number in range(1, 7)]
    old = paths[0]
    subprocess.run(["git", "init", "-q", str(old)], check=True)
    (old / ".gitignore").write_text("services/api/.venv\n", encoding="utf-8")
    cache = tmp_path / "venvs" / "shared"
    cache.mkdir(parents=True)
    (cache / "keep.txt").write_text("keep", encoding="utf-8")
    api = old / "services" / "api"
    api.mkdir(parents=True)
    (api / "requirements.txt").write_text("", encoding="utf-8")
    subprocess.run(
        ["git", "-C", str(old), "add", ".gitignore", "services/api/requirements.txt"],
        check=True,
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(old),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "initial",
        ],
        check=True,
    )
    (api / ".venv").symlink_to(cache, target_is_directory=True)
    os.utime(old, (1, 1))

    removed = load_script().prune(root, paths[-1], paths[-2], apply=True)

    assert removed == [old]
    assert not old.exists()
    assert (cache / "keep.txt").read_text(encoding="utf-8") == "keep"


def test_deployment_prunes_only_after_successful_verification() -> None:
    deploy = (PI_ROOT / "deploy-release.sh").read_text(encoding="utf-8")
    call = 'prune_releases.py" --previous "$previous_release" --apply'

    assert call in deploy
    assert deploy.index('echo "Pi deployment verified: $commit"') < deploy.rindex(call)
    assert deploy.index('systemctl is-active --quiet "$unit" ||') < deploy.rindex(call)


def test_same_commit_deployment_does_not_forget_previous_rollback_release() -> None:
    deploy = (PI_ROOT / "deploy-release.sh").read_text(encoding="utf-8")
    start = deploy.index('if [[ "$previous_release" == "$release" ]]')
    same_commit_branch = deploy[
        start : deploy.index('\npython3 "$release/ops/pi/prepare_venv.py"', start)
    ]

    assert "prune_releases.py" not in same_commit_branch


def test_deployment_locks_before_selecting_previous_release() -> None:
    deploy = (PI_ROOT / "deploy-release.sh").read_text(encoding="utf-8")

    assert deploy.index("flock -n 9") < deploy.index(
        'readonly previous_release="$(readlink -f'
    )


@pytest.mark.skipif(shutil.which("git") is None, reason="git unavailable")
def test_prune_refuses_changed_active_release(tmp_path: Path) -> None:
    root = tmp_path / "releases"
    root.mkdir()
    paths = [release(root, number) for number in range(1, 7)]
    subprocess.run(["git", "init", "-q", str(paths[0])], check=True)
    os.utime(paths[0], (1, 1))

    with pytest.raises(ValueError, match="active release changed"):
        load_script().prune(
            root,
            paths[-1],
            paths[-2],
            apply=True,
            current_link=paths[0],
        )

    assert paths[0].exists()
