#!/usr/bin/env python3
"""Capture an X user's Posts & replies GraphQL responses into resumable JSONL."""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import Response, sync_playwright
from x_scraper import extract_tweets


def default_profile_dir() -> Path:
    return Path(
        os.environ.get("X_SCRAPER_PROFILE", "~/.local/share/x-scraper/profile")
    ).expanduser()


def output_path(username: str, requested: str | None) -> Path:
    if requested:
        return Path(requested).expanduser()
    base = Path(
        os.environ.get("X_SCRAPER_OUTPUT", "~/.local/share/x-scraper/output")
    ).expanduser()
    return base / f"{username.lstrip('@')}.jsonl"


def existing_ids(path: Path) -> set[str]:
    if not path.exists():
        return set()
    ids: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            tweet_id = json.loads(line).get("id")
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"JSONL corrupto en {path}: {exc}") from exc
        if tweet_id:
            ids.add(str(tweet_id))
    return ids


def has_x_session(context: Any) -> bool:
    return any(cookie["name"] == "auth_token" for cookie in context.cookies())


# The operation that serves each profile tab. `UserRepliesTimeline` is what
# /with_replies actually calls — measured against the live site, where the
# guessed `UserTweetsAndReplies` never fired once. Kept as a tuple because the
# name is X's to change and this is the one line that has to move when it does.
TIMELINE_OPERATIONS = (
    "UserRepliesTimeline",
    "UserTweetsAndReplies",
    "UserTweets",
    "UserMedia",
)


def is_timeline_response(response: Response) -> bool:
    return response.request.resource_type in {"xhr", "fetch"} and any(
        operation in response.url for operation in TIMELINE_OPERATIONS
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("username", help="Usuario X, con o sin @")
    parser.add_argument("--output", help="Archivo JSONL (por defecto, fuera del repo)")
    parser.add_argument("--max-scrolls", type=int, default=80)
    args = parser.parse_args()
    username = args.username.lstrip("@")
    profile = default_profile_dir()
    destination = output_path(username, args.output)
    known_ids = existing_ids(destination)
    captured: dict[str, dict[str, Any]] = {}

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile),
            headless=True,
            viewport={"width": 1365, "height": 900},
            # Drops `navigator.webdriver`, the cheapest automation tell there
            # is. It does not make the session undetectable; it keeps an
            # already-issued session from being flagged on a signal that costs
            # one flag to remove.
            args=["--disable-blink-features=AutomationControlled"],
        )
        if not has_x_session(context):
            context.close()
            print(
                "No hay sesión X en el perfil. Importa una con import_session.py "
                "(recomendado) o inicia sesión con login.py.",
                file=sys.stderr,
            )
            return 2

        def on_response(response: Response) -> None:
            if not is_timeline_response(response):
                return
            try:
                payload = response.json()
            except Exception as exc:  # noqa: BLE001 - X can return an HTML challenge with HTTP 200.
                print(
                    f"Respuesta GraphQL no JSON ({response.url}): {exc}",
                    file=sys.stderr,
                )
                return
            for tweet in extract_tweets(payload, username):
                if tweet["id"] not in known_ids:
                    captured[tweet["id"]] = tweet

        page = context.pages[0] if context.pages else context.new_page()
        page.on("response", on_response)
        page.goto(
            f"https://x.com/{username}/with_replies",
            wait_until="domcontentloaded",
            timeout=60_000,
        )
        if "/i/flow/login" in page.url:
            context.close()
            print(
                "La sesión X expiró. Ejecuta login.py y vuelve a intentarlo.",
                file=sys.stderr,
            )
            return 2
        page.wait_for_timeout(3_000)

        for _ in range(args.max_scrolls):
            page.mouse.wheel(0, random.randint(700, 1_300))
            page.wait_for_timeout(random.randint(1_700, 3_900))
            if known_ids and captured:
                # The first page is newest-first: once it yields no more unseen ids, resume is done.
                current_count = len(captured)
                page.mouse.wheel(0, random.randint(500, 900))
                page.wait_for_timeout(random.randint(1_200, 2_000))
                if len(captured) == current_count:
                    break
            time.sleep(random.uniform(0.2, 0.7))
        context.close()

    if not captured:
        print(
            "No se capturó ningún tweet. No se guardó salida: el endpoint cambió, hubo challenge o la sesión no es válida.",
            file=sys.stderr,
        )
        return 3

    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("a", encoding="utf-8") as stream:
        for tweet in captured.values():
            stream.write(json.dumps(tweet, ensure_ascii=False) + "\n")
    print(f"Guardados {len(captured)} tweets nuevos en {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
