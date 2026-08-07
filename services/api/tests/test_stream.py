import asyncio
import base64
import json
import struct
import time

import pytest

from app.adapters import binance_stream, yahoo_stream
from app.services import stream_hub
from app.adapters.wire import WireError, read_base64_message, read_message


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def field(number: int, kind: int) -> bytes:
    """The key is itself a varint, so field 99 is two bytes, not one."""
    return varint((number << 3) | kind)


def text_field(number: int, value: str) -> bytes:
    raw = value.encode()
    return field(number, 2) + varint(len(raw)) + raw


def float_field(number: int, value: float) -> bytes:
    return field(number, 5) + struct.pack("<f", value)


def varint_field(number: int, value: int) -> bytes:
    return field(number, 0) + varint(value)


def sint_field(number: int, value: int) -> bytes:
    """A `sint64`, encoded the way protobuf does it: sign in the low bit."""
    return field(number, 0) + varint((value << 1) ^ (value >> 63))


def pricing(**over) -> str:
    """A frame shaped like the ones the live socket sends."""
    body = (
        text_field(1, over.get("symbol", "AAPL"))
        + float_field(2, over.get("price", 312.56))
        + sint_field(3, over.get("time", 1_786_060_798_000))
        + text_field(5, over.get("exchange", "NMS"))
        + varint_field(7, over.get("hours", 1))
        + float_field(8, over.get("change_percent", 0.5))
    )
    return json.dumps({"type": "pricing", "message": base64.b64encode(body).decode()})


class TestWireFormat:
    def test_reads_each_type_the_stream_uses(self):
        fields = read_message(
            text_field(1, "MSFT") + float_field(2, 497.36) + varint_field(7, 4)
        )

        assert fields[1] == b"MSFT"
        assert fields[2] == pytest.approx(497.36, abs=1e-3)
        assert fields[7] == 4

    def test_skips_a_field_it_does_not_know_rather_than_refusing(self):
        # An upstream that adds a field must not take the price with it.
        fields = read_message(
            text_field(1, "AAPL") + varint_field(99, 7) + float_field(2, 100.0)
        )

        assert fields[1] == b"AAPL"
        assert fields[2] == pytest.approx(100.0)

    def test_refuses_a_truncated_message(self):
        with pytest.raises(WireError):
            read_message(field(2, 5) + b"\x00\x01")

    def test_refuses_a_varint_that_never_ends(self):
        # Otherwise a corrupt frame walks off the end shifting forever.
        with pytest.raises(WireError):
            read_message(field(1, 0) + b"\x80" * 12)

    def test_refuses_a_length_that_overruns(self):
        with pytest.raises(WireError):
            read_message(field(1, 2) + varint(50) + b"short")

    def test_refuses_payloads_that_are_not_base64(self):
        with pytest.raises(WireError):
            read_base64_message("not base64 at all!!")


class TestParsingATick:
    def test_reads_a_live_shaped_frame(self):
        tick = yahoo_stream.parse_tick(pricing(symbol="NVDA", price=218.82, hours=4))

        assert tick is not None
        assert tick.symbol == "NVDA"
        assert tick.price == pytest.approx(218.82, abs=1e-2)
        assert tick.market_state == "PRE"
        assert tick.provider == "yahoo"

    def test_reports_time_in_seconds_like_everything_else(self):
        tick = yahoo_stream.parse_tick(pricing(time=1_786_060_798_000))

        assert tick is not None
        assert tick.time == pytest.approx(1_786_060_798)

    def test_undoes_the_zigzag_on_the_timestamp(self):
        # Field 3 is a `sint64`. Read as a plain varint it comes out doubled,
        # which put a live tick in the year 2083 the first time this ran.
        tick = yahoo_stream.parse_tick(pricing(time=1_786_079_026_000))

        assert tick.time == pytest.approx(1_786_079_026)
        assert 2020 < time.gmtime(tick.time).tm_year < 2050

    def test_names_the_regular_session_as_the_exchange_does(self):
        assert yahoo_stream.parse_tick(pricing(hours=1)).market_state == "REGULAR"
        assert yahoo_stream.parse_tick(pricing(hours=2)).market_state == "POST"

    @pytest.mark.parametrize(
        "message",
        [
            "not json",
            json.dumps({"type": "pricing"}),
            json.dumps({"type": "pricing", "message": 12}),
            json.dumps({"type": "pricing", "message": "%%%"}),
            json.dumps([1, 2, 3]),
        ],
    )
    def test_ignores_a_frame_it_cannot_read(self, message):
        # A bad frame is a reason to drop that frame, not the connection.
        assert yahoo_stream.parse_tick(message) is None

    def test_ignores_a_frame_with_no_price(self):
        body = text_field(1, "AAPL")
        message = json.dumps({"message": base64.b64encode(body).decode()})

        assert yahoo_stream.parse_tick(message) is None


