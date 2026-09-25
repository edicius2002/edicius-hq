"""A board the parser refuses is kept on disk, so the refusal can be studied."""

import asyncio
import json

import httpx
import pytest

from app.adapters.fares import drift_samples, google_flights
from app.adapters.fares.models import FareError, FareQuery

QUERY = FareQuery("SCL", "ARI", "2027-04-18", None, "USD")
# One itinerary in the "all flights" block with none of the shape `_offer`
# reads: exactly the "returned 1 itineraries and none could be read" refusal.
UNREADABLE = [None, None, None, [[["not", "an", "itinerary"]]]]
NOTHING_FOUND = [None, None, None, [None]]


def search(monkeypatch, tmp_path, payload):
    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(google_flights, "extract_payload", lambda _html: payload)

    async def run():
        transport = httpx.MockTransport(lambda _request: httpx.Response(200, text="<html/>"))
        async with httpx.AsyncClient(transport=transport) as client:
            return await google_flights.fetch_search(client, QUERY)

    return asyncio.run(run())


def samples(tmp_path):
    return sorted((tmp_path / drift_samples.DIRECTORY).glob("*.json"))


def test_a_refused_board_is_kept_and_the_refusal_still_raised(monkeypatch, tmp_path):
    with pytest.raises(FareError) as refused:
        search(monkeypatch, tmp_path, UNREADABLE)

    assert refused.value.code == "parse-drift"
    [kept] = samples(tmp_path)
    assert kept.name.endswith("-SCL-ARI-2027-04-18.json")
    assert json.loads(kept.read_text(encoding="utf-8")) == UNREADABLE


def test_a_board_with_no_flights_is_an_answer_not_a_sample(monkeypatch, tmp_path):
    with pytest.raises(FareError) as empty:
        search(monkeypatch, tmp_path, NOTHING_FOUND)

    assert empty.value.code == "no-offers"
    assert samples(tmp_path) == []


def test_only_the_latest_samples_are_kept(tmp_path):
    for second in range(drift_samples.KEEP + 5):
        drift_samples.keep(QUERY, UNREADABLE, root=tmp_path, stamp=f"20260925T2000{second:02d}Z")

    kept = samples(tmp_path)
    assert len(kept) == drift_samples.KEEP
    assert kept[0].name.startswith("20260925T200005Z")


def test_a_sample_that_cannot_be_written_never_hides_the_refusal(monkeypatch, tmp_path):
    blocked = tmp_path / "blocked"
    blocked.write_text("a file where the directory should be", encoding="utf-8")
    monkeypatch.setattr(drift_samples, "DIRECTORY", "blocked/fares-drift")

    with pytest.raises(FareError) as refused:
        search(monkeypatch, tmp_path, UNREADABLE)

    assert refused.value.code == "parse-drift"
