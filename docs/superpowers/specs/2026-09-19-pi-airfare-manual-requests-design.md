# Pi-backed manual Airfare requests

Date: 2026-09-19

Status: conversational design approved by the user on 2026-09-19; written
specification awaiting review before implementation planning.

Baseline: `e5a9f18b1ba447899d5f23cf0669d8bce6f2e66a` on the isolated branch
`feat/pi-airfare-manual-requests`.

## Intent and success

Restore the circular per-route Airfare refresh control without restoring browser
collection on the hosted API or on Windows. A press submits one route and one
departure month to Supabase; a dedicated Raspberry Pi worker performs the forced
collection, writes the Pi-local archive, synchronizes that archive to Supabase,
and only then marks the request complete.

The row retains its spinner and progress bar. The persistent status sentence below
the row is removed. Accepted, completed, failed, and expired outcomes are shown by
the existing floating notification surface, adapted to become the accessible
announcement owner after the inline live region is removed. On successful completion,
the browser refetches Supabase-backed Airfare data so charts and the globe display
the newly synchronized archive.

Success means all of the following are true:

- the circular control is present for an eligible route only while the Pi manual
  request worker has a fresh health heartbeat;
- one press queues exactly one owner-scoped route/month request and never executes
  provider work in the browser or hosted API;
- Investing and Airfare workers can claim only their own operation types;
- a scheduled Airfare pass and a manual pass cannot collect concurrently;
- queued/running progress reaches the existing row spinner and progress bar;
- a request becomes complete only after a successful Supabase archive sync;
- completion invalidates the cloud-backed history, calendar, airport, and health
  queries needed by the Airfare page, including a missed-Realtime recovery path;
- no persistent per-row status text remains; and
- no production service, Pi unit, Windows task, or collector authority is changed
  merely by merging the implementation.

## Current state and problem

`useRouteCollection` is intentionally a retired stub. `AirfarePage` does not pass
`onCollect` to `RouteList`, so the already implemented circular button, spinner,
and progress bar cannot be reached. `CollectNotices` remains mounted but receives
no notices. The old implementation posted to `/api/fares/collect` and followed an
API-hosted pass over SSE/polling; restoring it would execute the collector on the
wrong machine and reintroduce a second acquisition authority.

The existing `collector_requests` table supports only `market-bars` and
`market-search`. Its claim RPC selects the oldest request without an operation
filter. Extending the operation constraint alone would therefore let the Market
worker claim an Airfare request and fail it as invalid. The table is already in the
Supabase Realtime publication and already has owner-scoped browser reads, making it
the correct transport after claim isolation is repaired.

The scheduled Pi Airfare unit is a fifteen-minute oneshot. A separate long-running
manual-request worker is necessary for low-latency Realtime wakeups and polling
reconciliation. Both paths must share the existing `exclusive_process_lock("airfare")`
so there is still only one Airfare acquisition process.

## Scope and non-goals

This change includes the request schema/RPCs, operation-specific claims, Pi worker
and systemd unit, web request lifecycle, progress, floating notifications, targeted
refetch, generated Supabase types, tests, runbook/install updates, and a disabled
cutover gate.

It does not:

- restore `/api/fares/collect`, its SSE stream, live snapshot injection, or the old
  609-line browser collection controller;
- add calendar-horizon collection to the row button;
- expose the Pi through a public webhook or inbound port;
- make Supabase, the browser, or the hosted API the Airfare archive writer;
- enable or deploy the new Pi unit automatically;
- disable the Windows rollback path or alter the scheduled Airfare timer;
- merge this branch, perform Task 12 cleanup, delete retained data, or claim a
  production cutover has happened; or
- revive the hosted `/api/fares/spend` read as part of manual refresh. Daily spend
  remains Pi-local until it has its own explicit cloud replication design.

## Invariants

1. The Pi-local Airfare archive remains the write authority; Supabase remains its
   indexed browser-readable replica.
2. A browser may enqueue and observe only its authenticated owner records. It may
   not claim, update progress, complete, fail, or choose another owner.
3. A worker may claim only an explicit non-empty allowlist of operations.
4. The Airfare process lock is acquired before an Airfare request is claimed. A
   request waiting behind the scheduled pass stays `queued`, not misleadingly
   `running` or failed.
5. `complete` means the local collection finished acceptably and its incremental
   sync returned complete. Local writes without a confirmed sync are never reported
   to the browser as a successful refresh.
