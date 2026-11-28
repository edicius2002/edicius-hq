import asyncio
import base64
from uuid import UUID

import pytest
from cryptography.exceptions import InvalidTag
from psycopg.conninfo import conninfo_to_dict

from app.adapters.binance_stream import parse_tick, stream_url
from app.services.neon_market_live import MarketChannel, direct_connection, run_market_live


def test_trade_feed_uses_executed_price_and_trade_time():
    assert stream_url(["BTCUSDT"], trades=True).endswith("btcusdt@aggTrade")
    assert stream_url(["BTCUSDT"]).endswith("btcusdt@ticker")
    trade = parse_tick('{"data":{"e":"aggTrade","s":"BTCUSDT","p":"99.03","T":1234,"E":1280}}')
    assert trade and trade.time == 1.234 and trade.price == 99.03
    assert trade.change_percent is None
    assert parse_tick('{"e":"aggTrade","s":"BTCUSDT","p":"NaN"}') is None


def test_notifications_are_bound_to_owner_channel_and_direction():
    key = base64.b64encode(bytes(range(32))).decode()
    owner = MarketChannel(UUID(int=1), key)
    other = MarketChannel(UUID(int=2), key)
    message = {"ticks": [{"symbol": "BTCUSDT", "price": 99.03}]}
    packet = owner.seal(owner.data, message)
    assert owner.open(owner.data, packet) == message
    for wrong_channel in (owner.control, other.data):
        with pytest.raises(InvalidTag):
            other.open(wrong_channel, packet)


def test_listen_uses_a_direct_connection_and_preserves_database_settings():
    params = conninfo_to_dict(
        direct_connection(
            "postgres://tester@ep-test-pooler.us-east-1.aws.neon.tech/quotes?sslmode=verify-full"
        )
    )
    assert params["host"] == "ep-test.us-east-1.aws.neon.tech"
    assert params["dbname"] == "quotes"
    assert params["sslmode"] == "verify-full"


def test_bad_live_key_only_disables_the_optional_relay(caplog):
    asyncio.run(run_market_live("unused", UUID(int=1), "invalid"))
    assert "market live disabled" in caplog.text
