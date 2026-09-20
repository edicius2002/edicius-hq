# Pi-backed manual Airfare requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the per-route Airfare refresh control by sending owner-scoped requests through Supabase to a dedicated Raspberry Pi worker, while preserving spinner/progress/toasts and removing only the inline row status text.

**Architecture:** Extend the shared request queue with an operation-scoped Airfare protocol and a dedicated Pi worker that acquires the Airfare process lock before claim, performs one forced route/month pass, syncs the local archive, then settles the request. The web hook observes that queue through Realtime plus polling, renders request progress, and invalidates Supabase-backed Airfare queries only after synchronized completion.

**Tech Stack:** PostgreSQL/Supabase migrations and pgTAP, Python 3.12+/pytest/httpx/supabase-py/systemd, React 19/TypeScript/TanStack Query/Vitest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-19-pi-airfare-manual-requests-design.md`

## Global Constraints

- Work only on `feat/pi-airfare-manual-requests` in the existing linked worktree.
- Do not enable/deploy Pi units, change Windows task state, apply hosted migrations, push, merge, or delete retained data.
- The Pi-local Airfare archive remains write authority; the browser reads its Supabase replica.
- Acquire `exclusive_process_lock("airfare")` before claiming an Airfare request.
- Realtime is latency only; worker and browser polling are required recovery paths.
- A request is complete only after `sync_completed_pass(...)` returns `True`.
- Browser error text is fixed/sanitized; no provider messages, paths, HTML, cookies, keys, or exceptions cross the queue.
- Follow RED → GREEN → REFACTOR for every production behavior and make focused commits.

## Review Focus

- A queued request waiting behind the scheduled process lock must remain queued and later run, rather than being claimed/expired as fake running work; Task 3 tests this contention.
- Two tabs enqueueing the same owner/route/month/currency must converge on one active row; Task 1 exercises the unique/RPC race contract.
- A worker death after local collection but before terminal cloud write must not cause automatic duplicate acquisition; Tasks 1 and 3 test expiry and no reclaim.
- Realtime events may arrive before initial reconciliation or twice; Tasks 5 and 6 test idempotent adoption and one terminal refetch/notification.
- Removing the inline live region must not make progress and failures inaccessible; Task 6 tests progress semantics and live/alert notifications.

---

### Task 1: Supabase Airfare request protocol

**Files:**

- Create: `supabase/migrations/20260919000001_airfare_manual_requests.sql`
- Modify: `supabase/tests/collector_data_plane.sql`
- Modify: `apps/web/src/shared/supabase/database.types.ts`

**Interfaces:**

- Produces: `enqueue_airfare_route_request(text,text,text,text) -> collector_requests`
- Produces: `claim_collector_request(uuid,text[]) -> collector_requests`
- Produces: `update_collector_request_progress(uuid,jsonb) -> collector_requests`
- Produces: `collector_requests.progress`, `collector_requests.updated_at`, operation `airfare-route`, collector `airfare-requests`

- [ ] **Step 1: Add failing pgTAP assertions for schema, privileges, validation, deduplication, claims, progress, and expiry**

Extend `collector_data_plane.sql` with assertions shaped as follows, including role switches already used by that file:

```sql
select has_column('public', 'collector_requests', 'progress');
select has_column('public', 'collector_requests', 'updated_at');
select function_privs_are('public', 'enqueue_airfare_route_request', array['text','text','text','text'],
  'authenticated', array['EXECUTE']);
select function_privs_are('public', 'claim_collector_request', array['uuid','text[]'],
  'service_role', array['EXECUTE']);