class FakeSocket:
    """A socket that yields the frames it was given, then does what it was told."""

    def __init__(self, frames: list[str], *, then: Exception | None = None) -> None:
        self._frames = frames
        self._then = then
        self.sent: list[str] = []

    async def __aenter__(self) -> "FakeSocket":
        return self

    async def __aexit__(self, *_: object) -> bool:
        return False

    async def send(self, frame: str) -> None:
        self.sent.append(frame)

    def __aiter__(self):
        async def frames():
            for frame in self._frames:
                yield frame
            if self._then is not None:
                raise self._then

        return frames()


def cancelling_sleep():
    """
    A sleep that ends the loop.

    Every reconnect waits before retrying, so a test that let the real one run
    would either hang or sit through a backoff. Ending there also asserts the
    obvious: the loop does not retry without waiting first.
    """

    async def sleep(_seconds: float) -> None:
        raise asyncio.CancelledError

    return sleep


async def take(stream: yahoo_stream.YahooStream, count: int) -> list[yahoo_stream.Tick]:
    out: list[yahoo_stream.Tick] = []
    ticks = stream.ticks()
    try:
        async for tick in ticks:
            out.append(tick)
            if len(out) >= count:
                break
    finally:
        await ticks.aclose()
    return out


class TestTheConnection:
    def test_subscribes_to_everything_it_follows_on_connect(self):
        socket = FakeSocket([pricing()])

        async def run():
            stream = yahoo_stream.YahooStream(
                connect=lambda _url: socket, sleep=cancelling_sleep()
            )
            await stream.watch({"AAPL", "MSFT"})
            return await take(stream, 1)

        asyncio.run(run())

        assert json.loads(socket.sent[0]) == {"subscribe": ["AAPL", "MSFT"]}

    def test_resubscribes_from_scratch_after_a_drop(self):
        # Replaying a subscription is how the followed set silently drifts from
        # what the connection actually carries.
        sockets = [
            FakeSocket([pricing()], then=ConnectionError("dropped")),
            FakeSocket([pricing(symbol="MSFT")]),
        ]
        opened: list[FakeSocket] = []

        def connect(_url):
            socket = sockets[min(len(opened), len(sockets) - 1)]
            opened.append(socket)
            return socket

        async def run():
            stream = yahoo_stream.YahooStream(connect=connect, sleep=_no_wait)
            await stream.watch({"AAPL"})
            return await take(stream, 2)

        ticks = asyncio.run(run())

        assert [t.symbol for t in ticks] == ["AAPL", "MSFT"]
        assert json.loads(opened[1].sent[0]) == {"subscribe": ["AAPL"]}

    def test_backs_off_further_each_time_it_fails(self):
        waits: list[float] = []

        async def sleep(seconds: float) -> None:
            waits.append(seconds)
            if len(waits) >= 4:
                raise asyncio.CancelledError

        def refuse(_url):
            raise ConnectionError("refused")

        async def run():
            stream = yahoo_stream.YahooStream(connect=refuse, sleep=sleep)
            await take(stream, 1)

        with pytest.raises(asyncio.CancelledError):
            asyncio.run(run())

        assert waits == [1.0, 2.0, 4.0, 8.0]

    def test_stops_lengthening_the_wait_at_the_ceiling(self):
        waits: list[float] = []

        async def sleep(seconds: float) -> None:
            waits.append(seconds)
            if len(waits) >= 9:
                raise asyncio.CancelledError

        async def run():
            stream = yahoo_stream.YahooStream(
                connect=lambda _url: (_ for _ in ()).throw(ConnectionError("no")),
                sleep=sleep,
            )
            await take(stream, 1)

        with pytest.raises(asyncio.CancelledError):
            asyncio.run(run())

        assert waits[-1] == yahoo_stream._BACKOFF_MAX

    def test_tells_an_open_socket_when_the_set_changes(self):
        socket = FakeSocket([pricing(), pricing(), pricing()])

        async def run():
            stream = yahoo_stream.YahooStream(
                connect=lambda _url: socket, sleep=cancelling_sleep()
            )
            await stream.watch({"AAPL"})
            ticks = stream.ticks()
            await anext(ticks)
            await stream.watch({"AAPL", "NVDA"})
            await ticks.aclose()

        asyncio.run(run())

        assert json.loads(socket.sent[-1]) == {"subscribe": ["AAPL", "NVDA"]}

    def test_says_nothing_when_the_set_has_not_changed(self):
        socket = FakeSocket([pricing(), pricing()])

        async def run():
            stream = yahoo_stream.YahooStream(
                connect=lambda _url: socket, sleep=cancelling_sleep()
            )
            await stream.watch({"AAPL"})
            ticks = stream.ticks()
            await anext(ticks)
            await stream.watch({"AAPL"})
            await ticks.aclose()

        asyncio.run(run())

        assert len(socket.sent) == 1


