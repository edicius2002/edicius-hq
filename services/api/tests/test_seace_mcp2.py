"""Exercise the SEACE client against the vendored MCP server over stdio."""

import asyncio
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import CallToolResult

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "seace"))

import refresh


def test_unpack_reads_v2_structured_result():
    result = CallToolResult(content=[], is_error=False, structured_content={"ok": True, "value": 7})

    assert refresh.unpack(result) == {"ok": True, "value": 7}


def test_seace_server_and_client_exchange_tool_result_over_stdio(tmp_path):
    server = Path(__file__).resolve().parents[2] / "seace/vendor/seace_mcp/server.py"
    params = StdioServerParameters(
        command=sys.executable,
        args=[str(server)],
        env={**os.environ, "SEACE_UPDATE_CHECK": "0", "SEACE_STATE_DIR": str(tmp_path)},
    )

    async def exercise():
        async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert "url_perfil_proveedor" in {tool.name for tool in tools.tools}
            result = await session.call_tool("url_perfil_proveedor", {"ruc": "20600138899"})
            return refresh.unpack(result)

    assert asyncio.run(exercise()) == {
        "ok": True,
        "url": "https://apps.oece.gob.pe/perfilprov-ui/ficha/20600138899",
    }