select lives_ok($$ select public.enqueue_airfare_route_request('LIM','CUZ','2026-11','USD') $$);
select is(
  (select count(*) from public.collector_requests where operation = 'airfare-route'),
  1::bigint,
  'identical enqueue returns one active request'
);
select is(
  (public.claim_collector_request(:'owner_id', array['market-bars','market-search'])).request_id,
  null::uuid,
  'market cannot claim airfare'
);
```

Also assert invalid IATA/month/currency rejection, anonymous/cross-owner denial, direct authenticated Airfare insert denial, Market direct insert retention, 30-minute Airfare TTL, five-minute Market TTL, monotonic progress, late terminal rejection, and that duplicate active rows cannot be inserted.

- [ ] **Step 2: Run the database test to verify RED**

Run: `npx supabase test db supabase/tests/collector_data_plane.sql`

Expected: FAIL because the new columns/functions/operation do not exist.

- [ ] **Step 3: Implement the additive migration**

The migration must drop/recreate the operation and collector checks, add the two columns, replace the insert policy, add the partial unique expression index, replace the unsafe claim overload, and define/grant the RPCs. The enqueue core is:

```sql
insert into public.collector_requests (
  owner_id, operation, payload, expires_at
) values (
  v_owner,
  'airfare-route',
  jsonb_build_object('origin', v_origin, 'destination', v_destination,
                     'month', v_month, 'currency', v_currency),
  now() + interval '30 minutes'
)
on conflict do nothing
returning * into v_request;

if v_request.request_id is null then
  select * into v_request
  from public.collector_requests
  where owner_id = v_owner and operation = 'airfare-route'
    and payload = jsonb_build_object('origin', v_origin, 'destination', v_destination,
                                     'month', v_month, 'currency', v_currency)
    and status in ('queued', 'running') and expires_at > now();
end if;
```

Claim filters with `operation = any(p_operations)` inside the existing `FOR UPDATE SKIP LOCKED` subquery. Progress validates exact keys/types, stage order `queued < collecting < syncing`, nondecreasing `completed`, stable/nondecreasing total, and updates only an unexpired running Airfare row. Every lifecycle mutation updates `updated_at`.

- [ ] **Step 4: Regenerate or accurately update Supabase types**

Add the new columns, operation-compatible row types, and RPC argument/return declarations to `database.types.ts`; generated JSON remains the existing `Json` type.

- [ ] **Step 5: Run database tests and typecheck to verify GREEN**

Run: `npx supabase test db supabase/tests/collector_data_plane.sql`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260919000001_airfare_manual_requests.sql supabase/tests/collector_data_plane.sql apps/web/src/shared/supabase/database.types.ts
git commit -m "feat: add Airfare collector request protocol"
```

### Task 2: Operation-scoped collector cloud client

**Files:**

- Modify: `services/api/app/services/collector_cloud.py`
- Modify: `services/api/tests/test_collector_cloud.py`
- Modify: `services/api/app/services/market_worker.py`
- Modify: `services/api/tests/test_market_worker.py`

**Interfaces:**

- Consumes: Task 1 RPC signatures and operation names.
- Produces: `CollectorCloud.claim_request(operations: Collection[str])`
- Produces: `CollectorCloud.update_request_progress(request_id: UUID, progress: Mapping[str, Any])`

- [ ] **Step 1: Write failing client tests**

Add tests that call:

```python
request = cloud.claim_request(("airfare-route",))
assert captured_json == {
    "p_owner_id": str(secret_config.owner_id),
    "p_operations": ["airfare-route"],
}

cloud.update_request_progress(
    request_id,
    {"stage": "collecting", "completed": 3, "total": 31},
)
```

Assert empty/duplicate/unknown operation sets and malformed progress are rejected before HTTP, and returned operations outside the requested set are rejected. Update Market tests to expect exactly `("market-bars", "market-search")`.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npm run api:test -- services/api/tests/test_collector_cloud.py services/api/tests/test_market_worker.py`

Expected: FAIL on missing arguments/method and old Market claim call.

- [ ] **Step 3: Implement the minimal allowlisted boundary**

Use fixed constants:

```python
_OPERATIONS = frozenset({"market-bars", "market-search", "airfare-route"})
_PROGRESS_STAGES = frozenset({"queued", "collecting", "syncing"})

def claim_request(self, operations: Collection[str]) -> CollectorRequest | None:
    allowed = tuple(dict.fromkeys(operations))
    if not allowed or len(allowed) != len(tuple(operations)) or any(op not in _OPERATIONS for op in allowed):
        raise CollectorCloudRejected("invalid collector request operations")
    result = self._rpc("claim_collector_request", {
        "p_owner_id": str(self._owner_id), "p_operations": list(allowed)
    })
