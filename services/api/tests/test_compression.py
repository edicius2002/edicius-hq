"""
What the wire is allowed to compress, and what it must never touch.

`GET /api/fares/history` answers with every snapshot for a city pair — measured
at 1,960,559 bytes for one month of LIM-MAD — and the reader is usually on
another device, over a Tailscale path that is sometimes a DERP relay. Those
bytes are the reason compression is here at all.

The second test is the one worth having. Four endpoints stream server-sent
events, and every one of them was engineered against buffering: they set
`X-Accel-Buffering: no`, they emit a keep-alive comment on a silent interval,
and `test_fares_stream` pins the order frames arrive in. A gzip layer applied to
the whole app compresses those too — which at best re-frames each tick and at
worst holds it inside zlib until enough bytes accumulate, turning a live stream
into a stream that arrives in bursts. Nothing else in the suite would notice,
because the frames still arrive and still parse; only the timing changes, and
timing is the entire point of the endpoint. So it is pinned here, at the layer
where the decision is made, on a real route through the real middleware stack.
"""

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import auth_store

client = TestClient(app)

#: 334 kB of TopoJSON that ships with the code, so the size is not a fixture's
#: opinion and no collection has to have run for this to be worth compressing.
BIG_JSON = "/api/geography/subdivisions/840"

#: The collection stream answers its first frame before it waits for anything,
#: which is what makes it drivable here. `/api/market/stream` would need an
#: upstream socket; the middleware cannot tell the two apart and does not care.
SSE_ROUTE = "/api/fares/collect/stream"


def test_large_json_is_compressed_for_a_client_that_asks():
    """Catches the compression being dropped, or its floor set above a payload."""
    response = client.get(BIG_JSON, headers={"Accept-Encoding": "gzip"})

    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
    # httpx has already decoded the body, so this compares what crossed the
    # wire against what the reader ends up with.
    assert int(response.headers["content-length"]) < len(response.content)


def test_json_is_left_alone_for_a_client_that_does_not_ask():
    """Catches a compressed body sent to a client that never advertised gzip."""
    response = client.get(BIG_JSON, headers={"Accept-Encoding": "identity"})

    assert response.status_code == 200
    assert "content-encoding" not in response.headers


async def first_frames(path: str, count: int) -> list[dict]:
    """
    Drive the whole ASGI stack by hand and stop at the first `count` messages.

    `TestClient` cannot do this: a stream never ends, so a client that asked for
    one and waited for a body would wait forever — the same reason
    `test_fares_stream` iterates `body_iterator` directly. Going through
    `app` rather than the router is the point here, though, because the
    middleware is what is being tested.
    """
    enough = asyncio.Event()
    messages: list[dict] = []

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        # Built by hand, so the conftest fixture that puts a session on every
        # `TestClient` request never sees this one. The gate is not relaxed for
        # it either: a real token from the real store is presented, the same way
        # that fixture does it.
        "headers": [
            (b"host", b"testserver"),
            (b"accept-encoding", b"gzip"),
            (b"authorization", f"Bearer {auth_store.create_session()}".encode()),
        ],
        "client": ("127.0.0.1", 51234),
        "server": ("testserver", 80),
    }

    async def receive() -> dict:
        # The client never goes away; the test ends by cancelling instead.
        await asyncio.Event().wait()
        raise AssertionError("unreachable")  # pragma: no cover

    async def send(message: dict) -> None:
        messages.append(message)
        if len(messages) >= count:
            enough.set()

    serving = asyncio.create_task(app(scope, receive, send))
    try:
        async with asyncio.timeout(5):
            await enough.wait()
    finally:
        serving.cancel()
        with pytest.raises(asyncio.CancelledError):
            await serving
    return messages


def test_event_stream_is_never_compressed_however_the_client_asks():
    """
    Catches a gzip layer reaching the streams, which nothing else would notice.

    The client here asks for gzip in the loudest way it can. What comes back
    must still be the frame as `sse()` spelled it: no `Content-Encoding`, and a
    first chunk that reads as text rather than as a gzip header — a compressed
    stream would open with `\\x1f\\x8b`, and one buffered inside zlib would open
    with nothing at all.
    """
    start, first_chunk = asyncio.run(first_frames(SSE_ROUTE, 2))

    headers = {name.decode().lower(): value.decode() for name, value in start["headers"]}
    assert start["type"] == "http.response.start"
    assert headers["content-type"].startswith("text/event-stream")
    assert "content-encoding" not in headers
    # The unbuffered hint the endpoint sets for proxies has to survive too.
    assert headers["x-accel-buffering"] == "no"

    assert first_chunk["type"] == "http.response.body"
    assert first_chunk["body"].startswith(b"event: pass\ndata: {")
    assert first_chunk.get("more_body") is True
