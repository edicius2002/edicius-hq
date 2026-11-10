"""Bounded Supabase operational retention. Dry-run unless --apply is explicit."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, cast

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

from app.config import collector_config
from app.services.airfare_supabase import SupabaseAirfare

RPC = "prune_operational_history"
BATCH_SIZE = 500
MAX_BATCHES = 20


def _counts(response: Any, *, apply: bool) -> tuple[int, int]:
    if not isinstance(response, dict) or response.get("applied") is not apply:
        raise ValueError("invalid retention response")
    counts = (response.get("airfare_import_runs"), response.get("collector_requests"))
    if any(type(count) is not int or count < 0 for count in counts):
        raise ValueError("invalid retention response")
    return cast(tuple[int, int], counts)


def prune(
    client: SupabaseAirfare,
    *,
    apply: bool,
    max_batches: int = MAX_BATCHES,
) -> dict[str, int | bool]:
    if max_batches < 1:
        raise ValueError("max_batches must be positive")
    imports = requests = 0
    for _ in range(max_batches if apply else 1):
        response = client.rpc(RPC, {"p_apply": apply, "p_batch_size": BATCH_SIZE})
        batch_imports, batch_requests = _counts(response, apply=apply)
        imports += batch_imports
        requests += batch_requests
        if not apply or (batch_imports == 0 and batch_requests == 0):
            return {
                "applied": apply,
                "airfare_import_runs": imports,
                "collector_requests": requests,
                "more_possible": False,
            }
    return {
        "applied": apply,
        "airfare_import_runs": imports,
        "collector_requests": requests,
        "more_possible": True,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="delete eligible rows")
    args = parser.parse_args(argv)
    config = collector_config()
    client = SupabaseAirfare(
        config.url, config.secret_key, timeout_seconds=config.timeout_seconds
    )
    try:
        result = prune(client, apply=args.apply)
    finally:
        client.close()
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