async def _no_wait(_seconds: float) -> None:
    """Reconnect immediately, for the tests that are about what happens after."""


class FakeUpstream:
    """An upstream that records what it was asked to watch and says nothing."""

    def __init__(self) -> None:
        self.watched: list[set[str]] = []

    async def watch(self, symbols: set[str]) -> None:
        self.watched.append(set(symbols))

    async def ticks(self):
        while True:
            await asyncio.sleep(3600)
            yield  # pragma: no cover


def tick(symbol: str, price: float) -> yahoo_stream.Tick:
    return yahoo_stream.Tick(symbol=symbol, price=price)


class TestTheHub:
    def test_asks_upstream_for_the_union_of_what_listeners_want(self):
        hub = stream_hub.StreamHub(flush_seconds=0)
        upstream = FakeUpstream()
        hub.attach(upstream)

        async def run():
            a = hub.listen({"AAPL", "MSFT"})
            b = hub.listen({"MSFT", "NVDA"})
            await anext(_started(a, hub, tick("AAPL", 1)))
            await anext(_started(b, hub, tick("NVDA", 1)))
            symbols = hub.symbols
            await a.aclose()
            await b.aclose()
            return symbols

        assert asyncio.run(run()) == {"AAPL", "MSFT", "NVDA"}

    def test_keeps_a_symbol_upstream_while_anyone_still_wants_it(self):
        # Two tabs on the same watchlist must cost one subscription, and the
        # first one leaving must not unsubscribe the second.
        hub = stream_hub.StreamHub(flush_seconds=0)
        upstream = FakeUpstream()
        hub.attach(upstream)

        async def run():
            a = hub.listen({"AAPL"})
            b = hub.listen({"AAPL"})
            await anext(_started(a, hub, tick("AAPL", 1)))
            await anext(_started(b, hub, tick("AAPL", 2)))
            await a.aclose()
            after_one_left = hub.symbols
            await b.aclose()
            return after_one_left, hub.symbols

        after_one_left, after_both = asyncio.run(run())

        assert after_one_left == {"AAPL"}
        assert after_both == set()

    def test_a_listener_only_hears_the_symbols_it_asked_for(self):
        hub = stream_hub.StreamHub(flush_seconds=0)

        async def run():
            stream = hub.listen({"AAPL"})
            batch = await anext(_started(stream, hub, tick("MSFT", 1), tick("AAPL", 2)))
            await stream.aclose()
            return batch

        batch = asyncio.run(run())

        assert [t.symbol for t in batch] == ["AAPL"]

    def test_an_unread_tick_is_replaced_by_a_newer_one_not_queued_behind_it(self):
        # A slow reader should fall behind in time, never in truth.
        hub = stream_hub.StreamHub(flush_seconds=0)

        async def run():
            stream = hub.listen({"AAPL"})
            batch = await anext(
                _started(stream, hub, tick("AAPL", 1), tick("AAPL", 2), tick("AAPL", 3))
            )
            await stream.aclose()
            return batch

        batch = asyncio.run(run())

        assert len(batch) == 1
        assert batch[0].price == 3

    def test_delivers_every_symbol_that_moved_in_one_batch(self):
        hub = stream_hub.StreamHub(flush_seconds=0)

        async def run():
            stream = hub.listen({"AAPL", "MSFT"})
            batch = await anext(_started(stream, hub, tick("AAPL", 1), tick("MSFT", 2)))
            await stream.aclose()
            return batch

        batch = asyncio.run(run())

        assert sorted(t.symbol for t in batch) == ["AAPL", "MSFT"]

    def test_does_not_repeat_a_price_that_has_not_moved(self):
        # Binance's rolling ticker sends every second whether or not anything
        # traded; showing the same number again costs a render and says nothing.
        hub = stream_hub.StreamHub(flush_seconds=0)

        async def run():
            stream = hub.listen({"BTCUSDT"})
            first = await anext(
                _started(stream, hub, tick("BTCUSDT", 64250.99), tick("BTCUSDT", 64250.99))
            )
            second = await anext(_started(stream, hub, tick("BTCUSDT", 64251.00)))
            await stream.aclose()
            return first, second

        first, second = asyncio.run(run())

        assert [t.price for t in first] == [64250.99]
        assert [t.price for t in second] == [64251.00]

    def test_still_reports_a_change_that_is_not_the_price(self):
        # The bell moving a symbol from PRE to REGULAR is news even if the last
        # trade was at the same price.
        hub = stream_hub.StreamHub(flush_seconds=0)

        async def run():
            stream = hub.listen({"AAPL"})
            await anext(
                _started(stream, hub, yahoo_stream.Tick("AAPL", 100.0, market_state="PRE"))
            )
            batch = await anext(
                _started(
                    stream, hub, yahoo_stream.Tick("AAPL", 100.0, market_state="REGULAR")
                )
            )
            await stream.aclose()
            return batch

        assert asyncio.run(run())[0].market_state == "REGULAR"

    def test_a_tick_for_nobody_is_simply_dropped(self):
        hub = stream_hub.StreamHub(flush_seconds=0)
        hub.publish(tick("AAPL", 1))

        assert hub.listener_count == 0
        assert hub.symbols == set()


