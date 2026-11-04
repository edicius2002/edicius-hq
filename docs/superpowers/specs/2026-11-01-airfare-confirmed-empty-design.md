# Airfare: confirmed empty departures and current availability

## Intent

Manual Fetch must report every departure it checked without presenting a provider response with no itineraries as a parser failure. The current view must show every valid offer and leave dates with a confirmed empty result blank. Historical fare observations remain available with their capture dates. A later Fetch always queries again and can restore or replace the current offers.

**Display revision (2026-11-02):** The user removed the persistent fetch status panel added by this design, including its month totals, last manual Fetch line, and per-date list. This supersedes the presentation requirement in data-flow step 5. Confirmed outcomes and request results remain stored; the chart and current flight table continue to use them.

## Observed failure

The production Pi completed its Supabase sync for AEP–ARI, but a March 2027 request updated 3 dates and reported 28 failures. A direct Google Flights probe showed a well-formed response whose itinerary blocks were explicitly `null` on one affected date. `_itinerary_rows` currently maps `payload[index] is None` to the same `_ABSENT` sentinel as a missing or malformed block, so the collector records `parse-drift`. The manual worker counts every `FareError` as a failure, and the web reduces the outcome to a short-lived icon. The query invalidation keys appear correct.

This evidence establishes what Google returned, not whether an airline actually has seats. The product wording must say “Google did not return itineraries,” never “the flight does not exist.”

## Goals and constraints

- Distinguish an explicit, well-formed empty itinerary response from structural drift. Preserve the guard that refuses an incomplete board when the main itinerary block is missing while another block contains offers.
- Confirm an empty departure with a second Google request. Both requests must use the existing pacer, concurrency slots, daily budget and request ledger. If the second response contains valid offers, use those offers. If it is malformed, fails, or cannot be sent within the budget, record an error and retain the last confirmed state. Never silently classify those cases as empty.
- Record a confirmed empty check as a successful observation with its own outcome, separate from a technical failure and from an archived fare snapshot. Do not write a fabricated zero-price or empty snapshot. Keep the append-only Pi archive and its Supabase replica intact.
- A manual month request completes when its checked dates are valid offers or confirmed empty, even if every date is empty. The result reports `lookedAt`, `changed`, `noOffers`, `failed`, and `skipped` separately. A technical or sync failure remains visible as a failure.
- The current view is derived from the latest **confirmed** outcome for each departure. A confirmed empty outcome hides that departure's old offers from the current view. A later valid check restores them, including when the board is unchanged and no new snapshot is appended. A later failed check leaves the previous confirmed current state in place and shows the failure separately.
- The historical view keeps prior prices and labels them with their capture dates. An empty current date remains blank on reload. Do not make an older price look like a current quote.
- Manual Fetch remains available on repeated presses. Do not add a warning, cooldown, or month-wide skip based on previous empty dates. Sparse routes may have offers on isolated days.
- Preserve owner-gated Supabase reads and the Pi-only provider access model. Work is limited to this branch; deployment is a separate step.

## Approaches

1. **Short-lived result only.** Change the parser, collector and request notice, but keep the current web data shape. This is smaller, yet reloading the page restores old boards as if they were current and loses the empty state. It does not meet the requested behavior.
2. **Durable per-departure outcome (selected).** Replicate confirmed-empty checks, expose each departure's latest confirmed check in the month projection, and derive the current display from that check while keeping history separate. This touches the Pi, Supabase projection and web, but preserves state across reloads and allows later Fetches to restore offers.

The user chose the durable current/history split, no repeated-fetch warning, and Google shape validation plus a second request to confirm emptiness. The second request is a consistency check against Google, not an independent airline inventory source.

## Data flow

1. The Google adapter recognizes explicit empty itinerary blocks as `no-offers`; missing or unreadable blocks remain `parse-drift`. Valid rows in the available blocks are parsed as today, subject to the existing complete-board guard. Regression fixtures cover explicit null/null, a valid block with a null best block, missing main block, malformed rows, and a later valid response.
2. The collector confirms `no-offers` once more under the same request accounting. On two confirmed empty responses it appends a `fare_checks` heartbeat with outcome `no-offers` and returns a successful no-offers route result. It does not append a fare snapshot. Errors append an error check without changing the last confirmed availability.
3. The manual worker syncs checks even for an all-empty month, completes the request, and includes `noOffers` in its result. The web decoder accepts the new field as optional during rollout, then displays it when supplied. The Supabase request-result JSON does not require a schema change for this extra field.
4. A forward-only Supabase migration extends the monthly projection with per-departure confirmed status and check time. It retains historical `latestBoards` for history consumers and exposes current boards or a clearly named current-status field for current views. Flight-page projections and their “present/gone” status use the same confirmed-status rule. A later valid `unchanged` check restores the prior board without inventing a new snapshot. The archive fallback must apply the same rule or clearly report current availability as unknown; it must never silently present an unverified old board as current.
5. The web displays a persistent, visible month summary with counts for offers, confirmed empty dates, technical failures and skipped dates. The current departure chart and flight table use confirmed status; dates confirmed empty show no current offer or price. Previously seen flights may remain in an explicitly historical view, with their capture dates, but may not appear among current offers. The empty-date message says “Google did not return itineraries” and shows the check time. Existing query invalidation runs after successful sync, including an all-empty request.

## Compatibility and verification

- Deploy in a compatible order when requested later: a Supabase migration and web reader tolerant of old/new projection and request-result shapes, then Pi emission of `noOffers` and confirmed-empty checks, then enable the new current-status presentation once the projection is populated. No production deployment is part of this branch task.
- Use a deterministic parser fixture and collector test that are red on the observed null-block failure. Exercise the second request's budget and pace accounting, two-empty/empty-then-offers/empty-then-error outcomes, all-empty manual completion and check sync, projection masking/restoration, and browser result text after reload.
- Confirm in the branch that valid offers are still shown for dates adjacent to empty ones, errors do not clear confirmed data, and a later valid Fetch restores a date that had been empty.
