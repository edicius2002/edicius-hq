import importlib.util
from pathlib import Path

MODULE_PATH = Path(__file__).parents[1] / "x_scraper.py"
SPEC = importlib.util.spec_from_file_location("x_scraper", MODULE_PATH)
x_scraper = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(x_scraper)


def test_extract_tweets_keeps_only_target_authors_and_reply_metadata():
    """Catches accepting third-party replies or losing reply relationships."""
    payload = {
        "data": {
            "user": {
                "result": {
                    "timeline": {
                        "instructions": [
                            {
                                "entries": [
                                    {
                                        "content": {
                                            "itemContent": {
                                                "tweet_results": {
                                                    "result": {
                                                        "rest_id": "101",
                                                        "legacy": {
                                                            "created_at": "Wed Aug 27 12:00:00 +0000 2026",
                                                            "full_text": "respuesta propia",
                                                            "in_reply_to_status_id_str": "99",
                                                            "in_reply_to_screen_name": "other",
                                                            "favorite_count": 3,
                                                            "retweet_count": 2,
                                                            "reply_count": 1,
                                                        },
                                                        "core": {
                                                            "user_results": {
                                                                "result": {
                                                                    "legacy": {
                                                                        "screen_name": "thsottiaux"
                                                                    }
                                                                }
                                                            }
                                                        },
                                                    }
                                                }
                                            }
                                        }
                                    },
                                    {
                                        "content": {
                                            "itemContent": {
                                                "tweet_results": {
                                                    "result": {
                                                        "rest_id": "102",
                                                        "legacy": {
                                                            "full_text": "respuesta de tercero"
                                                        },
                                                        "core": {
                                                            "user_results": {
                                                                "result": {
                                                                    "legacy": {
                                                                        "screen_name": "someone_else"
                                                                    }
                                                                }
                                                            }
                                                        },
                                                    }
                                                }
                                            }
                                        }
                                    },
                                ]
                            }
                        ]
                    }
                }
            }
        }
    }

    assert x_scraper.extract_tweets(payload, "thsottiaux") == [
        {
            "id": "101",
            "date": "Wed Aug 27 12:00:00 +0000 2026",
            "text": "respuesta propia",
            "is_reply": True,
            "in_reply_to_id": "99",
            "in_reply_to_username": "other",
            "like_count": 3,
            "retweet_count": 2,
            "reply_count": 1,
            "url": "https://x.com/thsottiaux/status/101",
        }
    ]
