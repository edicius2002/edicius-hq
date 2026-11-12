"""Shared Pi environments remain complete, reusable, and rollback-safe."""

from __future__ import annotations

import importlib.util
import os
import sys
import venv
from pathlib import Path

import pytest

PI_ROOT = Path(__file__).resolve().parents[1]


def load_helper():
    spec = importlib.util.spec_from_file_location(
        "prepare_venv", PI_ROOT / "prepare_venv.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_release(root: Path, name: str, requirements: str = "") -> Path:
    release = root / name
    api = release / "services" / "api"
    api.mkdir(parents=True)
    (api / "requirements.txt").write_text(requirements, encoding="utf-8")
    return release


def test_environment_key_changes_with_requirements_and_python_version(
    tmp_path: Path,
) -> None:
    requirements = tmp_path / "requirements.txt"
    requirements.write_text("example==1\n", encoding="utf-8")
    helper = load_helper()

    first = helper.environment_key(requirements, (3, 13))
    assert first == helper.environment_key(requirements, (3, 13))
    assert first != helper.environment_key(requirements, (3, 12))
    requirements.write_text("example==2\n", encoding="utf-8")
    assert first != helper.environment_key(requirements, (3, 13))


def test_environment_key_rejects_indirect_requirements(tmp_path: Path) -> None:
    requirements = tmp_path / "requirements.txt"
    requirements.write_text("-r other-requirements.txt\n", encoding="utf-8")

    with pytest.raises(ValueError, match="direct pinned"):
        load_helper().environment_key(requirements, (3, 13))


@pytest.mark.skipif(os.name == "nt", reason="directory symlinks require privileges")
def test_matching_release_reuses_ready_environment_without_reinstalling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    helper = load_helper()
    cache = tmp_path / "venvs"
    first = make_release(tmp_path, "first")
    second = make_release(tmp_path, "second")

    prepared = helper.prepare(first, cache)
    assert (prepared / "ready.json").is_file()
    assert (first / "services/api/.venv").resolve() == prepared

    def unexpected_install(*_args, **_kwargs):
        raise AssertionError("matching requirements must not reinstall packages")

    monkeypatch.setattr(helper, "_build_environment", unexpected_install)
    assert helper.prepare(second, cache) == prepared
    assert (second / "services/api/.venv").resolve() == prepared


@pytest.mark.skipif(os.name == "nt", reason="directory symlinks require privileges")
def test_incomplete_cache_is_not_used(tmp_path: Path) -> None:
    helper = load_helper()
    release = make_release(tmp_path, "release")
    cache = tmp_path / "venvs"
    incomplete = cache / helper.environment_key(
        release / "services/api/requirements.txt", sys.version_info[:2]
    )
    incomplete.mkdir(parents=True)

    with pytest.raises(ValueError, match="incomplete"):
        helper.prepare(release, cache)

    assert not (release / "services/api/.venv").exists()


@pytest.mark.skipif(os.name == "nt", reason="Pi virtualenv layout is Unix-specific")
def test_legacy_release_environment_stays_in_place(tmp_path: Path) -> None:
    helper = load_helper()
    release = make_release(tmp_path, "rollback")
    legacy = release / "services/api/.venv"
    venv.create(legacy, with_pip=True)

    assert helper.prepare(release, tmp_path / "venvs") == legacy
    assert legacy.is_dir() and not legacy.is_symlink()


@pytest.mark.skipif(os.name == "nt", reason="directory symlinks require privileges")
def test_failed_build_never_publishes_cache_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    helper = load_helper()
    release = make_release(tmp_path, "release")
    cache = tmp_path / "venvs"

    def fail_install(*_args, **_kwargs):
        raise RuntimeError("pip failed")

    monkeypatch.setattr(helper, "_build_environment", fail_install)
    with pytest.raises(RuntimeError, match="pip failed"):
        helper.prepare(release, cache)

    assert not (release / "services/api/.venv").exists()
    assert not list(cache.iterdir())
