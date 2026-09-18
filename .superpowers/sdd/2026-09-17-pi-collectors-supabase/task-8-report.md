# Task 8 report — Supabase Investing market data

## Implementation

- Added `supabaseMarket`, which reads owner-visible quotes, uses only unexpired bar cache rows, and queues bar/search work with operation/payload only.
- Collector completion is subscribed to then reconciled by reading the request row, preventing a completion-before-listener race. Timeout, abort, failed, expired, malformed, and unavailable outcomes sanitize to an error code and release the channel/timer once.
- Replaced market SSE with Supabase Realtime quote rows; normalized updates are fed through `quoteBus` and mapped to the existing tick wire shape.
- Kept the shared market API exports stable while removing active provider-route calls. Chart timeframes are now local UI constants.

## TDD evidence

- RED: `npm test -w web -- src/features/investing/data/supabaseMarket.test.ts` failed because `supabaseMarket` did not exist.
- GREEN: focused Investing boundary suite passed: 47 tests across Supabase boundary, quote stream/bus, candles, search, and positions.

## Verification

- `npm run typecheck -w web` passed.
- `npm run lint` passed with no errors.
- `git diff --check` passed.
- Active `/api/market` URL grep is clean; remaining `api/market` matches are module import paths, not endpoint URLs.
- Full `npm test -w web` was started twice but the harness returned at its 30-second process limit before a completion summary; the targeted full Investing boundary set passed.

## Review follow-up

- Realtime now forwards subscription status, opens the page stream only after `SUBSCRIBED`, and lowers it for error, timeout, close, and unknown terminal statuses. Disposal ignores later callbacks and removes the channel once.
- Added request boundary coverage for invalid failure-code sanitization, malformed completed results, and the 20-second timeout cleanup path. The focused suite is now 52 passing tests.
