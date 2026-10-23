"""An incomplete SEACE notice can gain its public documents on a later pass."""

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "seace"))

from incremental import minor_notice_updates
from refresh import PendingNotices


def test_incremental_retries_missing_details_for_still_open_notices(tmp_path):
    future = (datetime.now(timezone(timedelta(hours=-5))) + timedelta(days=2)).strftime(
        "%d/%m/%Y %H:%M:%S"
    )
    source_rows = [
        {
            "idContrato": identifier,
            "fecPublica": "22/10/2026 08:00:00",
            "fecFinCotizacion": future,
            "nomEstadoContrato": "Vigente",
        }
        for identifier in ("103550", "103551")
    ]

    class Session:
        def __init__(self):
            self.detail_ids = []

        async def call_tool(self, name, args):
            if name == "buscar_convocatorias_menores":
                rows = source_rows if args.get("estado") == "2" else []
                payload = {"ok": True, "filas": rows, "total": len(rows)}
            else:
                self.detail_ids.extend(args["ids"])
                payload = {
                    "ok": True,
                    "detalles": {
                        "103550": {
                            "items": [{"descripcionItem": "Repuesto"}],
                            "documentos": [
                                {
                                    "nombre": "Bases",
                                    "url": "https://prod6.seace.gob.pe/doc.pdf",
                                }
                            ],
                        }
                    },
                }
            return SimpleNamespace(isError=False, structuredContent=payload)

    session = Session()
    existing = [
        {"id": "103550", "state": "Vigente", "items": [], "documents": []},
        {"id": "103551", "state": "Vigente", "items": ["Known"], "documents": []},
    ]
    updates = asyncio.run(
        minor_notice_updates(
            session,
            "Arequipa",
            2026,
            datetime.now(timezone(timedelta(hours=-5))),
            existing,
            pending=PendingNotices(tmp_path / "pending.sqlite3"),
        )
    )
    # A known item does not prove that the independent archive request succeeded.
    assert session.detail_ids == ["103550", "103551"]
    assert next(row for row in updates if row["id"] == "103550")["documents"] == [
        {"name": "Bases", "url": "https://prod6.seace.gob.pe/doc.pdf"}
    ]
    assert next(row for row in updates if row["id"] == "103551")["items"] == ["Known"]
