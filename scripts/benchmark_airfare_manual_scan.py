"""Local synthetic route scan benchmark; never contacts a provider or replica."""

import argparse
import json
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path

from app.services.airfare_sync import AirfareSync


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mebibytes", type=int, default=32)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        path = root / "fares/baseline/AQP-LIM.jsonl"
        path.parent.mkdir(parents=True)
        with path.open("wb") as handle:
            index = 0
            while handle.tell() < args.mebibytes * 1024 * 1024:
                row = {
                    "flightDate": "2027-03-01",
                    "date": (date(2020, 1, 1) + timedelta(days=index)).isoformat(),
                    "price": index,
                    "currency": "USD",
                    "source": "synthetic",
                    "sample": f"{index:08d}",
                }
                handle.write(json.dumps(row).encode() + b"\n")
                index += 1
        sync = AirfareSync(root)
        start = time.perf_counter()
        datasets, journals = sync._collect(route_scope="AQP-LIM")
        elapsed = time.perf_counter() - start
        print(
            json.dumps(
                {
                    "bytes": path.stat().st_size,
                    "rows": datasets["baseline"].physical,
                    "read_bytes": sum(len(journal.content) for journal in journals),
                    "scan_seconds": round(elapsed, 3),
                }
            )
        )
        cache_index = sync._index_from_scan("AQP-LIM", datasets, journals)
        cursors: dict[str, object] = {}
        sync._acknowledge(journals[0], journals[0].end, cursors, baseline_ack=True)
        cache_index["cursors"] = {
            "fares/baseline/AQP-LIM.jsonl": cursors["fares/baseline/AQP-LIM.jsonl"]
        }
        sync._write_route_index("AQP-LIM", cache_index)
        with path.open("ab") as handle:
            for new_index in range(
                cache_index["datasets"]["baseline"]["physical"],
                cache_index["datasets"]["baseline"]["physical"] + 28,
            ):
                row = {
                    "flightDate": "2027-03-01",
                    "date": (date(2020, 1, 1) + timedelta(days=new_index)).isoformat(),
                    "price": new_index,
                    "currency": "USD",
                    "source": "synthetic",
                    "sample": f"{new_index:08d}",
                }
                handle.write(json.dumps(row).encode() + b"\n")
        start = time.perf_counter()
        delta = sync._collect_manual_delta("AQP-LIM", cursors, None)
        assert delta is not None
        new_datasets, new_journals, updated_index = delta
        manifest = sync._index_manifest(updated_index, "AQP-LIM")
        print(
            json.dumps(
                {
                    "delta_bytes": sum(journal.read_bytes for journal in new_journals),
                    "delta_rows": new_datasets["baseline"].physical,
                    "manifest_rows": manifest.baseline.physical_valid,
                    "incremental_scan_seconds": round(time.perf_counter() - start, 3),
                }
            )
        )


if __name__ == "__main__":
    main()
