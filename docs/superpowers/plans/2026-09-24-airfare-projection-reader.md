# Airfare projection reader rollout

## Objective

Open the selected route and month from one compact month projection, keep the existing chart and flight semantics, and load other watched months after the selected one. Flights seen must retain its observation-period membership, filters, sort and 10-row pagination without fetching historical snapshot pages.

## Steps

1. Extend the persisted flight model with observation days for each itinerary and add an owner-gated, filtered, sorted, paginated RPC. Verify stable prices, disappeared flights, day/week/month membership, filters and counts in pgTAP. Apply the additive migration and rebuild existing routes before switching the web reader.
2. Add typed browser projection readers and parsers. A missing or malformed projection must produce a clear error; do not silently present a fabricated empty archive. Check cancellation and owner access.
3. Change the page queries so the selected month projection starts immediately. Use its daily price and provider series for How the price moved, latest boards for Flight details and the current departure frame, and a separate flight-page query for Flights seen. Keep the current calendar query.
4. Fetch latest boards for other watched months in the background after the selected month is available. Cache each month separately and retain previously loaded frames while navigating.
5. Add focused parity and request-count tests for route/month switches and filter/sort/page interactions. Run web typecheck, lint, focused tests, SQL tests and CI. Deploy through a PR, then compare deployed timings with the historical baseline.

## Rollback

Keep the historical RPCs and code until the new reader is verified on production data. A small query flag can select the old path for comparison and emergency rollback.
