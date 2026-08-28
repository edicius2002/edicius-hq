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

from x_scraper import CursorTracker, bottom_cursors, extract_tweets, is_timeline_url


def default_profile_dir() -> Path:
    return Path(
        os.environ.get("X_SCRAPER_PROFILE", "~/.local/share/x-scraper/profile")
    ).expanduser()


def output_path(username: str, requested: str | None) -> Path:
    if requested:
        return Path(requested).expanduser()
    override = os.environ.get("X_SCRAPER_OUTPUT")
    if override:
        return Path(override).expanduser() / f"{username.lstrip('@')}.jsonl"
    # Config resolves relative LOCAL_DATA_DIR from services/api; this script does not.
    return Path(__file__).resolve().parents[2] / "services" / "api" / ".local-data" / "tweets" / f"{username.lstrip('@')}.jsonl"


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


def append_tweets(path: Path, tweets: list[dict[str, Any]]) -> None:
    """Persist each received GraphQL batch before the next human-paced scroll."""
    if not tweets:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        for tweet in tweets:
            stream.write(json.dumps(tweet, ensure_ascii=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def has_x_session(context: Any) -> bool:
    return any(cookie["name"] == "auth_token" for cookie in context.cookies())


def is_timeline_response(response: Response) -> bool:
    # The operation names live in `x_scraper` because the watcher matches on
    # them too, and two copies of a list only X can change is how the watcher
    # came to listen for one tab and miss the other for months.
    return response.request.resource_type in {"xhr", "fetch"} and is_timeline_url(response.url)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("username", help="Usuario X, con o sin @")
    parser.add_argument("--output", help="Archivo JSONL (por defecto, fuera del repo)")
    parser.add_argument("--max-scrolls", type=int, default=80)
    parser.add_argument(
        "--full",
        action="store_true",
        help="Ignora IDs ya guardados y baja hasta el cursor terminal o --max-scrolls.",
    )
    parser.add_argument(
        "--patience",
        type=int,
        default=4,
        help="Ventanas inactivas consecutivas antes de cerrar una corrida incremental.",
    )
    args = parser.parse_args()
    if args.max_scrolls < 1 or args.patience < 1:
        parser.error("--max-scrolls y --patience deben ser positivos")

    username = args.username.lstrip("@")
    profile = default_profile_dir()
    destination = output_path(username, args.output)
    known_ids = existing_ids(destination)
    seen_ids: set[str] = set()
    cursor_tracker = CursorTracker()
    new_count = 0
    known_count = 0
    response_count = 0
    timeline_exhausted = False
    stop_reason = "límite de scrolls alcanzado"

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile),
            headless=True,
            viewport={"width": 1365, "height": 900},
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
            nonlocal known_count, new_count, response_count, timeline_exhausted
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

            response_count += 1
            tweets = extract_tweets(payload, username)
            new_tweets: list[dict[str, Any]] = []
            for tweet in tweets:
                tweet_id = tweet["id"]
                seen_ids.add(tweet_id)
                if tweet_id in known_ids:
                    known_count += 1
                else:
                    new_tweets.append(tweet)
                    known_ids.add(tweet_id)
            append_tweets(destination, new_tweets)
            new_count += len(new_tweets)
            if cursor_tracker.observe(bottom_cursors(payload)):
                timeline_exhausted = True

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

        idle_windows = 0
        for scroll_number in range(1, args.max_scrolls + 1):
            before_seen = len(seen_ids)
            before_responses = response_count
            before_height = page.evaluate("document.documentElement.scrollHeight")
            page.mouse.wheel(0, random.randint(700, 1_300))
            page.wait_for_timeout(random.randint(1_700, 3_900))
            after_height = page.evaluate("document.documentElement.scrollHeight")

            if timeline_exhausted:
                stop_reason = "cursor inferior repetido o vacío: timeline agotado"
                break

            made_progress = (
                len(seen_ids) > before_seen
                or response_count > before_responses
                or after_height > before_height
            )
            idle_windows = 0 if made_progress else idle_windows + 1
            if not args.full and idle_windows >= args.patience:
                stop_reason = (
                    f"incremental inactivo durante {idle_windows} ventanas "
                    f"después de encontrar {known_count} IDs ya guardados"
                )
                break
            if args.full and idle_windows >= args.patience:
                print(
                    f"Carga lenta: {idle_windows} ventanas sin respuesta; "
                    "--full continúa esperando el cursor.",
                    flush=True,
                )
                idle_windows = 0
            if scroll_number == 1 or scroll_number % 5 == 0:
                print(
                    f"Progreso: scroll {scroll_number}/{args.max_scrolls}; "
                    f"nuevos {new_count}; vistos {len(seen_ids)}; "
                    f"guardados {known_count}.",
                    flush=True,
                )
            time.sleep(random.uniform(0.2, 0.7))
        context.close()

    if not seen_ids:
        print(
            "No se capturó ningún tweet. No se guardó salida: el endpoint cambió, "
            "hubo challenge o la sesión no es válida.",
            file=sys.stderr,
        )
        return 3

    print(
        f"Finalizado: {stop_reason}. Nuevos {new_count}; vistos {len(seen_ids)}; "
        f"ya guardados {known_count}; salida {destination}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
