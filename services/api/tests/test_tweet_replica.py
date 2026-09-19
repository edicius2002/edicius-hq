import json
import os
from pathlib import Path
from unittest.mock import Mock
from uuid import UUID

import pytest

from app.services.collector_cloud import CollectorCloudUnavailable
from app.services.tweet_replica import TweetReplica

TWEET_1 = {
    "id": "one",
    "date": "2026-09-18T10:00:00+00:00",
    "text": "private post body",
    "is_reply": False,
    "url": "https://x.com/thsottiaux/status/one",
}
TWEET_2 = {**TWEET_1, "id": "two", "date": "2026-09-18T11:00:00+00:00"}


def write_jsonl(path: Path, rows: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    return path


def cloud() -> Mock:
    result = Mock()
    result.owner_id = UUID("11111111-1111-1111-1111-111111111111")
    return result


def test_cursor_advances_only_after_upsert(tmp_path):
    archive = write_jsonl(tmp_path / "thsottiaux.jsonl", [TWEET_1, TWEET_2])
    remote = cloud()
    remote.upsert_tweets.side_effect = CollectorCloudUnavailable("offline")
    replica = TweetReplica(archive, remote)

    with pytest.raises(CollectorCloudUnavailable):
        replica.replay("thsottiaux")

    assert not replica.cursor_path.exists()


def test_retry_replays_the_unacknowledged_batch_without_duplicate_local_rows(tmp_path):
    archive = write_jsonl(tmp_path / "thsottiaux.jsonl", [TWEET_1])
    remote = cloud()
    remote.upsert_tweets.side_effect = [CollectorCloudUnavailable("offline"), 1]
    replica = TweetReplica(archive, remote)

    with pytest.raises(CollectorCloudUnavailable):
        replica.append_and_sync("thsottiaux", [TWEET_1, TWEET_1])
    assert [json.loads(line) for line in archive.read_text().splitlines()] == [TWEET_1]

    assert replica.replay("thsottiaux") == 1
    assert remote.upsert_tweets.call_count == 2
    assert remote.upsert_tweets.call_args.args[0][0]["post_id"] == "one"


def test_replay_leaves_a_partial_final_line_for_a_later_complete_write(tmp_path):
    archive = write_jsonl(tmp_path / "thsottiaux.jsonl", [TWEET_1])
    with archive.open("a", encoding="utf-8") as stream:
        stream.write('{"id":"partial"')
    remote = cloud()
    replica = TweetReplica(archive, remote)

    assert replica.replay("thsottiaux") == 1
    assert remote.upsert_tweets.call_count == 1

    with archive.open("a", encoding="utf-8") as stream:
        stream.write(
            ',"date":"2026-09-18T12:00:00+00:00","text":"later","url":"https://x.com/a"}\n'
        )
    assert replica.replay("thsottiaux") == 1


def test_replacing_archive_replays_from_zero_instead_of_trusting_old_offset(tmp_path):
    archive = write_jsonl(tmp_path / "thsottiaux.jsonl", [TWEET_1])
    remote = cloud()
    replica = TweetReplica(archive, remote)
    assert replica.replay("thsottiaux") == 1

    replacement = write_jsonl(tmp_path / "replacement.jsonl", [TWEET_2])
    os.replace(replacement, archive)

    assert replica.replay("thsottiaux") == 1
    assert remote.upsert_tweets.call_args.args[0][0]["post_id"] == "two"


def test_replay_uses_bounded_batches_and_acks_each_batch(tmp_path):
    rows = [{**TWEET_1, "id": str(index)} for index in range(5)]
    archive = write_jsonl(tmp_path / "thsottiaux.jsonl", rows)
    remote = cloud()
    replica = TweetReplica(archive, remote, batch_size=2)

    assert replica.replay("thsottiaux") == 5
    assert [len(call.args[0]) for call in remote.upsert_tweets.call_args_list] == [2, 2, 1]
    assert json.loads(replica.cursor_path.read_text())["offset"] == archive.stat().st_size


def test_replay_failure_never_includes_tweet_payload_text(tmp_path):
    archive = write_jsonl(tmp_path / "thsottiaux.jsonl", [TWEET_1])
    remote = cloud()
    remote.upsert_tweets.side_effect = CollectorCloudUnavailable("private post body")
    replica = TweetReplica(archive, remote)

    with pytest.raises(CollectorCloudUnavailable) as raised:
        replica.replay("thsottiaux")

    assert "private post body" not in str(raised.value)


def test_malformed_completed_line_does_not_ack_preceding_unreplicated_rows(tmp_path):
    archive = write_jsonl(tmp_path / "thsottiaux.jsonl", [TWEET_1])
    with archive.open("a", encoding="utf-8") as stream:
        stream.write("not-json\n")
        stream.write(json.dumps(TWEET_2) + "\n")
    remote = cloud()
    remote.upsert_tweets.side_effect = CollectorCloudUnavailable("offline")
    replica = TweetReplica(archive, remote, batch_size=2)

    with pytest.raises(CollectorCloudUnavailable):
        replica.replay("thsottiaux")

    assert not replica.cursor_path.exists()
