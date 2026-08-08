"""
Can this address reach the market upstreams at all?

Decision 8.1 chose undocumented endpoints, and decision 8.4 wrote down the
consequence: "revisit at the cloud phase — requests then leave from one
datacenter IP rather than a home connection, which is far likelier to be
throttled." That was recorded and never checked, and everything in Investing
rests on it — the quote batch, the bars, the search, and both sockets.

This answers the narrow question that decides whether step 7 is a deploy or a
rewrite of the data plane: **does each surface answer from here?** Run it from a
laptop for the baseline and from a datacenter for the comparison; the difference
is the whole finding.

    python scripts/reachability.py --json

The cookie-and-crumb handshake is the one to watch. It is the most
browser-shaped thing here — a consent cookie followed by a token — and a
consent wall in front of it is exactly what an address with no browsing history
tends to meet.

**What this cannot tell you.** One address, one moment. A daily quota does not
show up in a handful of requests, and an address can be served today and
throttled next week. A clean run means "every surface answered from here now",
which is enough to choose a deploy target and not enough to stop watching.
"""

import argparse
import asyncio
import contextlib
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

TIMEOUT = 20


@dataclass
class Probe:
    surface: str
    ok: bool = False
    detail: str = ""
    ms: int = 0
    #: Set when the failure is the shape decision 8.4 warns about.
    looks_blocked: bool = False


def _blocked(status: int | None, body: str) -> bool:
    """
    Whether a refusal reads as "not you" rather than "not that".

    401 and 403 on an endpoint that serves a browser, 429 outright, and any
    body mentioning consent or a captcha — the wall an address with no history
    tends to meet.
    """
    if status in {401, 403, 429}:
        return True
    lowered = body.lower()
    return any(word in lowered for word in ("captcha", "consent", "unusual traffic", "guce"))


def _get(url: str, headers: dict[str, str] | None = None) -> tuple[int | None, str, int]:
    request = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, **(headers or {})})
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = response.read(2048).decode("utf-8", "replace")
            return response.status, body, int((time.perf_counter() - started) * 1000)
    except urllib.error.HTTPError as error:
        body = error.read(2048).decode("utf-8", "replace") if error.fp else ""
        return error.code, body, int((time.perf_counter() - started) * 1000)
    except Exception as error:  # noqa: BLE001 — any failure is a failure to reach
        return None, f"{type(error).__name__}: {error}", int((time.perf_counter() - started) * 1000)


def probe_yahoo_bars() -> Probe:
    url = "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d"
    status, body, ms = _get(url)
    ok = status == 200 and '"chart"' in body
    return Probe("yahoo bars", ok, f"HTTP {status}", ms, _blocked(status, body))


def probe_yahoo_search() -> Probe:
    url = "https://query2.finance.yahoo.com/v1/finance/search?q=apple&quotesCount=3"
    status, body, ms = _get(url)
    ok = status == 200 and "quotes" in body
    return Probe("yahoo search", ok, f"HTTP {status}", ms, _blocked(status, body))


def probe_yahoo_crumb() -> Probe:
    """
    The handshake, which is the fragile one.

    Cookies from `fc.yahoo.com`, then a crumb. This is the most browser-shaped
    thing in the data plane, so it is the most likely to meet a consent wall
    from an address with no browsing history.
    """
    jar = urllib.request.HTTPCookieProcessor()
    opener = urllib.request.build_opener(jar)
    started = time.perf_counter()

    try:
        consent = urllib.request.Request("https://fc.yahoo.com", headers={"User-Agent": BROWSER_UA})
        # 404 is expected and fine: the cookies are the point, not the body.
        with contextlib.suppress(urllib.error.HTTPError):
            opener.open(consent, timeout=TIMEOUT)

        crumb_request = urllib.request.Request(
            "https://query2.finance.yahoo.com/v1/test/getcrumb",
            headers={"User-Agent": BROWSER_UA},
        )
        with opener.open(crumb_request, timeout=TIMEOUT) as response:
            crumb = response.read(256).decode("utf-8", "replace").strip()
            ms = int((time.perf_counter() - started) * 1000)

        usable = bool(crumb) and len(crumb) <= 32 and "<" not in crumb
        return Probe(
            "yahoo crumb",
            usable,
            "got a crumb" if usable else f"unusable: {crumb[:60]!r}",
            ms,
            not usable and _blocked(None, crumb),
        )
    except urllib.error.HTTPError as error:
        body = error.read(512).decode("utf-8", "replace") if error.fp else ""
        ms = int((time.perf_counter() - started) * 1000)
        return Probe("yahoo crumb", False, f"HTTP {error.code}", ms, _blocked(error.code, body))
    except Exception as error:  # noqa: BLE001
        ms = int((time.perf_counter() - started) * 1000)
        return Probe("yahoo crumb", False, f"{type(error).__name__}: {error}", ms)