```

Validate progress locally, add the RPC allowlist entry, and change Market to call the scoped method. Do not broaden table access.

- [ ] **Step 4: Run focused and full API suites to verify GREEN**

Run: `npm run api:test -- services/api/tests/test_collector_cloud.py services/api/tests/test_market_worker.py`

Expected: PASS.

Run: `npm run api:test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/api/app/services/collector_cloud.py services/api/app/services/market_worker.py services/api/tests/test_collector_cloud.py services/api/tests/test_market_worker.py
git commit -m "refactor: scope collector request claims"
```

### Task 3: Airfare request worker domain service

**Files:**

- Create: `services/api/app/services/airfare_request_worker.py`
- Create: `services/api/tests/test_airfare_request_worker.py`

**Interfaces:**

- Consumes: `CollectorCloud.claim_request(("airfare-route",))`, progress/terminal methods, `FareWatch`, `expand`, `collect`, `sync_completed_pass`, `PassRecorder`, and an injected process-lock factory.
- Produces: `AirfareRequestWorker.reconcile_once() -> bool`, `wake_requests()`, `run(stop_event, cycle_completed)`.

- [ ] **Step 1: Write failing validation and settlement tests**

Define tests around an injected fake cloud and collector:

```python
worker = AirfareRequestWorker(cloud, collect_route=collect_route, sync_pass=sync_pass)
assert await worker.reconcile_once() is True
cloud.complete_request.assert_called_once_with(request.id, {
    "origin": "LIM", "destination": "CUZ", "month": "2026-11",
    "lookedAt": 30, "changed": 2, "failed": 0, "skipped": 0, "synced": True,
})
```

Cover exact payload validation, rejected departed/out-of-horizon month, collection failure, truncation, sync false/exception, safe error codes, and completion only after sync.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run api:test -- services/api/tests/test_airfare_request_worker.py`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement payload/result and one-request service**

Implement a frozen `AirfareRouteRequest`, `parse_airfare_request`, bounded result conversion, and `serve_request`. Use one `FareWatch`, `expand([watch])`, forced `collect`, and `PassRecorder(source="ui", kind="board", gap=REQUEST_GAP_SECONDS)`. The progress observer mutates an in-memory snapshot only; an async coalescer sends at most once per two seconds and always sends stage boundaries.

- [ ] **Step 4: Add failing lock-before-claim and lifecycle tests**

Tests must prove:

```python
with pytest.raises(ProcessLockUnavailable):
    await worker.reconcile_once()
cloud.claim_request.assert_not_called()
```

Also cover claim-until-empty while one process lock is held, 30-second wake timeout, explicit wake, stop, progress coalescing, and no automatic reclaim of a running row.

- [ ] **Step 5: Run the new tests to verify RED**

Run: `npm run api:test -- services/api/tests/test_airfare_request_worker.py`

Expected: FAIL on missing lock/lifecycle behavior.

- [ ] **Step 6: Implement locking and run loop**

`reconcile_once` attempts the injected `exclusive_process_lock("airfare")` before any claim. Lock contention returns a healthy reconciliation with no claim and bounded backoff. `run` mirrors Market's wake-or-stop loop and calls the heartbeat callback only after a successful Supabase reconciliation.

- [ ] **Step 7: Run focused and full API suites to verify GREEN**

Run: `npm run api:test -- services/api/tests/test_airfare_request_worker.py`

Expected: PASS.

