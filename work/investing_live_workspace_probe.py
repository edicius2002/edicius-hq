"""Drive the real Investing page with a test holding, saved history and the live Pi feed."""

import argparse
import json
import statistics
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright


def distribution(values):
    if len(values) < 2:
        return None
    return {
        "p50": round(statistics.median(values), 1),
        "p95": round(statistics.quantiles(values, n=20, method="inclusive")[18], 1),
    }


def saved_data(route):
    url = urlsplit(route.request.url)
    query = parse_qs(url.query)
    table = url.path.rsplit("/", 1)[-1]
    now = datetime.now(UTC)
    data = []
    if table == "app_documents":
        key = query["document_key"][0].removeprefix("eq.")
        documents = {
            "watchlist": {"entries": [{"symbol": "BTCUSDT", "name": "Bitcoin"}]},
            "portfolio": {"positions": [{"symbol": "BTCUSDT", "quantity": 1, "averageCost": 100}]},
        }
        data = [
            {
                "document_key": key,
                "payload": documents.get(key, {}),
                "revision": 1,
                "updated_at": now.isoformat(),
            }
        ]
    elif table == "market_quotes":
        data = [
            {
                "symbol": "BTCUSDT",
                "provider": "binance",
                "market_time": 1,
                "payload": {
                    "price": 100,
                    "name": "Bitcoin",
                    "currency": "USDT",
                    "previousClose": 100,
                },
            }
        ]
    elif table == "market_bars" and "timeframe" in query:
        symbol = query["symbol"][0].removeprefix("eq.")
        frame = query["timeframe"][0].removeprefix("eq.")
        extended = query["extended"][0] == "eq.true"
        history = [
            {
                "time": int(now.timestamp() // 60) * 60 - (1500 - i) * 60,
                "open": 100,
                "low": 99,
                "high": 101,
                "close": 100,
                "volume": 1,
            }
            for i in range(1500)
        ]
        data = [
            {
                "fetched_at": (now - timedelta(minutes=1)).isoformat(),
                "expires_at": (now + timedelta(minutes=5)).isoformat(),
                "provider": "fixture",
                "payload": {
                    "symbol": symbol,
                    "timeframe": frame,
                    "provider": "fixture",
                    "extended": extended,
                    "stale": False,
                    "hasSession": symbol != "BTCUSDT",
                    "bars": history,
                },
            }
        ]
    route.fulfill(json=data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--chrome")
    parser.add_argument("--mobile", action="store_true")
    parser.add_argument("--duration", type=int, default=45)
    parser.add_argument("--pi-minus-browser-ms", type=float, required=True)
    args = parser.parse_args()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.chrome)
        viewport = {"width": 390, "height": 844} if args.mobile else {"width": 1440, "height": 900}
        page = browser.new_page(
            locale="en-US", viewport=viewport, is_mobile=args.mobile, has_touch=args.mobile
        )
        page.on("pageerror", lambda error: print("Browser error:", str(error)[:160], flush=True))
        page.route("https://fixture.neon.tech/**", saved_data)
        page.add_init_script("""window.latestTrade = null; window.joins = 0;
          window.EventSource = class extends EventSource {
            constructor(...args) {
              super(...args);
              this.addEventListener('ready', () => window.joins++);
              this.addEventListener('ticks', e => {
                for (const tick of JSON.parse(e.data)) if (tick.symbol === 'BTCUSDT') window.latestTrade = tick;
              });
            }
          };""")
        page.route(
            "**/api/auth/**",
            lambda route: route.fulfill(content_type="application/json", body="null"),
        )
        page.goto(args.url.rstrip("/") + "/?workspace=1")
        page.get_by_role("list", name="Watchlist").get_by_role("button").first.click()
        page.get_by_role("button", name="1m", exact=True).click()
        page.wait_for_selector('[aria-label="BTCUSDT chart"] canvas')
        page.get_by_role("button", name="Show data table").click()
        page.evaluate(r"""() => {
          window.visibleSamples = [];
          let previous = '';
          const poll = () => {
            const panel = document.querySelector('[aria-label="BTCUSDT chart"]');
            const row = document.querySelector('ul[aria-label="Watchlist"] li');
            const holding = document.querySelector('ul[aria-label="Positions"] li');
            const header = panel?.querySelector('h2 + span')?.textContent ?? '';
            const value = header.match(/[\d,.]+/)?.[0];
            const price = Number(value?.replaceAll(',', ''));
            const tick = window.latestTrade?.price === price ? window.latestTrade : null;
            if (window.latestTrade && value && price !== 100 && value !== previous) {
              previous = value;
              const cells = panel.querySelector('tbody tr:last-child')?.cells;
              window.visibleSamples.push({at: Date.now(), pi:tick?.receivedAt ?? null, exchange:tick ? tick.time*1000 : null, list: row?.textContent.includes(value),
                position: holding?.textContent.includes(value), candle: Number(cells?.[4]?.textContent) === Number(value.replaceAll(',', ''))});
            }
            requestAnimationFrame(poll);
          };
          poll();
        }""")
        page.wait_for_function("window.visibleSamples.length > 0", timeout=45_000)
        page.evaluate(
            "window.visibleSamples = []; window.measureStart = performance.now(); window.joins = 0"
        )
        page.wait_for_timeout(args.duration * 1000)
        rows = page.evaluate("window.visibleSamples")
        elapsed = page.evaluate("(performance.now() - window.measureStart) / 1000")
        joins = page.evaluate("window.joins")
        browser.close()
    timed = [r for r in rows if r["pi"] is not None]
    print(
        json.dumps(
            {
                "seconds": elapsed,
                "changes": len(rows),
                "timed_trades": len(timed),
                "rejoins": joins,
                **{
                    k: sum(row.get(k) is True for row in rows)
                    for k in ("list", "position", "candle")
                },
                "pi_to_frame_ms": distribution(
                    [r["at"] + args.pi_minus_browser_ms - r["pi"] for r in timed]
                ),
                "exchange_to_frame_ms": distribution(
                    [r["at"] + args.pi_minus_browser_ms - r["exchange"] for r in timed]
                ),
                "visible_gap_ms": distribution([b["at"] - a["at"] for a, b in zip(rows, rows[1:])]),
            }
        )
    )
    if (
        elapsed is None
        or elapsed < args.duration
        or len(timed) < 2
        or not all(row["list"] and row["position"] and row["candle"] for row in rows)
    ):
        raise SystemExit("Workspace prices did not move together")


if __name__ == "__main__":
    main()