def probe_yahoo_batch(crumb: str | None) -> Probe:
    """The batch endpoint the whole watchlist rides on. Needs the crumb."""
    if not crumb:
        return Probe("yahoo quote batch", False, "no crumb to try with", 0)

    url = (
        "https://query2.finance.yahoo.com/v7/finance/quote"
        f"?symbols=AAPL,MSFT&crumb={urllib.parse.quote(crumb)}"
    )
    status, body, ms = _get(url)
    ok = status == 200 and "quoteResponse" in body
    return Probe("yahoo quote batch", ok, f"HTTP {status}", ms, _blocked(status, body))


def probe_binance_bars() -> Probe:
    url = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=5"
    status, body, ms = _get(url)
    return Probe("binance bars", status == 200, f"HTTP {status}", ms, _blocked(status, body))


async def _probe_socket(name: str, url: str, subscribe: str | None) -> Probe:
    try:
        import websockets
    except ImportError:
        return Probe(name, False, "websockets not installed", 0)

    started = time.perf_counter()
    try:
        context = ssl.create_default_context()
        async with websockets.connect(url, ssl=context, open_timeout=TIMEOUT) as socket:
            if subscribe:
                await socket.send(subscribe)
            # One frame is proof of life. Nothing here needs a price.
            await asyncio.wait_for(socket.recv(), timeout=TIMEOUT)
        ms = int((time.perf_counter() - started) * 1000)
        return Probe(name, True, "connected and received a frame", ms)
    except Exception as error:  # noqa: BLE001
        ms = int((time.perf_counter() - started) * 1000)
        text = f"{type(error).__name__}: {error}"
        return Probe(name, False, text, ms, _blocked(None, text))


async def probe_sockets() -> list[Probe]:
    return [
        await _probe_socket(
            "yahoo stream",
            "wss://streamer.finance.yahoo.com/?version=2",
            json.dumps({"subscribe": ["AAPL", "BTC-USD"]}),
        ),
        await _probe_socket(
            "binance stream",
            "wss://stream.binance.com:9443/stream?streams=btcusdt@ticker",
            None,
        ),
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="machine-readable, for CI")
    args = parser.parse_args()

    probes: list[Probe] = [probe_yahoo_bars(), probe_yahoo_search()]

    crumb_probe = probe_yahoo_crumb()
    probes.append(crumb_probe)
    crumb = None
    if crumb_probe.ok:
        # Re-run the handshake to hold the cookies alongside the crumb.
        jar = urllib.request.HTTPCookieProcessor()
        opener = urllib.request.build_opener(jar)
        try:
            # 404 again, and again fine: it is the cookies we came for.
            with contextlib.suppress(urllib.error.HTTPError):
                opener.open(
                    urllib.request.Request(
                        "https://fc.yahoo.com", headers={"User-Agent": BROWSER_UA}
                    ),
                    timeout=TIMEOUT,
                )
            with opener.open(
                urllib.request.Request(
                    "https://query2.finance.yahoo.com/v1/test/getcrumb",
                    headers={"User-Agent": BROWSER_UA},
                ),
                timeout=TIMEOUT,
            ) as response:
                crumb = response.read(256).decode("utf-8", "replace").strip()
            urllib.request.install_opener(opener)
        except Exception:  # noqa: BLE001
            crumb = None

    probes.append(probe_yahoo_batch(crumb))
    probes.append(probe_binance_bars())
    probes.extend(asyncio.run(probe_sockets()))

    if args.json:
        print(json.dumps([asdict(p) for p in probes], indent=2))
    else:
        print(f"{'surface':<20} {'':<4} {'ms':>6}  detail")
        for p in probes:
            mark = "ok" if p.ok else ("BLOCKED" if p.looks_blocked else "fail")
            print(f"  {p.surface:<18} {mark:<8} {p.ms:>5}  {p.detail[:70]}")

    failed = [p for p in probes if not p.ok]
    blocked = [p for p in failed if p.looks_blocked]

    if blocked:
        print(f"\n{len(blocked)} surface(s) look blocked from this address, not merely broken.")
        print("That is decision 8.4's scenario. Step 7 needs a different data plane.")
        return 2
    if failed:
        print(f"\n{len(failed)} surface(s) failed, none in a way that reads as a block.")
        return 1

    print("\nEvery surface answered from this address.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
