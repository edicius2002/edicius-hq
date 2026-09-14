"""Render the real airfare page using saved endpoint responses on loopback only."""

import argparse
import gzip
import hashlib
import json
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

CHROMIUM_ARGS = ["--disable-gpu", "--disable-software-rasterizer"]
VIEWPORT = {"width": 1440, "height": 1000}


def directory_sha256(directory: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        digest.update(path.relative_to(directory).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def measurement_metadata(report: dict, build: Path, payload_dir: Path) -> dict:
    """Structured limits shared by the browser launch and its saved report."""
    return {
        "kind": "local_response_replay",
        "source_measurement_commit": report.get("commit"),
        "build_sha256": directory_sha256(build),
        "payload_sha256": directory_sha256(payload_dir),
        "launch": {
            "browser": "chromium",
            "headless": True,
            "chromium_args": CHROMIUM_ARGS,
            "viewport": VIEWPORT,
            "reduced_motion": "reduce",
        },
        "timing_boundaries": {
            "flights_ready_ms": (
                "navigation start through table readiness and two paint frames"
            ),
            "moves_switch_ms": "chart-button click through two paint frames",
            "excluded": [
                "backend computation",
                "production authentication",
                "collector work",
                "WAN transfer",
                "application shell",
            ],
        },
        "interpretation": (
            "Local loopback replay of prepared gzip responses; not WAN or "
            "end-to-end latency."
        ),
    }


def expected_history_snapshots(route: dict) -> int:
    history = route["history"]
    if "count_max" in history:
        return int(history["count_max"])
    return int(history["phases"]["unchanged_repetitions"]["content"]["snapshots"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=3)
    args = parser.parse_args()
    report = json.loads(args.report.read_text())
    payload_dir = Path(report["payload_dir"])
    metadata = measurement_metadata(report, args.build, payload_dir)
    watches = json.loads((payload_dir / "watchlist.json").read_text())
    payloads = {
        p.name: gzip.compress(p.read_bytes()) for p in payload_dir.glob("*.json")
    }

    class Handler(SimpleHTTPRequestHandler):
        extensions_map: ClassVar[dict[str, str]] = {
            **SimpleHTTPRequestHandler.extensions_map,
            ".js": "application/javascript",
            ".css": "text/css",
        }

        def log_message(self, *_args):
            pass

        def do_GET(self):
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            if not parsed.path.startswith("/api/"):
                return super().do_GET()
            if parsed.path == "/api/kv/airfare-routes":
                pair = parse_qs(urlparse(self.headers.get("Referer", "")).query).get(
                    "pair", [""]
                )[0]
                routes = sorted(
                    watches["routes"],
                    key=lambda r: f"{r['origin']}-{r['destination']}" != pair,
                )
                body = gzip.compress(
                    json.dumps(
                        {
                            "key": "airfare-routes",
                            "value": {**watches, "routes": routes},
                        }
                    ).encode()
                )
            elif parsed.path in ("/api/fares/history", "/api/fares/calendar"):
                pair = f"{params['origin'][0]}-{params['destination'][0]}"
                kind = parsed.path.rsplit("/", 1)[-1]
                body = payloads[f"{pair}-{kind}.json"]
            elif parsed.path == "/api/fares/airports":
                body = payloads["airports.json"]
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(Handler, directory=str(args.build))
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    results = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=metadata["launch"]["headless"],
                args=metadata["launch"]["chromium_args"],
            )
            for row in report["routes"]:
                samples = []
                for _ in range(args.samples):
                    context = browser.new_context(
                        viewport=metadata["launch"]["viewport"],
                        reduced_motion=metadata["launch"]["reduced_motion"],
                    )
                    page = context.new_page()
                    errors = []
                    page.on(
                        "pageerror",
                        lambda error, errors=errors: errors.append(str(error)),
                    )
                    page.goto(
                        f"http://127.0.0.1:{server.server_port}/?pair={row['pair']}",
                        wait_until="domcontentloaded",
                    )
                    try:
                        page.locator("table tbody tr").first.wait_for(timeout=15000)
                    except PlaywrightTimeoutError:
                        print(
                            json.dumps(
                                {
                                    "errors": errors,
                                    "body": page.locator("body").inner_text()[:1600],
                                    "requests": page.evaluate(
                                        "window.airfareMeasurement"
                                    ),
                                }
                            ),
                            flush=True,
                        )
                        raise
                    page.wait_for_function(
                        "!document.body.textContent.includes('Loading saved fares')"
                    )
                    page.evaluate(
                        "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"
                    )
                    ready = page.evaluate("performance.now()")
                    count = page.locator("table tbody tr").count()
                    before = page.evaluate("performance.now()")
                    page.get_by_role(
                        "button", name="How the price moved", exact=True
                    ).click()
                    page.evaluate(
                        "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"
                    )
                    after = page.evaluate("performance.now()")
                    metrics = page.evaluate("window.airfareMeasurement")
                    history = [p for p in metrics["parsing"] if p["kind"] == "history"]
                    assert history and history[-1]["pair"] == row["pair"], (
                        "Wrong route measured"
                    )
                    assert history[-1]["count"] == expected_history_snapshots(row), (
                        "Missing snapshots"
                    )
                    assert not errors, errors
                    samples.append(
                        {
                            "flights_ready_ms": round(ready, 2),
                            "moves_switch_ms": round(after - before, 2),
                            "table_rows": count,
                            "errors": errors,
                            **metrics,
                        }
                    )
                    context.close()
                result = {"pair": row["pair"], "samples": samples}
                results.append(result)
                print(json.dumps(result), flush=True)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    report["browser"] = {**metadata, "routes": results}
    args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