6. Realtime reduces latency; bounded polling is the correctness/recovery path.
7. Request payloads, results, progress, errors, logs, and evidence never contain
   credentials, provider HTML, cookies, internal paths, or unsanitized exceptions.

## End-to-end flow

1. `AirfarePage` establishes that the `airfare-requests` worker has a current
   `running` heartbeat. Only then does it pass `onCollect` to `RouteList`.
2. Pressing the circular control validates the route/month in the client and calls
   the owner-gated enqueue RPC with origin, destination, month, and currency.
3. The RPC expires stale matching work and atomically returns either the existing
   active identical request or one newly inserted request with a 30-minute expiry.
4. The hook tracks the request, immediately shows the spinner and an indeterminate
   progress bar, and raises an accepted floating notification.
5. The Pi worker wakes on a Realtime insert or its 30-second reconciliation timer.
   It attempts the Airfare process lock before calling the operation-scoped claim
   RPC. If the lock is occupied, it backs off and leaves the request queued.
6. While holding that lock, it claims `airfare-route`, validates the payload again,
   runs a forced board collection for exactly that route/month, and rate-limits
   progress writes.
7. After an acceptable local pass, the worker sets progress to `syncing` and runs
   the existing incremental Airfare synchronization. Only a confirmed complete
   sync allows the request to transition to `complete`.
8. The browser receives UPDATE events or discovers them through polling. Progress
   updates the row bar; a terminal result stops the spinner and raises a completion,
   failure, or expiry notification.
9. Exactly once per completed request in that tab, React Query invalidates the
   affected route's history/calendar data and the supporting airport and collector
   health queries. Refetches read Supabase only and therefore cannot race ahead of
   synchronization.

## Supabase request protocol

### Table changes

An additive migration extends `collector_requests.operation` with
`airfare-route` and adds:

- `progress jsonb not null`, defaulting to the queued progress object shown below;
  and
- `updated_at timestamptz not null default now()`.

Progress has this version-one shape:

```json
{
  "stage": "queued | collecting | syncing",
  "completed": 0,
  "total": null
}
```

`completed` is a non-negative integer. `total` is null until planning settles,
then a non-negative integer no smaller than `completed`. `stage=syncing` retains
the final collection counts. Table checks require an object and the RPC validates
the exact supported fields/types; clients treat malformed progress as indeterminate
rather than trusting it. Existing Market rows receive the default but do not need
to update it.

The Airfare request payload is exactly:

```json
{
  "origin": "LIM",
  "destination": "CUZ",
  "month": "2026-11",
  "currency": "USD"
}
```

Origin and destination are distinct uppercase IATA codes, month is a real
`YYYY-MM` within the supported collection horizon, and currency is an uppercase
three-letter code supported by the existing fare domain. Server validation is
authoritative even when the browser has already validated the route.

The successful result is a bounded summary, not a copy of fare payloads:

```json
{
  "origin": "LIM",
  "destination": "CUZ",
  "month": "2026-11",
  "lookedAt": 30,
  "changed": 2,
  "failed": 0,
  "skipped": 0,
  "synced": true
}
```

Counts are non-negative integers and `synced` must be true on a completed request.
The archive remains the source for prices, offers, airports, and charts.

### Enqueue, deduplication, and ownership

Add an authenticated SECURITY DEFINER RPC such as
`enqueue_airfare_route_request(p_origin, p_destination, p_month, p_currency)` with
an empty search path. It requires `auth.uid()`, verifies membership in
`edicius_owners`, normalizes/validates the four scalar inputs, expires stale matching
active rows, and returns an existing unexpired identical queued/running request or a
new request expiring 30 minutes after creation.

A partial unique expression index over owner plus the four payload fields for
`operation='airfare-route'` and `status in ('queued','running')` closes concurrent-tab
races. The enqueue function handles the unique race by selecting and returning the
winner. The request insert policy is tightened so authenticated direct inserts remain
available only for the two Market operations; Airfare insertion is available only
through the validated RPC. Authenticated users retain SELECT only over their own rows
and retain no UPDATE or DELETE privilege.

Market requests retain their five-minute expiry. Airfare route requests use 30
minutes. Terminal writes continue to require an unexpired `running` row, so late
workers cannot turn an expired request back into a success.

### Operation-scoped claims and worker writes

