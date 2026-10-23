"""Incrementally refresh one region's three SEACE snapshots."""

import asyncio
import json
import os
import re
import sys
import tempfile
import unicodedata
from datetime import date, datetime, timedelta
from pathlib import Path

import refresh
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SOURCES = (
    (refresh.OUTPUT, "SEACE_DATA", "processes"),
    (refresh.MINOR_NOTICE_OUTPUT, "SEACE_MINOR_NOTICES", "notices"),
    (refresh.MINOR_OUTPUT, "SEACE_MINOR_DATA", "contracts"),
)
OVERLAP_DAYS = 7
CONTRACT_OVERLAP_DAYS = 30


def region_name(value):
    normalized = "".join(char for char in unicodedata.normalize("NFKD", value.strip()) if not unicodedata.combining(char)).upper()
    if normalized not in refresh.DEPARTMENT_CODES:
        raise ValueError("Choose a supported region")
    return next(name for name in refresh.DEPARTMENT_NAMES if refresh.plain(name).upper() == normalized)


def read_snapshot(path):
    if not path.exists():
        return {"records": [], "regions": {}}
    source = path.read_text(encoding="utf-8")
    return json.loads(source.split("=", 1)[1].strip().removesuffix(";"))


def checkpoint(snapshot, region, year):
    entry = snapshot.get("regions", {}).get(f"{region}:{year}")
    if entry:
        value = entry.get("fetchedAt")
    elif snapshot.get("region") == region and snapshot.get("year") == year:
        value = snapshot.get("fetchedAt")
    else:
        value = None
    return datetime.fromisoformat(value) if value else None


def source_date(value):
    for format_string in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return datetime.strptime(value or "", format_string).replace(tzinfo=refresh.PERU_TIME)
        except ValueError:
            pass
    return None


def record_key(row, kind):
    if kind == "processes":
        return (row.get("region"), row.get("code"), row.get("published"), row.get("entity"))
    return str(row["id"])


def rows_for_year(snapshot, region, year):
    """Keep a later year's pass from closing or retagging old open rows."""
    selected = []
    for row in snapshot.get("records", []):
        dated = source_date(row.get("published") or row.get("signed"))
        if row.get("region") == region and dated is not None and dated.year == year:
            selected.append(row)
    return selected


def merge(snapshot, region, year, kind, updates, fetched_at):
    records = {record_key(row, kind): row for row in snapshot.get("records", [])}
    added = 0
    changed = 0
    for row in updates:
        key = record_key(row, kind)
        prior = records.get(key)
        if prior is None:
            added += 1
        else:
            if kind == "processes" and prior.get("source"):
                row["source"] = prior["source"]
            if kind == "notices":
                for field in ("items", "documents"):
                    if not row.get(field) and prior.get(field):
                        row[field] = prior[field]
            if row != prior:
                changed += 1
        records[key] = row
    combined = dict(snapshot)
    combined["records"] = list(records.values())
    combined["count"] = len(records)
    combined["fetchedAt"] = fetched_at
    combined.setdefault("region", region)
    combined.setdefault("year", year)
    regions = dict(combined.get("regions") or {})
    if snapshot.get("region") and snapshot.get("year") and snapshot.get("fetchedAt"):
        prior_key = f"{snapshot['region']}:{snapshot['year']}"
        regions.setdefault(prior_key, {"fetchedAt": snapshot["fetchedAt"]})
    regions[f"{region}:{year}"] = {"fetchedAt": fetched_at}
    combined["regions"] = regions
    return combined, {"added": added, "updated": changed, "total": sum(
        row.get("region") == region
        and (dated := source_date(row.get("published") or row.get("signed"))) is not None
        and dated.year == year for row in records.values()
    )}


def write_snapshot(path, variable, snapshot):
    content = f"window.{variable} = " + json.dumps(snapshot, ensure_ascii=False, indent=2) + ";\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".refresh-", suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(content)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