Run: `npm run api:test`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add services/api/app/services/airfare_request_worker.py services/api/tests/test_airfare_request_worker.py
git commit -m "feat: process manual Airfare requests on Pi"
```

### Task 4: Worker command and disabled Pi service

**Files:**

- Create: `scripts/airfare-request-worker.py`
- Create: `services/api/tests/test_airfare_request_worker_command.py`
- Create: `ops/pi/systemd/edicius-airfare-requests.service`
- Modify: `package.json`
- Modify: `scripts/api.mjs`
- Modify: `ops/pi/install.sh`
- Modify: `ops/pi/verify.sh`
- Modify: `ops/pi/smoke-collector.py`
- Modify: `ops/pi/tests/test_units.py`
- Modify: `ops/pi/tests/test_smoke_collector.py`

**Interfaces:**

- Consumes: Task 3 worker and existing Market command subscription pattern.
- Produces: `npm run airfare:worker`, systemd unit `edicius-airfare-requests.service`, collector run `airfare-requests`.

- [ ] **Step 1: Write failing command and operations tests**

Add command tests equivalent to Market's for owner-filtered insert subscription, join acknowledgement, reconnect/backoff, polling, `--once`, post-reconcile heartbeat, sanitized failure, and cleanup. Extend Pi tests to require the new unit, script mapping, hardening, install copy, verify inclusion, and disabled-by-default behavior.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npm run api:test -- services/api/tests/test_airfare_request_worker_command.py && npm run api:test -- ops/pi/tests/test_units.py ops/pi/tests/test_smoke_collector.py`

Expected: FAIL because command/unit/integration entries are absent.

- [ ] **Step 3: Implement command and unit**

Copy the proven Market Realtime supervisor structure, but instantiate `AirfareRequestWorker`, use channel `airfare-request-worker-requests`, begin run `airfare-requests`, and filter the owner. The unit uses `Type=simple`, `Restart=on-failure`, the existing environment/data directory/user/hardening, and is copied but never enabled by install.

- [ ] **Step 4: Update local command and Pi tooling**

Add `airfare-request-worker` dispatch in `scripts/api.mjs`, `"airfare:worker": "node scripts/api.mjs airfare-request-worker"`, the systemd file to install/verify, and an Airfare request-worker smoke selector. Do not add it to cutover auto-start.

- [ ] **Step 5: Run focused suites to verify GREEN**

Run: `npm run api:test -- services/api/tests/test_airfare_request_worker_command.py`

Expected: PASS.

Run: `npm run api:test -- ops/pi/tests/test_units.py ops/pi/tests/test_smoke_collector.py`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/airfare-request-worker.py services/api/tests/test_airfare_request_worker_command.py ops/pi/systemd/edicius-airfare-requests.service package.json scripts/api.mjs ops/pi/install.sh ops/pi/verify.sh ops/pi/smoke-collector.py ops/pi/tests/test_units.py ops/pi/tests/test_smoke_collector.py
git commit -m "feat: package Airfare request worker for Pi"
```

### Task 5: Web request data and worker health

**Files:**

- Create: `apps/web/src/features/airfare/data/airfareRequests.ts`
- Create: `apps/web/src/features/airfare/data/airfareRequests.test.ts`
- Modify: `apps/web/src/features/airfare/data/collectorStatus.ts`
- Modify: `apps/web/src/features/airfare/data/collectorStatus.test.tsx`

**Interfaces:**

- Consumes: Task 1 queue/RPC/types.
- Produces: `enqueueAirfareRequest`, `fetchActiveAirfareRequests`, `fetchAirfareRequest`, `subscribeAirfareRequests`, decoders, and `useAirfareRequestWorkerStatus`.

- [ ] **Step 1: Write failing request-boundary tests**

Test normalized RPC arguments, strict row/progress/result decoding, active-operation/status filters, owner-safe Realtime subscription, terminal polling reads, and disposer cleanup:

```typescript
await enqueueAirfareRequest({
  origin: 'lim',
  destination: 'cuz',
  month: '2026-11',
  currency: 'usd',
});
expect(rpc).toHaveBeenCalledWith('enqueue_airfare_route_request', {
  p_origin: 'LIM',
  p_destination: 'CUZ',
  p_month: '2026-11',
  p_currency: 'USD',
});
```

- [ ] **Step 2: Run data tests to verify RED**

Run: `npm test -w web -- src/features/airfare/data/airfareRequests.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the data boundary**

Return domain rows only after runtime validation. Realtime is a callback surface, not a promise owner. Polling callers use request ID or active operation/status filters. Map all database errors to fixed `AirfareRequestError` codes.

- [ ] **Step 4: Add failing worker-health tests**

