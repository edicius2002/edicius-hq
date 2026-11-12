"""Check the configured Neon connection without logging its URL or errors."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "api"))

from app.services.neon_postgres import check_connection


def main() -> int:
    try:
        check_connection()
    except Exception:  # noqa: BLE001 - prevent credential-bearing driver errors in output
        print("Neon Postgres connection check failed.", file=sys.stderr)
        return 1
    print("Neon Postgres connection check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
