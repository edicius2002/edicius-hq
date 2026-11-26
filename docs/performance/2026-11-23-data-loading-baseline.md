# Data loading baseline ? 2026-11-23

Production SHA: e592adf4b2d36b3d27ec60cccd9434214a212f35 (successful deployment recorded 2026-11-16).

Public network samples: HTML 122?375 ms, CDN HIT; main JavaScript 376273 decoded bytes, Brotli; anonymous session 240?249 ms. These are not authenticated rendering measurements.

Authenticated baseline remains pending: browser extension host unavailable. No production speedup is claimed. Repeat five samples per route for cold client cache, first visit, return within 30 seconds and return after six minutes. Record median/range, useful-content paint, requests, bytes and auth calls, fixing device, network and selected data. Never commit raw private HAR files.

Local baseline: eight concurrent calls to the actual token adapter with synthetic HTTP transport issued eight token requests.

## Implementation and review

The local change deduplicates concurrent token reads and caches until 30 seconds before JWT expiry. Session subscribers share initial state; the Neon gate waits for owner identity and offers retry on transient initial failure. Routine focus revalidates without discarding valid token requests. Explicit cross-window identity transitions retire old private UI before replacement-session reads; failed or interrupted logout has a recovery path.

Dashboard retains FX and posts during navigation, with identity-change cleanup preserved. Sentiment retains its snapshot for four hours. Finance retains its revision, single writer and conflict state with its Query instance; query retention is unlimited within the browser session so inactive-query GC cannot discard failed edits. Explicit logout/owner change removes it. The tradeoff is retaining the finite Finance documents in memory until logout/reload.

SEACE page RPCs receive AbortSignal and sync metadata uses the query cache. Route module promises are shared with pointer/focus preloading, deduplicated and retried after speculative failure; data-saving and hidden-page guards prevent opportunistic downloads.

A fresh independent review identified five important lifecycle issues. Regression tests reproduced each before fixes: focus/token race, cross-window identity replacement, Finance GC losing work, ownerless double startup and interrupted/failed logout. Targeted tests pass.

Airfare and Investing already have progressive loading. Their prefetch policies, SQL and payload splitting remain unchanged until authenticated measurements justify changes. The local main entry is about 380.10 kB decoded versus the production artifact's 376.27 kB; this is not a controlled bundle comparison because the production build environment was not replicated.

Deferred minor review observations:

- SEACE metadata-only refresh failures retain existing timestamps/counts without a separate stale-count warning.
- Speculative SEACE pages may complete after navigation; prefetch breadth remains measurement-dependent.
- Dashboard/FX also clear changed-owner data locally, in addition to the global provider, preserving standalone hook isolation.

## Verification scope

Web-only changes; no API/schema/collector changes. Formatting, lint, TypeScript and Vite production compilation pass. Build uses the installed dependency binaries and configLoader runner because the isolated worktree links existing dependencies. This validates compilation, not a deployed runtime with production environment variables.

Authenticated timing matrix, passkey-origin smoke tests and deployment remain pending. No speedup percentage or 200 ms production target is claimed.

Final suite: 207 test files passed, 1 existing skipped file; 2825 tests passed and 2 existing skipped tests. Format check, lint, TypeScript and build all passed.
