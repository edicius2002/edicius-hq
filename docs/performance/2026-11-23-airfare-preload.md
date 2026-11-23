# Airfare background preload: validation

Base: `891275e417212f513659e9757d724cb4b123ba32` (updated main).
Branch: `feat/airfare-background-preload`.

## Behavior demonstrated locally

Before implementation, `AirfarePage.preload.test.tsx` failed because opening
Airfare without a selection did not request a projection. After implementation,
the test opens the page, holds the initial projection response, verifies that the
route remains unselected and no route price chart is mounted, then releases the
response and allows the queue to finish. Selecting the route renders both real
chart components and the first flight row with no additional fresh reads:
two monthly projections, one calendar and one flight page for the fixture route.

This uses jsdom, a real QueryClient, page, chart and table components, and stubbed
transport responses. The map, route-list interaction boundary and unrelated
collection/watch hooks are stubbed. It measures request reuse and DOM behavior,
not browser paint time, layout responsiveness or Neon/network latency.

The queue tests additionally establish:

- Two concurrent speculative jobs per mounted queue; opening charts precede
  flight pages and secondary months.
- Visible demand bypasses queue capacity and shares matching in-flight reads.
- Failed reads release capacity; missing projections retain the historical
  fallback, including departed numeric summaries.
- Reopening with fresh data causes no additional reads; a stale projection
  refreshes while its existing data remains available.
- Edited watchlists discard obsolete pending jobs without restarting others.
- Disposal stops successors without canceling reads already shared with a view.
- Unknown availability, historical fallback and missing capture dates do not
  preload flight pages; revision mismatches invalidate the owning projection.

Hook tests run with StrictMode and the actual QueryProvider. They cover known and
unknown initial identity, same-owner token refresh, logout and owner replacement,
including a late transport response that ignores cancellation.

An independent review identified three lifecycle cases, each reproduced by a
failing regression test before correction:

- Flight rows retained for revision 1 after revision 2's page failed. Retention
  now includes the projection revision; same-revision page/filter recovery stays
  intact.
- A visible observer canceled a shared preload on navigation, leaving the key
  permanently attempted. Canceled jobs now return to the current queue, while
  ordinary read failures remain terminal for that pass.
- The first auth callback could discover another owner before React replaced the
  old owner's tree. `AuthenticatedOwnerContext` binds the queue to the identity
  that owns the rendered watchlist, so a different first callback starts no reads.

All three regression tests passed after correction. No minor findings were deferred.

## Verification record

- Pre-change Airfare baseline: 63 test files, 1,334 tests passed.
- Post-change full web suite: 211 test files passed, one skipped; 2,854 tests
  passed, two skipped. The skipped tests are existing opt-in coverage.
- Typecheck, lint, repository-wide format check and production build passed.
- The existing Vite warning about `./dev/devSession` lacking a file extension
  also occurs in the baseline; this change does not alter Vite configuration.

## Limits and follow-up measurement

No authenticated production baseline or before/after browser timing was captured.
The worktree has no production session, and no credentials or private fare payloads
were copied into this report. A percentage or millisecond improvement is therefore
not claimed. Clicking before preload completion still waits for remaining data.

Before deployment, use the same authenticated browser, device, network and route
set for five samples each: page entry, immediate selection, selection after
preload, route switch and return after more than 60 seconds. Record chart paint,
first flight row, total preload completion, request counts, bytes and errors.
Check that the map/list remain interactive, and separate human wait and login
time from loading. Local full-suite runtime is not an application latency metric.

Main already includes shared Neon token handling and owner-keyed application
remounts; this branch reuses both. There are no SQL changes, new dependencies,
provider searches, writes to the archive or persistent browser caches.
