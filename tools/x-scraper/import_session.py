#!/usr/bin/env python3
"""
Seed the persistent profile with an X session captured in a normal browser.

Logging in *through* Playwright is the single most defended action on X: a
fresh automated profile is an unknown device, and the attempt is what trips
"We've temporarily limited your login". This path never logs in. The human
logs in wherever they normally do, and only the resulting cookies are moved
across, so X sees a session it already issued to a real browser.

The two cookies are read from a file rather than argv, so they never land in
shell history or a process listing, and they are never printed back.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright

REQUIRED = ("auth_token", "ct0")


def profile_dir() -> Path:
    return Path(
        os.environ.get("X_SCRAPER_PROFILE", "~/.local/share/x-scraper/profile")
    ).expanduser()


def cookies_path(requested: str | None) -> Path:
    if requested:
        return Path(requested).expanduser()
    return Path(
        os.environ.get("X_SCRAPER_COOKIES", "~/.local/share/x-scraper/cookies.json")
    ).expanduser()


def read_netscape(text: str) -> dict[str, tuple[str, int]]:
    """
    The `cookies.txt` an exporter extension writes: tab-separated, one cookie
    per line, comments on `#`. Column 4 is the expiry as a Unix timestamp,
    which is the only place the real lifetime is stated — X does not publish
    it, so it is read here rather than assumed.
    """
    found: dict[str, tuple[str, int]] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, _flag, _path, _secure, expires, name, value = parts[:7]
        if name not in REQUIRED or "x.com" not in domain:
            continue
        try:
            expiry = int(float(expires))
        except ValueError:
            expiry = 0
        found[name] = (value, expiry)
    return found


def read_cookies(path: Path) -> dict[str, tuple[str, int]]:
    if not path.exists():
        raise SystemExit(
            f"No encuentro {path}.\n"
            "Exporta un cookies.txt de x.com, o crea un JSON con: "
            '{"auth_token": "...", "ct0": "..."}'
        )
    text = path.read_text(encoding="utf-8")

    values: dict[str, tuple[str, int]] = {}
    if path.suffix.lower() == ".txt" or "\t" in text:
        values = read_netscape(text)
    else:
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"{path} no es JSON ni cookies.txt valido: {exc}") from exc
        if not isinstance(raw, dict):
            raise SystemExit(f"{path} debe contener un objeto JSON.")
        for name in REQUIRED:
            value = raw.get(name)
            if isinstance(value, str) and value.strip():
                values[name] = (value.strip(), 0)

    missing = [name for name in REQUIRED if name not in values]
    if missing:
        raise SystemExit(
            f"Faltan cookies en {path}: {', '.join(missing)}. "
            "Exporta estando conectado en x.com."
        )
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cookies", help="Archivo JSON con auth_token y ct0")
    parser.add_argument(
        "--delete",
        action="store_true",
        help="Borra el archivo de cookies tras importarlo con exito",
    )
    args = parser.parse_args()

    source = cookies_path(args.cookies)
    values = read_cookies(source)
    profile = profile_dir()
    profile.mkdir(parents=True, exist_ok=True)

    # `.x.com` so the cookies ride on every subdomain the app talks to, and
    # `secure` because X refuses to send them over anything else.
    payload = []
    for name, (value, expiry) in values.items():
        cookie = {
            "name": name,
            "value": value,
            "domain": ".x.com",
            "path": "/",
            "secure": True,
            "httpOnly": name == "auth_token",
            "sameSite": "Lax",
        }
        # Carried across rather than defaulted, so the profile expires when X
        # says it does instead of at the end of the session.
        if expiry > 0:
            cookie["expires"] = expiry
        payload.append(cookie)

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile),
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context.add_cookies(payload)
        stored = {cookie["name"] for cookie in context.cookies()}
        context.close()

    missing = [name for name in REQUIRED if name not in stored]
    if missing:
        print(f"No se guardaron las cookies: {', '.join(missing)}", file=sys.stderr)
        return 1

    if args.delete:
        source.unlink()
        print(f"Cookies importadas y {source} borrado.")
    else:
        print(f"Cookies importadas. Borra {source} ahora: contiene tu sesion en claro.")
    print(f"Perfil: {profile}")

    now = time.time()
    for name, (_value, expiry) in sorted(values.items()):
        if expiry <= 0:
            print(f"  {name}: sin fecha de expiracion en el archivo")
            continue
        days = (expiry - now) / 86_400
        when = datetime.fromtimestamp(expiry).strftime("%Y-%m-%d %H:%M")
        state = "CADUCADA" if days <= 0 else f"faltan {days:.0f} dia(s)"
        print(f"  {name}: expira {when} ({state})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
