"""Refresh the local prototype snapshot through the cloned SEACE MCP server."""

import argparse
import asyncio
import json
import os
import re
import sys
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parent
STATE_DIR = Path(os.environ.get("SEACE_STATE_DIR", str(ROOT / "state")))
OUTPUT = STATE_DIR / "data.js"
MINOR_OUTPUT = STATE_DIR / "minor-data.js"
MINOR_NOTICE_OUTPUT = STATE_DIR / "minor-notices.js"
PERU_TIME = timezone(timedelta(hours=-5))
DEPARTMENT_NAMES = [
    "Amazonas", "Áncash", "Apurímac", "Arequipa", "Ayacucho", "Cajamarca",
    "Callao", "Cusco", "Huancavelica", "Huánuco", "Ica", "Junín",
    "La Libertad", "Lambayeque", "Lima", "Loreto", "Madre de Dios",
    "Moquegua", "Pasco", "Piura", "Puno", "San Martín", "Tacna",
    "Tumbes", "Ucayali",
]
DEPARTMENT_CODES = {
    "".join(char for char in unicodedata.normalize("NFKD", name) if not unicodedata.combining(char)).upper(): f"{index:02d}"
    for index, name in enumerate(DEPARTMENT_NAMES, 1)
}


def unpack(result):
    if result.isError:
        raise RuntimeError("MCP tool failed: " + " ".join(x.text for x in result.content if x.type == "text"))
    data = result.structuredContent
    if data is None:
        data = json.loads(next(x.text for x in result.content if x.type == "text"))
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "SEACE MCP returned no data"))
    return data


def plain(value):
    return "".join(c for c in unicodedata.normalize("NFKD", value or "") if not unicodedata.combining(c)).lower()


def department_code(region):
    code = DEPARTMENT_CODES.get(plain(region).upper())
    if code is None:
        raise ValueError(f"Unsupported region: {region}")
    return code


def deadline(cronograma, phrase):
    for activity in cronograma:
        if phrase in plain(activity.get("actividad", "")):
            return activity.get("inicio"), activity.get("fin")
    return None, None


def type_code(nomenclatura):
    match = re.match(r"^(.+?)-\d+-20\d{2}(?:-|$)", nomenclatura or "")
    return match.group(1) if match else ""


def record(row, detail, region):
    head = detail.get("cabecera") or {}
    schedule = detail.get("cronograma") or []
    proposal_start, proposal_end = deadline(schedule, "presentacion de propuestas")
    registration_start, registration_end = deadline(schedule, "registro de participantes")
    code = head.get("nomenclatura") or row.get("nomenclatura") or ""
    amount = head.get("monto_contratacion") or row.get("monto") or ""
    if amount in ("---", "Reservado"):
        amount = ""
    return {
        "code": code,
        "region": region,
        "minor": type_code(code) == "CM",
        "type": type_code(code),
        "entity": head.get("entidad") or row.get("entidad") or "",
        "description": head.get("descripcion_objeto") or row.get("descripcion") or "",
        "object": head.get("objeto") or row.get("objeto") or "",
        "items": [item.get("item", "") for item in detail.get("items", []) if item.get("item")],
        "published": head.get("fecha_publicacion") or row.get("fecha_publicacion") or "",
        "registrationStart": registration_start,
        "registrationEnd": registration_end,
        "start": proposal_start,
        "end": proposal_end,
        "amount": amount,
        "currency": row.get("moneda") or "",
        "state": ", ".join(dict.fromkeys(item.get("estado", "") for item in detail.get("items", []) if item.get("estado"))),
        "source": detail.get("url_ficha") or "",
        "documents": [
            {"name": doc.get("documento") or doc.get("archivo") or "Document", "uuid": doc.get("uuid") or ""}
            for doc in detail.get("documentos", []) if doc.get("uuid")
        ],
    }