Replace the unscoped `claim_collector_request(uuid)` RPC with an explicit signature
such as `claim_collector_request(p_owner_id uuid, p_operations text[])`. It rejects
null, empty, duplicate, or unknown operation arrays, expires stale queued/running
requests, and atomically claims the oldest unexpired row for that owner whose
operation is in the supplied allowlist using the existing `FOR UPDATE SKIP LOCKED`
pattern. The old overload is removed so no worker can accidentally keep using the
unsafe behavior. Claim and expiry transitions also advance `updated_at`.

`CollectorCloud.claim_request` requires an allowed-operation set. Market passes
`market-bars, market-search`; Airfare passes only `airfare-route`. The client also
rejects a returned operation outside its requested set as defense in depth.

Add a service-role-only progress RPC such as
`update_collector_request_progress(p_request_id, p_progress)`. It accepts only an
unexpired running `airfare-route` request, validates the progress shape and monotonic
counts/stages, updates `progress` and `updated_at`, and cannot change owner, operation,
payload, result, or lifecycle status. Completion/failure RPCs also advance
`updated_at`. Grants remain explicit and public/anonymous/authenticated execution of
claim, progress, completion, and failure RPCs is revoked.

`collector_requests` is already in the Realtime publication. The migration preserves
that publication and the owner-scoped RLS behavior for UPDATE events.

## Pi manual-request worker

Add one long-running entry point and focused service module, modeled on the Market
worker's Realtime reconnect plus polling reconciliation rather than duplicating it
inside the web application. Expected seams are:

- `scripts/airfare-request-worker.py` for signals, lifecycle, Realtime subscription,
  polling, and cloud run health;
- `services/api/app/services/airfare_request_worker.py` for validation, claim/serve,
  collection, progress, synchronization, and safe terminal settlement; and
- `ops/pi/systemd/edicius-airfare-requests.service` as a disabled-by-default
  `Type=simple` unit under `edicius-collector` with the same hardening, environment,
  data directory, and restart policy as the Market worker.

The worker begins one `collector_runs` row using the new collector value
`airfare-requests`. The migration extends the collector constraint and the Python
allowlist accordingly. A successful empty reconciliation cycle advances its
heartbeat; this proves that the long-running request consumer can still reach and
query Supabase. The browser considers it healthy only when the newest row is
`running`, `heartbeat_at` is later than `started_at`, and the heartbeat is no older
than three reconciliation intervals (90 seconds). Requiring a post-start heartbeat
prevents `begin_run` alone from exposing the button. Graceful shutdown completes the
run; failure records a fixed error code; an abruptly dead process becomes unhealthy
when its heartbeat ages out. The existing `airfare` collector value and status text
continue to describe scheduled collection, not manual-worker availability.

Realtime subscribes to inserts for the configured owner and wakes the claim loop.
Reconnect uses bounded exponential backoff. A 30-second claim poll is mandatory even
when Realtime is connected, so missed inserts, reconnect gaps, and stale-request
expiry converge without a page retry.

For each pending request, the worker:

1. attempts `exclusive_process_lock("airfare")` without blocking;
2. if unavailable, sleeps with bounded backoff and leaves the request queued;
3. while holding the lock, claims only `airfare-route`;
4. validates owner, exact payload shape, watch values, and expiry;
5. expands one `FareWatch` month and invokes the existing forced `collect` path,
   preserving its provider pacing, daily ledger, pass lock, history writes, and
   observer contract;
6. publishes `collecting` progress on planning and completed departures, no more
   often than once every two seconds except for stage boundaries; the observer only
   updates in-memory state and a separate task performs cloud I/O, preserving the
   observer's non-blocking contract;
7. records a `kind=board` pass ledger entry with the existing `source=ui`, because
   this is still a reader-requested pass even though the Pi executes it;
8. rejects partial/provider-failed or deliberately truncated passes with a fixed
   safe error code;
9. publishes `syncing`, calls `sync_completed_pass`, and requires `True`; and
10. completes with the bounded result summary or fails with an allowlisted code.

Full exception details stay in the Pi journal. Cloud-facing codes are limited to a
documented vocabulary such as `invalid-request`, `collection-failed`,
`sync-failed`, `request-expired`, and `worker-failed`. Provider messages and
exceptions never become notification text.

Holding the process lock across claim, collection, local write, and synchronization
is intentional. It keeps the request queued while the scheduled pass is active and
prevents the timer from entering during a manual pass. The existing inner `PassLock`
remains defense in depth; neither lock is removed.

