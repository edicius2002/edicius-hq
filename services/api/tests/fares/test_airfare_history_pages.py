import asyncio
import copy
import json
from pathlib import Path

import pytest

from app.services.airfare_history_pages import assemble_history
from app.services.airfare_supabase import (
    AirfareHistoryRevisionChanged,
    AirfareRemoteRejected,
    AirfareRemoteUnavailable,
)

FIXTURE_PATH = Path(__file__).resolve().parents[4] / "fixtures/airfare-history-pagination/v1.json"


def fixture():
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


class ScriptedRpc:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = []

    async def __call__(self, name, params):
        self.calls.append((name, dict(params)))
        reply = next(self.replies)
        if isinstance(reply, Exception):
            raise reply
        return copy.deepcopy(reply)


def replies(data):
    return [
        copy.deepcopy(data["meta"]),
        *copy.deepcopy(data["snapshotPages"]),
        *copy.deepcopy(data["baselinePages"]),
        copy.deepcopy(data["meta"]),
    ]


def run(rpc, data, *, check_cancelled=lambda: None, sleep=asyncio.sleep):
    return asyncio.run(
        assemble_history(rpc, data["filters"], check_cancelled=check_cancelled, sleep=sleep)
    )


def test_complete_history_preserves_shared_payloads_ties_and_bigints():
    data = fixture()
    rpc = ScriptedRpc(replies(data))
    assert run(rpc, data) == data["expected"]
    assert [name for name, _ in rpc.calls] == [
        "read_airfare_history_meta",
        "read_airfare_history_page",
        "read_airfare_history_page",
        "read_airfare_history_page",
        "read_airfare_history_meta",
    ]
    assert rpc.calls[-1][1]["p_expected_revision"] == data["meta"]["revision"]
    assert rpc.calls[2][1]["p_cursor"] == data["snapshotPages"][0]["nextCursor"]


@pytest.mark.parametrize(
    ("response", "path", "bad"),
    [
        (0, ["revision"], 9007199254740993),
        (0, ["revision"], "9223372036854775808"),
        (0, ["counts", "snapshots"], "04"),
        (0, ["counts", "snapshots"], "9007199254740993"),
        (0, ["counts", "snapshots"], "3"),
        (0, ["counts", "baseline"], True),
        (0, ["origin"], "XXX"),
        (0, ["protocolVersion"], True),
        (1, ["queryKey"], "wrong"),
        (1, ["revision"], "1"),
        (1, ["dataset"], "baseline"),
        (1, ["items"], []),
        (1, ["items", 0, "order", 1], 9007199254740992),
        (1, ["items", 0, "order", 1], "9223372036854775808"),
        (1, ["items", 0, "order", 2], "0" * 64),
        (1, ["items", 0, "payload"], []),
        (1, ["nextCursor", "after", 1], "9007199254740993"),
        (1, ["nextCursor", "dataset"], "baseline"),
        (1, ["nextCursor"], None),
        (2, ["items", 0, "order", 1], "1"),
        (2, ["items", 0, "recordId"], "1" * 64),
        (2, ["nextCursor"], {}),
        (3, ["items", 0, "order", 0], "2026-02-30"),
        (4, ["health", "checks"], 99),
        (4, ["counts", "snapshots"], "5"),
    ],
)
def test_malformed_or_incomplete_response_never_publishes(response, path, bad):
    data = fixture()
    wire = replies(data)
    target = wire[response]
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = bad
    with pytest.raises(AirfareRemoteRejected):
        run(ScriptedRpc(wire), data)


def test_duplicate_identity_is_rejected_even_with_plausible_cursor():
    data = fixture()
    wire = replies(data)
    wire[2]["items"][0] = copy.deepcopy(wire[1]["items"][0])
    with pytest.raises(AirfareRemoteRejected):
        run(ScriptedRpc(wire), data)


def test_final_revision_conflict_discards_every_accumulated_page():
    data = fixture()
    wire = replies(data)
    wire[-1] = AirfareHistoryRevisionChanged("changed")
    rpc = ScriptedRpc(wire + replies(data))
    delays = []

    async def sleep(seconds):
        delays.append(seconds)

    assert run(rpc, data, sleep=sleep) == data["expected"]
    assert delays == [0.1]
    assert len(rpc.calls) == 10


def test_revision_churn_stops_after_three_attempts():
    data = fixture()
    rpc = ScriptedRpc([AirfareHistoryRevisionChanged("changed")] * 4)
    delays = []

    async def sleep(seconds):
        delays.append(seconds)

    with pytest.raises(AirfareRemoteUnavailable, match="changed repeatedly"):
        run(rpc, data, sleep=sleep)
    assert len(rpc.calls) == 3
    assert delays == [0.1, 0.25]


@pytest.mark.parametrize(
    "error", [AirfareRemoteUnavailable("network"), AirfareRemoteRejected("denied")]
)
def test_late_nonrevision_failure_is_not_retried_or_returned_as_partial(error):
    data = fixture()
    wire = replies(data)
    wire[2] = error
    rpc = ScriptedRpc(wire)
    with pytest.raises(type(error)):
        run(rpc, data)
    assert len(rpc.calls) == 3


def test_zero_counts_skip_pages_but_not_final_validation():
    data = fixture()
    data["meta"]["counts"] = {"snapshots": "0", "baseline": "0"}
    data["expected"].update(snapshots=[], baseline=[])
    rpc = ScriptedRpc([data["meta"], data["meta"]])
    assert run(rpc, data) == data["expected"]
    assert len(rpc.calls) == 2


def test_legacy_airports_may_omit_optional_name_city_country():
    data = fixture()
    for document in (data["meta"], data["expected"]):
        for airport in document["airports"]:
            for key in ("name", "city", "country"):
                airport.pop(key)
    assert run(ScriptedRpc(replies(data)), data) == data["expected"]


def test_oversized_health_integer_is_protocol_rejection_not_overflow():
    data = fixture()
    data["meta"]["health"]["checks"] = 10**400
    with pytest.raises(AirfareRemoteRejected):
        run(ScriptedRpc(replies(data)), data)


@pytest.mark.parametrize("cancel_after", [0, 1, 2, 4, 5])
def test_cancellation_before_fetch_between_pages_and_before_publication(cancel_after):
    data = fixture()
    rpc = ScriptedRpc(replies(data))

    def check():
        if len(rpc.calls) >= cancel_after:
            raise AirfareRemoteUnavailable("cancelled")

    with pytest.raises(AirfareRemoteUnavailable, match="cancelled"):
        run(rpc, data, check_cancelled=check)
    assert len(rpc.calls) == cancel_after


def test_cancellation_during_backoff_prevents_restart():
    data = fixture()
    rpc = ScriptedRpc([AirfareHistoryRevisionChanged("changed")])
    cancelled = False

    def check():
        if cancelled:
            raise AirfareRemoteUnavailable("cancelled")

    async def sleep(seconds):
        nonlocal cancelled
        cancelled = True

    with pytest.raises(AirfareRemoteUnavailable, match="cancelled"):
        run(rpc, data, check_cancelled=check, sleep=sleep)
    assert len(rpc.calls) == 1
