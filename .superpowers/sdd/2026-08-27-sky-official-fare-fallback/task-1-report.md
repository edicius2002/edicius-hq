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

## Review fix round 1

The scope was expanded by review to enforce the nullable-price invariant across all affected airfare consumers.

### Fixes

- `buckets.ts` now only adds finite numeric cheapest offers to bucket arrays.
- `flights.ts` drops unavailable/non-finite offers from tracks and board-change calculations.
- `flightScatter.ts` drops unavailable/non-finite offers before point placement and minimum selection.
- `pairReference.ts` drops unavailable/non-finite offers before per-date minima and median calculation.
- `RouteDetail.tsx` derives typed finite `pricedOffers`, so empty/unavailable boards retain the `—` display and never reach min/max formatting.
- `series.test.ts` now separately covers an actually empty board and a null-price board.

### RED/GREEN and verification

The initial nullable contract typecheck was RED with compiler errors in the affected consumers, including `buckets.ts`, `flights.ts`, `flightScatter.ts`, `pairReference.ts`, and `RouteDetail.tsx` (`number | null` not assignable to `number`, plus possibly-null comparisons). After adding the guards, the exact verification command was:

```text
npm run test -w web -- src/features/airfare/lib/series.test.ts src/features/airfare/lib/buckets.test.ts src/features/airfare/lib/flights.test.ts src/features/airfare/lib/flightScatter.test.ts src/features/airfare/lib/pairReference.test.ts
Test Files  5 passed (5)
Tests       172 passed (172)

npm run typecheck -w web
tsc -b --pretty false
EXIT_CODE=0
```

The original series RED/GREEN evidence above remains applicable to the core null-price regressions; the affected consumer typecheck supplied the review RED and the clean typecheck above supplies GREEN.

### Review self-check

- No `FareOffer.price` value is inserted into a numeric aggregate unless it is non-null and finite.
- No synthetic zero is introduced for empty or unavailable boards.
- `services/api/app/services/fare_history.py` remains untouched.
- The prior report's concern about out-of-scope typecheck failures is resolved; full web typecheck now passes.
