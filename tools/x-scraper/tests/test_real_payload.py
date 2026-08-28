import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("x_scraper", ROOT / "x_scraper.py")
x_scraper = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(x_scraper)


def test_real_user_replies_timeline_fixture_uses_core_handle_and_bottom_cursor():
    """Catches X moving the author handle or changing the replies timeline shape."""
    fixture = Path(__file__).parent / "fixtures" / "user_replies_timeline.json"
    payload = json.loads(fixture.read_text(encoding="utf-8"))

    assert [
        tweet["id"] for tweet in x_scraper.extract_tweets(payload, "thsottiaux")
    ] == ["9001", "9002"]
    assert x_scraper.bottom_cursors(payload) == ["CURSOR_ANONIMIZADO"]


def test_cursor_tracker_only_exhausts_after_a_repeated_bottom_cursor():
    """Catches treating a temporarily idle viewport as the end of the timeline."""
    tracker = x_scraper.CursorTracker()

    assert not tracker.observe(["first"])
    assert not tracker.observe(["second"])


def test_note_tweet_text_beats_legacy_excerpt():
    fixture = Path(__file__).parent / 'fixtures' / 'user_replies_timeline.json'
    payload = json.loads(fixture.read_text(encoding='utf-8'))
    assert x_scraper.extract_tweets(payload, 'thsottiaux')[0]['text'] == 'complete anonymized long text'