## Web behavior

`useRouteCollection` is rebuilt as a small Supabase request controller, not restored
from its API/SSE predecessor. It owns:

- enqueue through the Airfare RPC;
- initial reconciliation of active owner Airfare requests;
- one owner-scoped Realtime subscription plus a bounded polling fallback;
- request-id tracking for presses made or adopted by this tab;
- derivation of route-keyed collecting and progress state;
- terminal notification and exactly-once cache invalidation; and
- cleanup of channels, timers, abort listeners, and in-memory request tracking.

The hook adopts a deduplicated request returned by enqueue, so two tabs cannot create
duplicate provider work. Active work discovered on page load drives the matching
route spinner/progress but does not invent an “accepted” notification for a press
made before this tab existed. A request explicitly returned to this tab does receive
its terminal notification even when another tab originally created it.

Queued work is busy with indeterminate progress. Collecting work uses
`completed / total` after a nonzero total is known and remains indeterminate before
then. Syncing keeps the bar full while the archive is uploaded. Terminal state removes
the bar and spinner. Malformed progress never throws the page or yields a percentage
outside 0–100.

`AirfarePage` passes `onCollect={rowCollection.collect}` only while the dedicated
manual worker is healthy. A stale/missing/terminal heartbeat omits the control rather
than offering a press that cannot be served. Departed/ineligible months remain
uncollectable. The existing scheduled-Airfare status line stays unchanged.

`RouteList` removes the `reports` prop, report lookup, persistent `<p>` status/live
region, and report-dependent measurement dependency. It retains the circular button,
`CollectMark` spinner, progress element, and removal behavior. The progress element
gains an accessible label/value strategy now that the inline live text no longer
describes it; indeterminate and determinate states must be announced without flooding
on every progress event.

`CollectNotices` remains the floating visual surface but is refactored away from the
legacy `CollectResponse`/`RowReport` shape. A notice carries request ID, route/month
title, safe text, tone, and lifetime. Accepted/completed messages use a polite live
region; failed/expired messages use an assertive alert. The notification is no longer
`aria-hidden`, because the removed inline status line cannot announce the same event.
No notification contains a raw database/provider error.

On `complete`, the hook invalidates at least:

- `['fares', 'history', origin, destination]` as a prefix, covering the displayed
  departure/month variants for that pair;
- `['fares', 'calendar', origin, destination]`;
- `['fares', 'airports']`, because newly observed via-points may require coordinates;
- `['collector-runs', 'airfare']`; and
- `['collector-runs', 'airfare-requests']`.

There is no optimistic fare insertion: completion already means the authoritative
Pi archive is in Supabase, so normal refetch returns durable data. A handled-request
set makes Realtime and polling delivery idempotent and prevents duplicate notifications
or refetch storms. Failed and expired requests notify but do not invalidate archive
queries as though new data were available.

## Failure and recovery semantics

| Condition                             | Required behavior                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Realtime unavailable                  | Worker and browser polling reconcile; no request is lost.                                                            |
| Scheduled pass owns lock              | Manual request stays queued and visible until lock acquisition or expiry.                                            |
| Duplicate press/tab                   | Enqueue returns the existing active request; one provider pass occurs.                                               |
| Pi stops before claim                 | Request remains queued, expires at 30 minutes, and the button disappears after stale health.                         |
| Pi stops after claim                  | Row remains running until expiry; late completion is rejected. No automatic duplicate collection.                    |
| Provider/validation failure           | Worker records a safe failed code; UI stops and shows an error notification.                                         |
| Local collection succeeds, sync fails | Request is failed as `sync-failed`; UI does not refetch as success. Local data is retained for later reconciliation. |
| Completion Realtime event is missed   | Polling observes the terminal row and performs the same idempotent notification/refetch.                             |
| Browser closes                        | Pi continues; reopening shows active progress through reconciliation. No browser connection owns the work.           |
| Malformed row/result/progress         | Fail closed in the relevant boundary, show a generic safe error, and log details only on the trusted side.           |

Requests are never automatically reclaimed after a running worker disappears. That
avoids duplicating paid/provider work whose local completion is unknown. An operator
may reconcile retained local data, while the request becomes expired by its normal
lifecycle.

## Testing and acceptance

Implementation is test-first and includes:

### Database

- migration from the current schema, generated-type parity, and pgTAP coverage;
- owner-only enqueue/select, anonymous denial, cross-owner denial, and service-role
  RPC boundaries;
