"""
Backfill historical connecting-fare waypoints from later observations.

The archive began recording ``viaPoints`` on 2026-08-27. A stop belongs to an
itinerary rather than to the price observed for it, so an older observation can
inherit it only when this exact itinerary key agrees:

    (origin, destination, flightDate, flightNumber, departureAt, transfers,
     arrivalAt, durationMinutes)

The key deliberately includes ``transfers``. Flight numbers and times alone
can describe itineraries with different stop lists, and guessing between them
would turn a repair into bad history.

    npm run fares:backfill
    npm run fares:backfill -- --write

Dry-run is the default. ``--write`` creates a separate backup for every changed
file and replaces the file atomically; run it only after reviewing the report.
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

from app.config import fares_dir  # noqa: E402, I001


type ItineraryKey = tuple[str, str, str, str | None, str | None, int, str | None, int | None]


@dataclass(slots=True)
class BackfillReport:
    matched: int = 0
    unmatched: int = 0
    ambiguous: int = 0
    files_changed: int = 0


def _itinerary_key(snapshot: dict[str, Any], offer: dict[str, Any]) -> ItineraryKey | None:
    """The complete, deliberately strict itinerary key used for every match."""
    origin = snapshot.get("origin")
    destination = snapshot.get("destination")
    flight_date = snapshot.get("flightDate")
    flight_number = offer.get("flightNumber")
    departure_at = offer.get("departureAt")
    transfers = offer.get("transfers")
    arrival_at = offer.get("arrivalAt")
    duration_minutes = offer.get("durationMinutes")

    if not all(isinstance(value, str) for value in (origin, destination, flight_date)):
        return None
    if flight_number is not None and not isinstance(flight_number, str):
        return None
    if departure_at is not None and not isinstance(departure_at, str):
        return None
    if arrival_at is not None and not isinstance(arrival_at, str):
        return None
    if not isinstance(transfers, int) or isinstance(transfers, bool):
        return None
    if duration_minutes is not None and (
        not isinstance(duration_minutes, int) or isinstance(duration_minutes, bool)
    ):
        return None

    assert isinstance(origin, str)
    assert isinstance(destination, str)
    assert isinstance(flight_date, str)

    return (
        origin,
        destination,
        flight_date,
        flight_number,
        departure_at,
        transfers,
        arrival_at,
        duration_minutes,
    )


def _coded_via_points(offer: dict[str, Any]) -> tuple[str, ...] | None:
    """A non-stop row needs no backfill; a connecting row needs actual codes."""
    via_points = offer.get("viaPoints")
    transfers = offer.get("transfers")
    if not isinstance(transfers, int) or isinstance(transfers, bool) or transfers <= 0:
        return None
    if (
        not isinstance(via_points, list)
        or not via_points
        or not all(isinstance(point, str) for point in via_points)
    ):
        return None
    return tuple(via_points)


def _needs_via_points(offer: dict[str, Any]) -> bool:
    transfers = offer.get("transfers")
    return (
        isinstance(transfers, int)
        and not isinstance(transfers, bool)
        and transfers > 0
        and offer.get("viaPoints") is None
    )


def _rows(path: Path) -> Iterable[tuple[int, str, dict[str, Any]]]:
    for number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(keepends=True), start=1
    ):
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{number}: invalid JSON") from error
        if not isinstance(row, dict):
            raise ValueError(f"{path}:{number}: JSONL row is not an object")
        yield number, line, row


def _build_index(paths: Iterable[Path]) -> dict[ItineraryKey, set[tuple[str, ...]]]:
    index: dict[ItineraryKey, set[tuple[str, ...]]] = defaultdict(set)
    for path in paths:
        for _, _, snapshot in _rows(path):
            offers = snapshot.get("offers")
            if not isinstance(offers, list):
                continue
            for offer in offers:
                if not isinstance(offer, dict):
                    continue
                key = _itinerary_key(snapshot, offer)
                via_points = _coded_via_points(offer)
                if key is not None and via_points is not None:
                    index[key].add(via_points)
    return index


def _skip_whitespace(text: str, position: int) -> int:
    while position < len(text) and text[position].isspace():
        position += 1
    return position


def _object_members(text: str, start: int) -> list[tuple[str, object, int, int]]:
    """Read object members with source spans, preserving the original JSON text."""
    decoder = json.JSONDecoder()
    position = _skip_whitespace(text, start)
    if position >= len(text) or text[position] != "{":
        raise ValueError("expected JSON object")
    position += 1
    members: list[tuple[str, object, int, int]] = []

    while True:
        position = _skip_whitespace(text, position)
        if position >= len(text):
            raise ValueError("unterminated JSON object")
        if text[position] == "}":
            return members
        key, position = decoder.raw_decode(text, position)
        if not isinstance(key, str):
            raise ValueError("JSON object key is not a string")
        position = _skip_whitespace(text, position)
        if position >= len(text) or text[position] != ":":
            raise ValueError("JSON object key has no colon")
        position = _skip_whitespace(text, position + 1)
        value_start = position
        value, value_end = decoder.raw_decode(text, position)
        members.append((key, value, value_start, value_end))
        position = _skip_whitespace(text, value_end)
        if position >= len(text):
            raise ValueError("unterminated JSON object")
        if text[position] == "}":
            return members
        if text[position] != ",":
            raise ValueError("JSON object members are not separated")
        position += 1


def _array_items(text: str, start: int) -> list[tuple[object, int, int]]:
    decoder = json.JSONDecoder()
    position = _skip_whitespace(text, start)
    if position >= len(text) or text[position] != "[":
        raise ValueError("expected JSON array")
    position += 1
    items: list[tuple[object, int, int]] = []

    while True:
        position = _skip_whitespace(text, position)
        if position >= len(text):
            raise ValueError("unterminated JSON array")
        if text[position] == "]":
            return items
        item_start = position
        item, item_end = decoder.raw_decode(text, position)
        items.append((item, item_start, item_end))
        position = _skip_whitespace(text, item_end)
        if position >= len(text):
            raise ValueError("unterminated JSON array")
        if text[position] == "]":
            return items
        if text[position] != ",":
            raise ValueError("JSON array items are not separated")
        position += 1


def _add_or_replace_via_points(offer_text: str, via_points: tuple[str, ...]) -> str:
    """Change only this value, retaining the original object spelling and key order."""
    members = _object_members(offer_text, 0)
    encoded = json.dumps(list(via_points), ensure_ascii=False, separators=(",", ":"))
    for key, value, value_start, value_end in members:
        if key == "viaPoints":
            if value is not None:
                raise ValueError("refusing to replace existing viaPoints")
            return f"{offer_text[:value_start]}{encoded}{offer_text[value_end:]}"
    close = offer_text.rfind("}")
    if close < 0:
        raise ValueError("offer is not a JSON object")
    comma = "," if members else ""
    return f'{offer_text[:close]}{comma}"viaPoints":{encoded}{offer_text[close:]}'


def _rewrite_line(line: str, updates: dict[int, tuple[str, ...]]) -> str:
    """Apply offer updates by source span, never serializing the snapshot again."""
    root_start = _skip_whitespace(line, 0)
    offers_member = next(
        (member for member in _object_members(line, root_start) if member[0] == "offers"), None
    )
    if offers_member is None:
        raise ValueError("snapshot has no offers array")
    _, offers, offers_start, _ = offers_member
    if not isinstance(offers, list):
        raise ValueError("snapshot offers is not an array")
    items = _array_items(line, offers_start)
    if len(items) != len(offers):
        raise ValueError("snapshot offers changed while being read")

    rewritten = line
    for index, via_points in sorted(updates.items(), reverse=True):
        item, start, end = items[index]
        if not isinstance(item, dict):
            raise ValueError("offer is not an object")
        rewritten = (
            f"{rewritten[:start]}{_add_or_replace_via_points(rewritten[start:end], via_points)}"
            f"{rewritten[end:]}"
        )
    return rewritten


def _backup_path(path: Path) -> Path:
    base = path.with_name(f"{path.name}.viapoints-backfill.bak")
    candidate = base
    number = 1
    while candidate.exists():
        candidate = base.with_name(f"{base.name}.{number}")
        number += 1
    return candidate


def _backup(path: Path) -> Path:
    """Copy the whole original before changing it, never overwriting an older backup."""
    backup = _backup_path(path)
    with path.open("rb") as source, backup.open("xb") as destination:
        shutil.copyfileobj(source, destination)
        destination.flush()
        os.fsync(destination.fileno())
    return backup


def _write_atomically(path: Path, text: str) -> None:
    """Flush a sibling temporary before os.replace so readers never see a partial JSONL file."""
    descriptor, temporary_name = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def backfill(directory: Path, *, write: bool = False) -> BackfillReport:
    paths = sorted(directory.glob("*.jsonl"))
    index = _build_index(paths)
    report = BackfillReport()

    for path in paths:
        output: list[str] = []
        changed = False
        for _, line, snapshot in _rows(path):
            offers = snapshot.get("offers")
            updates: dict[int, tuple[str, ...]] = {}
            if isinstance(offers, list):
                for offer_index, offer in enumerate(offers):
                    if not isinstance(offer, dict) or not _needs_via_points(offer):
                        continue
                    key = _itinerary_key(snapshot, offer)
                    options = index.get(key, set()) if key is not None else set()
                    if len(options) == 1:
                        updates[offer_index] = next(iter(options))
                        report.matched += 1
                    elif len(options) > 1:
                        report.ambiguous += 1
                    else:
                        report.unmatched += 1
            rewritten = _rewrite_line(line, updates) if updates else line
            output.append(rewritten)
            changed = changed or bool(updates)

        if changed:
            report.files_changed += 1
            if write:
                _backup(path)
                _write_atomically(path, "".join(output))

    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=fares_dir())
    parser.add_argument(
        "--write", action="store_true", help="create backups and apply matched values"
    )
    args = parser.parse_args()

    report = backfill(args.directory, write=args.write)
    verb = "filled" if args.write else "would fill"
    print(
        f"{verb} {report.matched} offer(s); {report.unmatched} without match; "
        f"{report.ambiguous} skipped as ambiguous; {report.files_changed} file(s) affected"
    )
    if not args.write:
        print("dry run; nothing was written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