Test that health is true only for `status=running`, `heartbeat_at > started_at`, and heartbeat age `<= 90_000` at an injected clock. Test stale, terminal, equal startup heartbeat, malformed timestamps, Realtime invalidation, polling, and channel cleanup.

- [ ] **Step 5: Run health tests to verify RED**

Run: `npm test -w web -- src/features/airfare/data/collectorStatus.test.tsx`

Expected: FAIL on absent manual-worker query/health helper.

- [ ] **Step 6: Implement manual worker status without changing scheduled status**

Add a separate query key `['collector-runs','airfare-requests']`, select `started_at,heartbeat_at,status`, subscribe with `collector=eq.airfare-requests`, poll every 30 seconds, and export a pure `airfareRequestWorkerHealthy(run, now)` helper. Preserve `airfaresStatusText` for scheduled `airfare`.

- [ ] **Step 7: Run web data tests and typecheck to verify GREEN**

Run: `npm test -w web -- src/features/airfare/data/airfareRequests.test.ts src/features/airfare/data/collectorStatus.test.tsx`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/airfare/data/airfareRequests.ts apps/web/src/features/airfare/data/airfareRequests.test.ts apps/web/src/features/airfare/data/collectorStatus.ts apps/web/src/features/airfare/data/collectorStatus.test.tsx
git commit -m "feat: add Airfare request web boundary"
```

### Task 6: Restore button, progress, notifications, and synchronized refetch

**Files:**

- Modify: `apps/web/src/features/airfare/hooks/useRouteCollection.ts`
- Modify: `apps/web/src/features/airfare/hooks/useRouteCollection.test.tsx`
- Modify: `apps/web/src/features/airfare/lib/collectNotice.ts`
- Modify: `apps/web/src/features/airfare/lib/collectNotice.test.ts`
- Modify: `apps/web/src/features/airfare/ui/CollectNotices.tsx`
- Modify: `apps/web/src/features/airfare/ui/CollectNotices.test.tsx`
- Modify: `apps/web/src/features/airfare/ui/RouteList.tsx`
- Modify: `apps/web/src/features/airfare/ui/RouteList.test.tsx`
- Modify: `apps/web/src/features/airfare/AirfarePage.tsx`
- Create: `apps/web/src/features/airfare/AirfarePage.test.tsx`

**Interfaces:**

- Consumes: Task 5 request data/status APIs.
- Produces: route-keyed `collecting`, `progress`, accessible `notices`, `collect`, and `forget`; no `reports`.

- [ ] **Step 1: Replace retired-hook tests with failing queue lifecycle tests**

Test enqueue/adoption, initial active reconciliation, queued indeterminate state, determinate collecting state, full syncing state, duplicate event idempotence, polling recovery, failed/expired safe notices, exact successful invalidations, route forget, and cleanup. Assert success invalidations exactly once:

```typescript
expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['fares', 'history', 'LIM', 'CUZ'] });
expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['fares', 'calendar', 'LIM', 'CUZ'] });
expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['fares', 'airports'] });
expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['collector-runs', 'airfare'] });
expect(invalidateQueries).toHaveBeenCalledWith({
  queryKey: ['collector-runs', 'airfare-requests'],
});
```

- [ ] **Step 2: Run hook tests to verify RED**

Run: `npm test -w web -- src/features/airfare/hooks/useRouteCollection.test.tsx`

Expected: FAIL because the hook is still a stub.

- [ ] **Step 3: Implement the minimal queue-backed hook**

Use one subscription and a 5-second terminal/active reconciliation timer, request maps keyed by request ID, a tab-adopted ID set, and a handled-terminal set. Derive `PassProgress` with `polling=total` and clamped fraction. Accepted/complete/fail/expire notices use fixed copy and request IDs. No legacy API/SSE imports or optimistic snapshots.

- [ ] **Step 4: Write failing component/accessibility tests**

Assert `RouteList` no longer accepts/renders report text, retains button/spinner/progress, exposes determinate/indeterminate progress semantics, and `CollectNotices` uses polite status for accepted/success and alert for failure/expiry without `aria-hidden`. Assert `AirfarePage` passes `onCollect` only for fresh manual-worker health and keeps scheduled status text.

- [ ] **Step 5: Run component tests to verify RED**

Run: `npm test -w web -- src/features/airfare/ui/RouteList.test.tsx src/features/airfare/ui/CollectNotices.test.tsx src/features/airfare/AirfarePage.test.tsx`

Expected: FAIL on inline report/hidden notices/missing health-gated callback.

- [ ] **Step 6: Implement component wiring and remove only inline text**

Remove `reports` from the hook contract/page/list and remove the row `<p>`. Keep `CollectMark`, button, bar, scheduled global status, and toast stack. Add progress `role="progressbar"`, route/month label, `aria-valuemin/max`, and determinate `aria-valuenow`; throttle textual progress announcements in the hook rather than rendering row status. Wire the health-gated `onCollect` in `AirfarePage`.

- [ ] **Step 7: Run focused and full web suites to verify GREEN**

Run: `npm test -w web -- src/features/airfare/hooks/useRouteCollection.test.tsx src/features/airfare/ui/RouteList.test.tsx src/features/airfare/ui/CollectNotices.test.tsx src/features/airfare/AirfarePage.test.tsx`

Expected: PASS.

Run: `npm test`

Expected: PASS.

Run: `npm run typecheck && npm run lint && npm run build`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/airfare/hooks/useRouteCollection.ts apps/web/src/features/airfare/hooks/useRouteCollection.test.tsx apps/web/src/features/airfare/lib/collectNotice.ts apps/web/src/features/airfare/lib/collectNotice.test.ts apps/web/src/features/airfare/ui/CollectNotices.tsx apps/web/src/features/airfare/ui/CollectNotices.test.tsx apps/web/src/features/airfare/ui/RouteList.tsx apps/web/src/features/airfare/ui/RouteList.test.tsx apps/web/src/features/airfare/AirfarePage.tsx apps/web/src/features/airfare/AirfarePage.test.tsx
git commit -m "feat: restore Pi-backed Airfare refresh control"
```