- strict payload/progress validation and 30-minute versus five-minute expiry;
- concurrent duplicate enqueue returning one active route/month request;
- operation-scoped atomic claims proving Market cannot claim Airfare and Airfare
  cannot claim Market;
- progress monotonicity, terminal-state protection, stale expiry, and late-write
  rejection; and
- Realtime publication and RLS visibility for progress/terminal updates.

### Python/Pi

- request payload validation and safe result/error serialization;
- process lock acquired before claim, including a scheduled-pass contention case
  that leaves the request queued;
- forced one-route/one-month collection using existing pacing, ledger, and history;
- progress coalescing plus planning/collecting/syncing boundaries;
- complete only after successful incremental sync and fail on sync failure;
- Realtime wakeup, disconnect/reconnect, 30-second reconciliation, graceful stop,
  and channel cleanup;
- health heartbeat aging and sanitized logging; and
- systemd/install/smoke checks while the new unit is disabled.

### Web

- the control appears only with a fresh running manual-worker heartbeat;
- one press enqueues the normalized route/month and adopts a deduplicated row;
- queued/running/syncing/complete/failed/expired transitions drive the correct
  spinner, progress, and floating notification behavior;
- no inline report/status text is rendered and no `reports` prop remains;
- notifications remain accessible after removal of the inline live region;
- completion invalidates the exact query families once, after terminal sync;
- polling recovers a missed Realtime update without duplicate side effects;
- page reload adopts active progress, while only tab-adopted requests notify;
- malformed progress/result fails safely; and
- subscription, timers, and listeners are removed on unmount.

The final branch verification includes formatting, lint, TypeScript, web tests,
production web build, Python formatting/lint/typecheck/tests, Pi operation tests,
Supabase reset, pgTAP, generated types, diff review, and secret-hygiene checks.

## Rollout and activation gate

Merging or deploying code does not enable the worker. Production activation is a
separate coordinated operation:

1. apply and verify the additive Supabase migration and owner/RLS canaries;
2. deploy the web/API code while the health gate keeps the button absent;
3. install the new Pi service disabled and run its bounded one-shot/smoke checks;
4. verify the scheduled Airfare timer and Windows rollback state are unchanged;
5. enable/start only `edicius-airfare-requests.service` under the existing cutover
   authority;
6. prove a fresh `airfare-requests` heartbeat, operation isolation, and one sanitized
   canary request through collection, sync, completion, and browser refetch; and
7. capture commit, timestamps, request/run IDs, counts, unit state, and rollback
   availability without secrets or fare payloads.

The button appears naturally after the verified heartbeat. There is no separate
browser feature flag whose state could disagree with the worker.

## Rollback

Stop and disable `edicius-airfare-requests.service`. After at most 90 seconds its
heartbeat becomes stale and the web control disappears. Queued/running requests are
allowed to expire; they are not deleted or reassigned. The scheduled Pi Airfare timer,
local archive, Supabase replica, Windows rollback data, and existing Market worker
remain untouched.

The schema changes are additive and may remain during rollback. The web can be rolled
back independently because no legacy endpoint is removed. If a database rollback is
later required, it must first prove there are no active `airfare-route` rows; it must
not drop shared request data or restore the unsafe unscoped claim RPC.

## Rejected alternatives

- **Restore the old `/api/fares/collect` hook.** It would run collection on the API
  host, not the Pi, and would reintroduce SSE/live-cache behavior that predates the
  Supabase archive authority.
- **Call the Pi directly from the browser.** It would require exposing a residential
  device/inbound secret and couples work lifetime to network reachability.
- **Reuse the scheduled `airfare` run as manual-worker health.** A healthy timer does
  not prove a long-running request consumer exists; a separate collector value makes
  the button gate truthful.
- **Claim first, then wait for the Airfare lock.** It would show a running request
  whose provider work has not begun and could expire while merely waiting behind the
  timer.
- **Let every worker claim every request and reject unknown operations.** That turns
  normal cross-worker races into user-visible failures and can starve the correct
  worker.
- **Mark complete before synchronization and refetch optimistically.** The browser
  could refetch stale Supabase data and reproduce the current “spinner ended, charts
  did not change” failure.
- **Keep the inline row sentence as an accessibility duplicate.** The user explicitly
  requested its removal. The progress element and floating notifications assume its
  announcement responsibilities instead.
