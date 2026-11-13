"""Repair verified leading NUL padding in specific Pi fare journals."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "api"))

from app.config import local_data_dir
from app.services.airfare_retention_store import _atomic_write, _distinct_object


def repair(root: Path, relatives: list[str], *, backup_dir: Path | None = None) -> list[dict]:
    fares = (root / "fares").resolve()
    backup = backup_dir.resolve() if backup_dir is not None else None
    if backup is not None and (backup == fares or fares in backup.parents):
        raise ValueError("backup must be outside the Airfare source")
    if len(set(relatives)) != len(relatives):
        raise ValueError("duplicate fare repair path")
    plans = []
    for relative in relatives:
        candidate = fares / relative
        path = candidate.resolve()
        if (
            path.suffix != ".jsonl"
            or path.parent not in {fares / "checks", fares / "spend"}
            or candidate.is_symlink()
            or not path.is_file()
        ):
            raise ValueError("invalid fare repair path")
        raw = path.read_bytes()
        if raw and not raw.endswith(b"\n"):
            raise ValueError("unterminated fare journal")
        fixed_lines: list[bytes] = []
        damaged = 0
        nul_bytes = 0
        for line in raw.splitlines(keepends=True):
            prefix = len(line) - len(line.lstrip(b"\0"))
            if b"\0" in line[prefix:]:
                raise ValueError("NUL byte inside a fare record")
            if prefix:
                damaged += 1
                nul_bytes += prefix
            clean = line[prefix:]
            try:
                row = json.loads(
                    clean.decode("utf-8"),
                    object_pairs_hook=_distinct_object,
                    parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")),
                )
            except (UnicodeError, ValueError, TypeError) as error:
                raise ValueError("invalid fare record after NUL removal") from error
            if not isinstance(row, dict):
                raise TypeError("fare record must be an object")
            fixed_lines.append(clean)
        plans.append((path, relative, raw, b"".join(fixed_lines), damaged, nul_bytes))
    if backup is not None and any(
        (backup / relative).exists() for _, relative, _, _, damaged, _ in plans if damaged
    ):
        raise ValueError("fare repair backup already exists")
    result = []
    for path, relative, raw, fixed_content, damaged, nul_bytes in plans:
        if backup is not None and damaged:
            destination = backup / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as handle:
                os.chmod(destination, 0o600)
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            if path.read_bytes() != raw:
                raise ValueError("fare journal changed during repair")
            _atomic_write(path, fixed_content)
        result.append({"path": relative, "lines": damaged, "nul_bytes": nul_bytes})
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", help="Paths below fares/checks or fares/spend")
    parser.add_argument("--root", type=Path, default=local_data_dir())
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    if args.apply and args.backup_dir is None:
        parser.error("--apply requires --backup-dir")
    try:
        result = repair(
            args.root,
            args.paths,
            backup_dir=args.backup_dir if args.apply else None,
        )
    except (OSError, TypeError, ValueError) as error:
        print(json.dumps({"status": "failed", "error": type(error).__name__}))
        return 1
    print(json.dumps({"status": "repaired" if args.apply else "dry-run", "files": result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