### Task 7: Runbook, complete verification, and release-disabled handoff

**Files:**

- Modify: `docs/pi-collectors-runbook.md`
- Modify: `ops/pi/tests/test_runbooks.py`
- Modify: `docs/IMPLEMENTATION_PLAN.md`

**Interfaces:**

- Consumes: all prior task commands/unit/health behavior.
- Produces: operator instructions that install disabled, verify one request, activate explicitly, and roll back only the new unit.

- [ ] **Step 1: Write failing runbook assertions**

Require the runbook to name `edicius-airfare-requests.service`, prove disabled install, post-start heartbeat, one manual canary, request completion after sync, stale-health disappearance, and rollback stop/disable without touching the scheduled timer.

- [ ] **Step 2: Run runbook tests to verify RED**

Run: `npm run api:test -- ops/pi/tests/test_runbooks.py`

Expected: FAIL because the new operational sequence is undocumented.

- [ ] **Step 3: Document the disabled activation gate and decision record**

Add exact commands for install/verify/status/journal/manual canary/stop-disable. State explicitly that this branch does not execute those commands against the Pi or hosted Supabase. Add one dated implementation-plan decision summarizing the restored control and operation isolation.

- [ ] **Step 4: Run runbook tests to verify GREEN**

Run: `npm run api:test -- ops/pi/tests/test_runbooks.py`

Expected: PASS.

- [ ] **Step 5: Run the complete local verification matrix**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run lint:api
npm run typecheck:api
npm run api:test
npx supabase db reset
npx supabase test db
git diff --check
```

Expected: every command PASS. If local Docker/Supabase prerequisites are unavailable, record the exact blocked command and do not claim that database verification passed.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/pi-collectors-runbook.md ops/pi/tests/test_runbooks.py docs/IMPLEMENTATION_PLAN.md
git commit -m "docs: add Airfare request worker activation gate"
```

- [ ] **Step 7: Verify release remains inactive**

Run read-only repository checks confirming no cutover script auto-starts the new unit and `git status --short` contains only the known pre-existing untracked operational files. Do not contact or mutate the Pi.
