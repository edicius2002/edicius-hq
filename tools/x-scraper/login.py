#!/usr/bin/env python3
"""Open a persistent, headed Chromium session for a human X login."""

from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import sync_playwright


def profile_dir() -> Path:
    return Path(
        os.environ.get("X_SCRAPER_PROFILE", "~/.local/share/x-scraper/profile")
    ).expanduser()


def main() -> None:
    profile = profile_dir()
    profile.mkdir(parents=True, exist_ok=True)
    print("Abriendo Chromium con perfil persistente fuera del repositorio:")
    print(profile)
    print("Inicia sesión manualmente en X. No pegues credenciales en esta terminal.")
    print(
        "Cuando veas tu sesión iniciada, cierra la ventana de Chromium para guardar la sesión."
    )
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile), headless=False, viewport={"width": 1365, "height": 900}
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://x.com/home", wait_until="domcontentloaded")
        page.wait_for_event("close")
        context.close()


if __name__ == "__main__":
    main()
