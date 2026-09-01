#!/usr/bin/env python3
"""Reproduce the public SKY availability API reconnaissance.

This is intentionally a diagnostic spike, not an adapter.  It reads the
public browser configuration to obtain the current endpoint and public API key,
then makes one paced availability request for a route/date.  It never logs the
key, cookies, response body, or any personal data.

Examples:
  services/api/.venv-wsl/bin/python scripts/sky-availability-spike.py \
    --origin AQP --destination LIM --date 2026-11-05
  services/api/.venv-wsl/bin/python scripts/sky-availability-spike.py \
    --origin AQP --destination LIM --date 2026-11-05 --warm
"""

from __future__ import annotations

import argparse
import re
import time
from datetime import date

import httpx

LANDING_URL = "https://www.skyairline.com/flights/en/"
SEARCH_CONFIG_PATTERN = re.compile(
    r'"sputnikSearch":\{"config":\{"endpoint":"'
    r"(?P<endpoint>https://[^\"]+/airfare-sputnik-service/v3/"
    r"%%tenantCode%%/fares/search).*?"
    r'"em-api-key":"(?P<key>[^"]+)"',
    re.DOTALL,
)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--origin", default="AQP")
    result.add_argument("--destination", default="LIM")
    result.add_argument("--date", type=date.fromisoformat, default=date(2026, 11, 5))
    result.add_argument(
        "--warm",
        action="store_true",
        help="reuse only the landing-page cookies; default is a cold API client",
    )
    result.add_argument(
        "--delay",
        type=float,
        default=2.5,
        help="seconds between the public landing request and API POST (default: 2.5)",
    )
    return result


def page_search_config(page: str) -> tuple[str, str]:
    match = SEARCH_CONFIG_PATTERN.search(page)
    if not match:
        raise RuntimeError("public SKY search configuration was not found in the landing page")
    return match.group("endpoint").replace("%%tenantCode%%", "h2"), match.group("key")


def request_body(origin: str, destination: str, departure: date) -> dict[str, object]:
    days = (departure - date.today()).days
    return {
        "routesLimit": 20,
        "faresLimit": 50,
        "faresPerRoute": 2,
        "autoSettings": {"language": "en", "market": ""},
        "origins": [origin.upper()],
        "destinations": [destination.upper()],
        "journeyType": "ONE_WAY",
        "departureDaysInterval": {"start": days, "end": days},
    }


def main() -> int:
    args = parser().parse_args()
    if args.delay < 2:
        raise SystemExit("--delay must be at least two seconds")

    browser_headers = {"user-agent": "Mozilla/5.0", "accept": "text/html"}
    with httpx.Client(timeout=30, headers=browser_headers) as landing_client:
        landing = landing_client.get(LANDING_URL)
        landing.raise_for_status()
        endpoint, api_key = page_search_config(landing.text)
        landing_cookie_count = len(landing_client.cookies)

        # This is reconnaissance, not load: keep the collector's public-request pace.
        time.sleep(args.delay)
        body = request_body(args.origin, args.destination, args.date)
        if args.warm:
            search_client = landing_client
        else:
            search_client = httpx.Client(timeout=30, headers={"user-agent": "Mozilla/5.0"})

        try:
            response = search_client.post(
                endpoint,
                headers={
                    "em-api-key": api_key,
                    "origin": "https://www.skyairline.com",
                    "referer": LANDING_URL,
                    "accept": "application/json",
                },
                json=body,
            )
        finally:
            if not args.warm:
                search_client.close()

    # Deliberately safe output: the key and cookie values are not diagnostics.
    print(f"landing_status={landing.status_code}")
    print(f"mode={'warm' if args.warm else 'cold'}")
    print(f"endpoint={endpoint}")
    print("method=POST content_type=application/json")
    print(f"landing_cookie_count={landing_cookie_count}")
    print(f"api_status={response.status_code}")
    print(f"api_content_type={response.headers.get('content-type') or '-'}")
    print(f"api_server={response.headers.get('server') or '-'}")
    print(f"api_response_bytes={len(response.content)}")
    content_type = response.headers.get("content-type", "")
    if "json" not in content_type:
        return 0

    payload = response.json()
    print(f"api_json_type={type(payload).__name__}")
    print(f"api_result_count={len(payload) if isinstance(payload, list) else '-'}")
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], dict):
        return 0

    first = payload[0]
    price = first.get("priceSpecification")
    flight = first.get("outboundFlight")
    print(f"first_airline={first.get('airline', {}).get('iataCode', '-')}")
    print(f"first_departure_date={first.get('departureDate', '-')}")
    print(f"first_currency={price.get('currencyCode', '-') if isinstance(price, dict) else '-'}")
    print(f"first_total_price={price.get('totalPrice', '-') if isinstance(price, dict) else '-'}")
    print(
        "first_itinerary_fields="
        + ",".join(sorted(flight))
        if isinstance(flight, dict)
        else "first_itinerary_fields=-"
    )
    print(f"first_tax_marker={'tax' in str(first).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