async def _started(stream, hub, *ticks):
    """
    Registers the listener, then feeds it.

    `listen` only takes its symbols on the first step, so publishing before
    that step would be publishing into an empty room.
    """
    task = asyncio.ensure_future(anext(stream))
    await asyncio.sleep(0)
    for item in ticks:
        hub.publish(item)
    yield await task


class TestBinanceStreaming:
    def test_asks_for_one_combined_socket_rather_than_one_each(self):
        url = binance_stream.stream_url(["ETHUSDT", "BTCUSDT"])

        # Ten pairs must cost one connection, for the same reason quotes are
        # batched in decision 8.13.
        assert url.endswith("?streams=btcusdt@ticker/ethusdt@ticker")

    def test_reads_a_combined_frame(self):
        message = json.dumps(
            {"stream": "btcusdt@ticker", "data": {"s": "BTCUSDT", "c": "64286.72", "P": "-0.32"}}
        )

        tick = binance_stream.parse_tick(message)

        assert tick is not None
        assert tick.symbol == "BTCUSDT"
        assert tick.price == pytest.approx(64286.72)
        assert tick.change_percent == pytest.approx(-0.32)
        assert tick.provider == "binance"

    def test_reads_a_bare_frame_too(self):
        # The URL's shape should not also be a decision about the parser.
        tick = binance_stream.parse_tick(json.dumps({"s": "ETHUSDT", "c": "1898.68"}))

        assert tick is not None
        assert tick.symbol == "ETHUSDT"

    def test_calls_a_pair_regular_because_it_never_closes(self):
        tick = binance_stream.parse_tick(json.dumps({"s": "BTCUSDT", "c": "1"}))

        # Saves the badge from special-casing crypto.
        assert tick.market_state == "REGULAR"

    @pytest.mark.parametrize(
        "message",
        ["nope", json.dumps({"s": "BTCUSDT"}), json.dumps({"c": "1"}), json.dumps({"s": "B", "c": "x"})],
    )
    def test_ignores_a_frame_it_cannot_read(self, message):
        assert binance_stream.parse_tick(message) is None

    def test_reopens_the_socket_when_the_set_changes(self):
        opened: list[str] = []

        def connect(url):
            opened.append(url)
            return FakeSocket([json.dumps({"s": "BTCUSDT", "c": "1"})] * 5)

        async def run():
            stream = binance_stream.BinanceStream(connect=connect, sleep=_no_wait)
            await stream.watch({"BTCUSDT"})
            ticks = stream.ticks()
            await anext(ticks)
            await stream.watch({"BTCUSDT", "ETHUSDT"})
            await anext(ticks)
            await ticks.aclose()

        asyncio.run(run())

        assert "btcusdt@ticker" in opened[0] and "ethusdt" not in opened[0]
        assert "ethusdt@ticker" in opened[-1]
