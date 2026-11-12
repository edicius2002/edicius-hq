"""Exercise the environment rewrite embedded in the root cutover script."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "activate-neon.sh"
PYTHON_BODY = (
    SCRIPT.read_text(encoding="utf-8").split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
)


def run_rewrite(
    tmp_path: Path, url: str
) -> tuple[subprocess.CompletedProcess[str], Path]:
    url_file = tmp_path / "neon-url"
    url_file.write_text(url, encoding="utf-8")
    env_file = tmp_path / "collectors.env"
    env_file.write_text(
        "SUPABASE_URL=https://example.invalid\n"
        "SUPABASE_SECRET_KEY=legacy-example\n"
        "EDICIUS_OWNER_ID=11111111-1111-1111-1111-111111111111\n"
        "AIRFARE_SYNC_ENABLED=false\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        [sys.executable, "-", str(url_file), str(env_file)],
        input=PYTHON_BODY,
        text=True,
        capture_output=True,
        check=False,
    )
    return result, env_file


def test_neon_cutover_preserves_rollback_values_and_enables_neon(
    tmp_path: Path,
) -> None:
    result, env_file = run_rewrite(
        tmp_path,
        "postgresql://test:example@ep-test-pooler.neon.tech/db?sslmode=require\n",
    )
    assert result.returncode == 0
    content = env_file.read_text(encoding="utf-8")
    assert "SUPABASE_SECRET_KEY=legacy-example" in content
    assert "COLLECTOR_DATA_BACKEND=neon" in content
    assert "AIRFARE_SYNC_BACKEND=neon" in content
    assert "AIRFARE_SYNC_ENABLED=true" in content
    assert "AIRFARE_DATA_BACKEND=local" in content
    assert content.count("AIRFARE_SYNC_ENABLED=") == 1


def test_neon_cutover_rejects_non_neon_url_without_changing_env(tmp_path: Path) -> None:
    result, env_file = run_rewrite(tmp_path, "postgresql://test:example@localhost/db\n")
    assert result.returncode != 0
    assert "COLLECTOR_DATA_BACKEND" not in env_file.read_text(encoding="utf-8")