async def collect_minor_range(session, year, department, start, end):
    """Fetch every published minor contract, splitting any capped date range."""
    result = unpack(await session.call_tool("buscar_contratos", {
        "anio": str(year), "depa": department, "cod_seleccion": "2036",
        "desde": start.strftime("%d/%m/%Y"), "hasta": end.strftime("%d/%m/%Y"),
        "maximo": 300,
    }))
    total = result["total_recibidos"]
    rows = result["contratos"]
    if total <= 300:
        if len(rows) != total:
            raise RuntimeError(f"Minor contract search returned {len(rows)} of {total} rows")
        return rows
    if (end - start).days <= 1:
        raise RuntimeError(f"More than 300 minor contracts on {start}; cannot fetch all")
    middle = start + timedelta(days=(end - start).days // 2)
    left = await collect_minor_range(session, year, department, start, middle)
    right = await collect_minor_range(session, year, department, middle, end)
    return left + right


def minor_record(row, region, detail=None):
    detail = detail or {}
    contract_id = row["id_contrato"]
    document_id = row.get("id_documento") or ""
    documents = [*detail.get("documentos", [])]
    documents.extend(action["documento"] for action in detail.get("acciones", []) if action.get("documento"))
    resources = []
    seen_urls = set()
    for document in documents:
        url = document.get("url")
        if url and url not in seen_urls:
            resources.append({"name": document.get("archivo") or "Contract document", "url": url})
            seen_urls.add(url)
    primary_url = f"https://prod4.seace.gob.pe:9000/api/con/documentos/descargar/{document_id}" if document_id else ""
    primary = next((document for document in resources if document["url"] == primary_url), None)
    return {
        "id": contract_id,
        "code": row.get("nomenclatura") or row.get("numero_contrato") or contract_id,
        "contractNumber": row.get("numero_contrato") or "",
        "region": region,
        "minor": True,
        "entity": row.get("entidad") or "",
        "description": row.get("descripcion") or "",
        "object": row.get("objeto") or "",
        "contractor": row.get("contratista") or "",
        "signed": row.get("fecha_suscripcion") or "",
        "termStart": row.get("fecha_inicio") or "",
        "termEnd": row.get("fecha_fin") or "",
        "amount": row.get("monto") or "",
        "budget": row.get("monto_presupuesto") or "",
        "currency": row.get("moneda") or "",
        "state": row.get("estado") or "",
        "source": f"https://prod4.seace.gob.pe:9000/api/bus/contrato/idContrato/{contract_id}",
        "documentUrl": primary_url,
        "documentName": primary["name"] if primary else "Contract PDF",
        "documents": [document for document in resources if document["url"] != primary_url],
    }


def minor_notice_record(row, region, detail=None):
    detail = detail or {}
    items = []
    for item in detail.get("items") or []:
        description = item.get("descripcionItem") or item.get("descripcion") or item.get("nomCubso")
        if description:
            quantity = item.get("cantidad")
            items.append(f"{description} ({quantity})" if quantity not in (None, "") else description)
    documents = detail.get("documentos") or []
    contract_id = str(row["idContrato"])
    return {
        "id": contract_id,
        "kind": "minor_notice",
        "code": row.get("desContratacion") or "",
        "region": region,
        "minor": True,
        "type": "CM",
        "entity": row.get("nomEntidad") or "",
        "description": row.get("desObjetoContrato") or "",
        "object": row.get("nomObjetoContrato") or "",
        "items": items,
        "published": row.get("fecPublica") or "",
        "registrationEnd": "",
        "start": row.get("fecIniCotizacion") or "",
        "end": row.get("fecFinCotizacion") or "",
        "amount": "",
        "currency": "",
        "state": row.get("nomEstadoContrato") or "",
        "source": f"https://prod6.seace.gob.pe/buscador-publico/contrataciones/{contract_id}",
        "documentUrl": "",
        "documents": [
            {"name": document.get("nombre") or "Requirement PDF", "url": document.get("url")}
            for document in documents if document.get("url")
        ],
    }


async def fetch_minor_notices(region, year, with_open_details=False):
    department = department_code(region)
    params = StdioServerParameters(
        command=sys.executable,
        args=[str(ROOT / "vendor" / "seace_mcp" / "server.py")],
        env={**os.environ, "SEACE_UPDATE_CHECK": "0"},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            rows = []
            page = 1
            total = None
            while total is None or len(rows) < total:
                result = unpack(await session.call_tool("buscar_convocatorias_menores", {
                    "anio": str(year), "depa": department, "pagina": page, "tamano": 10000,
                }))
                total = result["total"]
                batch = result["filas"]
                if not batch and len(rows) < total:
                    raise RuntimeError(f"Minor notice search stopped at {len(rows)} of {total}")
                rows.extend(batch)
                print(f"Minor notices {len(rows)}/{total}", flush=True)
                page += 1
            unique = {str(row["idContrato"]): row for row in rows}
            if len(rows) != total or len(unique) != total:
                raise RuntimeError(f"Minor notice search returned {len(rows)} rows and {len(unique)} IDs of {total}")
            details = {}
            if with_open_details:
                now = datetime.now(PERU_TIME)
                open_ids = []
                for contract_id, row in unique.items():
                    if row.get("nomEstadoContrato") != "Vigente":
                        continue
                    try:
                        deadline = datetime.strptime(row["fecFinCotizacion"], "%d/%m/%Y %H:%M:%S").replace(tzinfo=PERU_TIME)
                    except (KeyError, TypeError, ValueError):
                        continue
                    if deadline > now:
                        open_ids.append(contract_id)
                for offset in range(0, len(open_ids), 20):
                    ids = open_ids[offset:offset + 20]
                    result = unpack(await session.call_tool("detalles_convocatorias_menores", {"ids": ids}))
                    details.update(result["detalles"])
                    if result.get("faltas"):
                        print(f"Details unavailable for {len(result['faltas'])} notices; official links remain available", flush=True)
                    print(f"Minor notice details {min(offset + 20, len(open_ids))}/{len(open_ids)}", flush=True)
    return {
        "fetchedAt": datetime.now(PERU_TIME).isoformat(timespec="seconds"),
        "source": "Minor contract notices via seace-mcp buscar_convocatorias_menores",
        "region": region.title(),
        "year": year,
        "complete": True,
        "count": len(unique),
        "detailsFetched": len(details),
        "records": [minor_notice_record(row, region.title(), details.get(contract_id))
                    for contract_id, row in unique.items()],
    }


async def fetch_minor_contracts(region, year):
    department = department_code(region)
    now = datetime.now(PERU_TIME)
    details = {}
    if year > now.year:
        rows = []
    else:
        params = StdioServerParameters(
            command=sys.executable,
        args=[str(ROOT / "vendor" / "seace_mcp" / "server.py")],
            env={**os.environ, "SEACE_UPDATE_CHECK": "0"},
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                rows = await collect_minor_range(session, year, department, date(year, 1, 1), date(year + 1, 1, 1))
                ids = list(dict.fromkeys(row["id_contrato"] for row in rows))
                for offset in range(0, len(ids), 10):
                    result = unpack(await session.call_tool("detalles_contratos", {"ids": ids[offset:offset + 10]}))
                    details.update({item["cabecera"]["id_contrato"]: item for item in result.get("detalles", [])
                                    if item.get("cabecera", {}).get("id_contrato")})
                    print(f"Contract details {min(offset + 10, len(ids))}/{len(ids)}", flush=True)
    unique = {row["id_contrato"]: row for row in rows}
    return {
        "fetchedAt": datetime.now(PERU_TIME).isoformat(timespec="seconds"),
        "source": "Published contracts via seace-mcp buscar_contratos",
        "region": region.title(),
        "year": year,
        "complete": True,
        "dateBasis": "fecha_suscripcion",
        "count": len(unique),
        "detailsFetched": len(details),
        "records": [minor_record(row, region.title(), details.get(row["id_contrato"])) for row in unique.values()],
    }


async def fetch(region, year, page_limit):
    params = StdioServerParameters(
        command=sys.executable,
            args=[str(ROOT / "vendor" / "seace_mcp" / "server.py")],
        env={**os.environ, "SEACE_UPDATE_CHECK": "0"},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            first = unpack(await session.call_tool("buscar_procesos", {
                "anio": str(year), "departamento": region.upper(), "pagina": 1,
                "paginas": min(page_limit or 8, 8),
            }))
            rows = first["filas"]
            page = first["pagina"] + min(page_limit or 8, 8)
            page_count = first["paginas"]
            last_page = min(page_count, page_limit or page_count)
            while page <= last_page:
                count = min(8, last_page - page + 1)
                result = unpack(await session.call_tool("buscar_procesos", {
                    "ses": first["ses"], "pagina": page, "paginas": count,
                }))
                rows.extend(result["filas"])
                page += count
            print(f"Found {first['total']} processes; fetching details for {len(rows)} rows", flush=True)
            details = {}
            missing = []
            for offset in range(0, len(rows), 8):
                batch = rows[offset:offset + 8]
                result = unpack(await session.call_tool("fichas_procesos", {
                    "ses": first["ses"],
                    "indices": [row["index"] for row in batch],
                    "profundidad": "completa",
                }))
                details.update({item["index"]: item for item in result.get("fichas", [])})
                missing.extend(result.get("faltas", []))
                print(f"Details {min(offset + 8, len(rows))}/{len(rows)}", flush=True)
            records = [record(row, details[row["index"]], region.title()) for row in rows if row["index"] in details]
            return {
                "fetchedAt": datetime.now(PERU_TIME).isoformat(timespec="seconds"),
                "source": "SEACE 3.0 via seace-mcp",
                "region": region.title(),
                "year": year,
                "searched": first["total"],
                "fetched": len(rows),
                "detailed": len(records),
                "complete": len(rows) >= first["total"] and not missing,
                "missing": missing,
                "records": records,
            }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default="AREQUIPA")
    parser.add_argument("--year", type=int, default=datetime.now(PERU_TIME).year)
    parser.add_argument("--pages", type=int, default=0, help="Limit SEACE 3.0 search pages (15 rows each); default fetches all")
    parser.add_argument("--all", action="store_true", help="Inspect every search page for the selected year and region")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--contracts-only", action="store_true", help="Refresh published minor contracts only")
    selection.add_argument("--minor-notices-only", action="store_true", help="Refresh minor contract notices only")
    selection.add_argument("--processes-only", action="store_true", help="Refresh SEACE 3.0 processes only")
    parser.add_argument("--with-open-details", action="store_true", help="Fetch items and requirement PDFs for open minor notices; may be rate limited")
    args = parser.parse_args()
    if args.pages < 0:
        parser.error("--pages cannot be negative")
    try:
        snapshot = None if (args.contracts_only or args.minor_notices_only) else asyncio.run(fetch(args.region, args.year, 0 if args.all else args.pages))
        minor_snapshot = None if (args.minor_notices_only or args.processes_only) else asyncio.run(fetch_minor_contracts(args.region, args.year))
        minor_notice_snapshot = None if (args.contracts_only or args.processes_only) else asyncio.run(fetch_minor_notices(args.region, args.year, args.with_open_details))
    except Exception as exc:
        while getattr(exc, "exceptions", None):
            exc = exc.exceptions[0]
        parser.exit(1, f"Refresh failed: {exc}\n")
    if snapshot is not None:
        OUTPUT.write_text("window.SEACE_DATA = " + json.dumps(snapshot, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
        print(f"Saved {snapshot['detailed']} notice records to {OUTPUT}", flush=True)
    if minor_snapshot is not None:
        MINOR_OUTPUT.write_text("window.SEACE_MINOR_DATA = " + json.dumps(minor_snapshot, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
        print(f"Saved {minor_snapshot['count']} published minor contracts to {MINOR_OUTPUT}", flush=True)
    if minor_notice_snapshot is not None:
        MINOR_NOTICE_OUTPUT.write_text("window.SEACE_MINOR_NOTICES = " + json.dumps(minor_notice_snapshot, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
        print(f"Saved {minor_notice_snapshot['count']} minor notices to {MINOR_NOTICE_OUTPUT}", flush=True)


if __name__ == "__main__":
    main()