async def minor_notice_updates(session, region, year, previous, existing, pending=None):
    pending = pending if pending is not None else refresh.PendingNotices()
    pending.seed(region, year, existing)
    department = refresh.department_code(region)
    cutoff = previous - timedelta(days=OVERLAP_DAYS)
    found = {}
    page = 1
    received = 0
    while True:
        result = refresh.unpack(await session.call_tool("buscar_convocatorias_menores", {
            "anio": str(year), "depa": department, "pagina": page, "tamano": 200,
        }))
        batch = result["filas"]
        pending.discover(region, year, batch)
        if not batch:
            if received < result["total"]:
                raise RuntimeError("Minor notice search ended before all records were received")
            break
        received += len(batch)
        older = False
        for row in batch:
            published = source_date(row.get("fecPublica"))
            if published is None:
                raise RuntimeError("Minor notice without a publication date; cannot advance incremental checkpoint")
            if published < cutoff:
                older = True
                break
            found[str(row["idContrato"])] = row
        if older or received >= result["total"]:
            break
        page += 1

    active = {}
    for status in ("2", "3"):
        page = 1
        received = 0
        while True:
            result = refresh.unpack(await session.call_tool("buscar_convocatorias_menores", {
                "anio": str(year), "depa": department, "estado": status,
                "pagina": page, "tamano": 10000,
            }))
            batch = result["filas"]
            pending.discover(region, year, batch)
            if not batch and received < result["total"]:
                raise RuntimeError("Minor notice status search ended before all records were received")
            received += len(batch)
            active.update((str(row["idContrato"]), row) for row in batch)
            if received >= result["total"]:
                break
            page += 1
    found.update(active)
    for row in pending.records(region, year):
        if row.get("state") in ("Vigente", "En Evaluación") and str(row.get("id")) not in active and str(row.get("id")) not in found:
            pending.discover(region, year, [{"idContrato": str(row["id"]), "nomEstadoContrato": "Culminado"}])
    return await pending.enrich(session, region, year, max_ids=20)


def potentially_open(row, now):
    if re.search(r"adjudicad|desiert|cancelad|anulad|contratad|finalizad", row.get("state") or "", re.IGNORECASE):
        return False
    dates = [source_date(row.get(field)) for field in ("registrationEnd", "end")]
    return any(value and value > now for value in dates)


async def process_updates(session, region, year, previous, existing):
    cutoff = previous - timedelta(days=OVERLAP_DAYS)
    now = datetime.now(refresh.PERU_TIME)
    open_codes = {row.get("code") for row in existing if potentially_open(row, now)}
    first = refresh.unpack(await session.call_tool("buscar_procesos", {
        "anio": str(year), "departamento": region.upper(), "pagina": 1, "paginas": 8,
    }))
    rows = first["filas"]
    page = first["pagina"] + 8
    while page <= first["paginas"]:
        older = any((source_date(row.get("fecha_publicacion")) or now) < cutoff for row in rows[-15:])
        seen = {row.get("nomenclatura") for row in rows}
        if older and open_codes <= seen:
            break
        count = min(8, first["paginas"] - page + 1)
        result = refresh.unpack(await session.call_tool("buscar_procesos", {
            "ses": first["ses"], "pagina": page, "paginas": count,
        }))
        if not result["filas"]:
            raise RuntimeError("SEACE process search ended before all requested pages were received")
        rows.extend(result["filas"])
        page += count
    selected = [row for row in rows if
                (source_date(row.get("fecha_publicacion")) or now) >= cutoff
                or row.get("nomenclatura") in open_codes]
    details = {}
    for offset in range(0, len(selected), 8):
        batch = selected[offset:offset + 8]
        result = refresh.unpack(await session.call_tool("fichas_procesos", {
            "ses": first["ses"], "indices": [row["index"] for row in batch],
            "profundidad": "completa",
        }))
        details.update((item["index"], item) for item in result.get("fichas", []))
        if result.get("faltas"):
            raise RuntimeError("Could not fetch every updated SEACE process detail")
    return [refresh.record(row, details[row["index"]], region) for row in selected]


