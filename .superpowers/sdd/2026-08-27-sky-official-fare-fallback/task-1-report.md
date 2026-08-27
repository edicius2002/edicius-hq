# Task 1 report: Preserve unavailable prices in the web client

## Status

Implemented on branch `codex/sky-official-fare-fallback`.

## Changes

- Changed `FareOffer.price` from `number` to `number | null` in `apps/web/src/shared/api/fares.ts`.
- Updated `cheapestOffer` in `apps/web/src/features/airfare/lib/series.ts` to ignore `null`, `NaN`, and infinite prices.
- Updated `cheapestSeries` to omit snapshots whose offers have no valid numeric price.
- Updated `byAirline` to omit unavailable/non-finite offers and carriers with no valid offers.
- Updated `cheapestDeparture` to ignore snapshots whose cheapest offer is unavailable/non-finite.
- Added null/non-finite regression coverage in `apps/web/src/features/airfare/lib/series.test.ts`.

## TDD evidence

### RED

With the new regression tests present and the pre-fix aggregation implementation temporarily restored:

```text
npm run test -w web -- src/features/airfare/lib/series.test.ts
Test Files  1 failed (1)
Tests       3 failed | 32 passed (35)
```

The failures were the null-price series point, unavailable carrier grouping, and cheapest-offer filtering assertions.

### GREEN

After restoring the implementation fix:

```text
npm run test -w web -- src/features/airfare/lib/series.test.ts
Test Files  1 passed (1)
Tests       35 passed (35)
EXIT_CODE=0
```

## Exact commands and results

- `npm install` — completed so the locked test dependencies were available.
- `npm run test -w web -- src/features/airfare/lib/series.test.ts` — passed, 35/35 tests.
- `git diff --check` — passed with no whitespace errors.
- `npm run typecheck -w web` — fails in existing consumers outside this task's permitted files (`buckets.ts`, `flights.ts`, `flightScatter.ts`, `pairReference.ts`, and `RouteDetail.tsx`) because they still assume `FareOffer.price` is always numeric. The local `series.ts` errors were fixed; no backend file was touched.

## Files changed

- `apps/web/src/shared/api/fares.ts`
- `apps/web/src/features/airfare/lib/series.ts`
- `apps/web/src/features/airfare/lib/series.test.ts`
- `.superpowers/sdd/2026-08-27-sky-official-fare-fallback/task-1-report.md`

## Self-review

- Scope is limited to the requested web contract, aggregation logic, tests, and report.
- Unavailable and non-finite prices cannot become chart points or zero-valued carrier summaries.
- Existing numeric-price behavior remains covered and passing.
- `services/api/app/services/fare_history.py` was not modified.
- Concern: the widened shared API type requires follow-up null handling in the other airfare consumers reported by the typecheck; those files were intentionally not changed under this task brief.