async def contract_updates(session, region, year, previous):
    department = refresh.department_code(region)
    start = max(date(year, 1, 1), (previous - timedelta(days=CONTRACT_OVERLAP_DAYS)).date())
    end = min(date(year + 1, 1, 1), datetime.now(refresh.PERU_TIME).date() + timedelta(days=1))
    if start >= end:
        return []
    rows = await refresh.collect_minor_range(session, year, department, start, end)
    unique = {str(row["id_contrato"]): row for row in rows}
    details = {}
    ids = list(unique)
    for offset in range(0, len(ids), 10):
        result = refresh.unpack(await session.call_tool("detalles_contratos", {"ids": ids[offset:offset + 10]}))
        if result.get("faltas"):
            raise RuntimeError("Could not fetch every updated contract detail")
        details.update((str(item["cabecera"]["id_contrato"]), item) for item in result.get("detalles", []) if item.get("cabecera", {}).get("id_contrato"))
    return [refresh.minor_record(row, region, details.get(contract_id)) for contract_id, row in unique.items()]


async def refresh_region(region, year, full=False, publisher=None,
                         kinds=("notices", "processes", "contracts")):
    region = region_name(region)
    if year < 2024 or year > datetime.now(refresh.PERU_TIME).year:
        raise ValueError("Choose a valid year")
    allowed = {kind for _, _, kind in SOURCES}
    if not kinds or len(set(kinds)) != len(kinds) or set(kinds) - allowed:
        raise ValueError("Choose valid, distinct source kinds")
    selected_sources = tuple(source for source in SOURCES if source[2] in kinds)
    snapshots = {kind: read_snapshot(path) for path, _, kind in selected_sources}
    existing = {kind: rows_for_year(snapshot, region, year)
                for kind, snapshot in snapshots.items()}
    previous = {kind: checkpoint(snapshot, region, year) for kind, snapshot in snapshots.items()}
    pending = refresh.PendingNotices() if "notices" in kinds else None
    if pending is not None:
        pending.seed(region, year, existing["notices"])
    updates = {}
    params = StdioServerParameters(
        command=sys.executable,
        args=[str(refresh.ROOT / "vendor" / "seace_mcp" / "server.py")],
        env={**os.environ, "SEACE_UPDATE_CHECK": "0"},
    )
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        if pending is not None:
            updates["notices"] = (await minor_notice_updates(session, region, year, previous["notices"], existing["notices"], pending=pending)
                                  if previous["notices"] and not full else (await refresh.fetch_minor_notices(region, year, with_open_details=True, pending=pending))["records"])
        if "processes" in kinds:
            updates["processes"] = (await process_updates(session, region, year, previous["processes"], existing["processes"])
                                    if previous["processes"] and not full else (await refresh.fetch(region, year, 0))["records"])
        if "contracts" in kinds:
            updates["contracts"] = (await contract_updates(session, region, year, previous["contracts"])
                                    if previous["contracts"] and not full else (await refresh.fetch_minor_contracts(region, year))["records"])
    fetched_at = datetime.now(refresh.PERU_TIME).isoformat(timespec="seconds")
    merged = {kind: merge(snapshots[kind], region, year, kind, updates[kind], fetched_at)
              for _, _, kind in selected_sources}
    if publisher is not None:
        for _, _, kind in selected_sources:
            keys = {record_key(row, kind) for row in updates[kind]}
            # Publish the same preserved fields as the local merge, including
            # old documents when a later archive request failed.
            rows = [row for row in merged[kind][0]["records"] if record_key(row, kind) in keys]
            publisher(kind, rows, fetched_at, merged[kind][1]["total"])
    for path, variable, kind in selected_sources:
        write_snapshot(path, variable, merged[kind][0])
    if publisher is not None and pending is not None:
        pending.acknowledge(region, year)
    return {kind: merged[kind][1] for _, _, kind in selected_sources}


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default="AREQUIPA")
    parser.add_argument("--year", type=int, default=datetime.now(refresh.PERU_TIME).year)
    parser.add_argument("--full", action="store_true", help="Reconcile every record in this region")
    arguments = parser.parse_args()
    print(asyncio.run(refresh_region(arguments.region, arguments.year, arguments.full)))
