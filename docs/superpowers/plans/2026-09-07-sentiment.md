# Sentiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a session-gated `/sentiment` page with CNN's composite Fear & Greed index and all seven indicator charts.

**Architecture:** FastAPI fetches and strictly normalizes CNN's undocumented JSON into one atomic, disk-cached snapshot. React reads only the normalized endpoint through TanStack Query and renders one accessible SVG chart component eight times.

**Tech Stack:** Python 3.12, FastAPI, httpx, dataclasses/Pydantic, pytest; React 19, TypeScript 7, TanStack Query, SVG, CSS Modules, Vitest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-07-sentiment-design.md`

## Global Constraints

- The feature is an independent top tab and route `/sentiment`; it does not render inside Investing.
- Use `https://production.dataviz.cnn.io/index/fearandgreed/graphdata` first without browser impersonation or access-control bypass; on 403/418 only, use and attribute the public no-key Fear & Greed Graph JSON mirror.
- Cache successful snapshots for 4 hours and allow explicitly marked stale fallback for at most 7 days.
- Version synthetic fixtures only; never version live CNN payloads or secrets.
- Render exactly eight accessible charts and disable crosshair easing under reduced motion.
- Use existing palette, Berkeley Mono, CSS Modules, and the 640px narrow-screen convention.
- Keep the router behind `require_session_gate` and do not use hardware acceleration.

---

### Task 1: Typed CNN adapter

**Files:**

- Create: `services/api/app/adapters/sentiment_models.py`
- Create: `services/api/app/adapters/cnn_sentiment.py`
- Create: `services/api/tests/fixtures/cnn_sentiment_synthetic.json`
- Create: `services/api/tests/test_sentiment_adapter.py`

**Interfaces:**

- Produces: `async fetch_sentiment(client: httpx.AsyncClient) -> SentimentSnapshot`
- Produces: `parse_sentiment(payload: object, *, fetched_at: datetime) -> SentimentSnapshot`
- Produces immutable `SentimentPoint`, `SentimentSeries`, `SentimentMetric`, and `SentimentSnapshot` dataclasses with `to_wire()` / `from_wire()`.

- [ ] **Step 1: Write adapter tests before production code**

```python
def test_normalizes_all_eight_metrics_and_reference_lines(synthetic_payload):
    snapshot = parse_sentiment(synthetic_payload, fetched_at=FETCHED_AT)
    assert [metric.key for metric in snapshot.indicators] == EXPECTED_KEYS
    assert [series.key for series in snapshot.indicators[0].series] == [
        "sp500", "sp500_125_day_average"
    ]

@pytest.mark.parametrize("mutation", ["missing_metric", "nan_score", "bad_rating", "empty_history"])
def test_rejects_an_incomplete_snapshot(synthetic_payload, mutation):
    broken = mutate_fixture(synthetic_payload, mutation)
    with pytest.raises(SentimentPayloadError):
        parse_sentiment(broken, fetched_at=FETCHED_AT)
```

- [ ] **Step 2: Run `pytest -q tests/test_sentiment_adapter.py` from `services/api`; verify missing imports fail.**
- [ ] **Step 3: Implement strict parsing, UTC timestamps, sorted/deduplicated points, unit metadata, timeout/status/JSON error mapping, and honest `Accept: application/json`.**
- [ ] **Step 4: Re-run the adapter tests and all API adapter tests; keep output green.**
- [ ] **Step 5: Commit `feat(api): add CNN sentiment adapter`.**

### Task 2: Persistent cadence and stale cache

**Files:**

- Modify: `services/api/app/config.py`
- Create: `services/api/app/services/sentiment_cache.py`
- Create: `services/api/tests/test_sentiment_cache.py`

**Interfaces:**

- Produces: `SENTIMENT_TTL_SECONDS = 4 * 60 * 60`, `MAX_STALE_SENTIMENT_SECONDS = 7 * 24 * 60 * 60`, and `sentiment_dir() -> Path`.
- Produces: `async SentimentCache.fetch(factory) -> tuple[SentimentSnapshot, bool]`, where the boolean is stale.

- [ ] **Step 1: Write failing tests for fresh reuse, four-hour expiry, atomic persistence across instances, corrupt-file misses, coalesced concurrent refreshes, bounded stale fallback, and no stale fallback for malformed payloads.**

```python
snapshot, stale = asyncio.run(cache.fetch(factory))
assert stale is False
assert calls == 1
os.utime(cache.path, (expired, expired))
snapshot, stale = asyncio.run(cache.fetch(refusing_factory))
assert stale is True
```

- [ ] **Step 2: Run `pytest -q tests/test_sentiment_cache.py`; verify the cache module is missing.**
- [ ] **Step 3: Implement one atomic JSON file, mtime-based TTL/maximum age, an asyncio coalescer, and typed transient-vs-payload failure handling.**
- [ ] **Step 4: Re-run cache and adapter tests.**
- [ ] **Step 5: Commit `feat(api): cache sentiment snapshots`.**

### Task 3: Session-gated FastAPI endpoint

**Files:**

- Create: `services/api/app/routers/sentiment.py`
- Modify: `services/api/app/main.py`
- Create: `services/api/tests/test_sentiment_router.py`
- Modify: `services/api/tests/test_gate.py`

**Interfaces:**

- Produces: `GET /api/sentiment` with the exact `SentimentSnapshot` wire contract and `stale` flag.
- Consumes: `fetch_sentiment()` and `SentimentCache.fetch()`.

- [ ] **Step 1: Write endpoint tests for normalized success, stale success, timeout/418/429/invalid-payload status mapping, and 401 without a session.**

```python
response = client.get("/api/sentiment", headers=auth_header)
assert response.status_code == 200
assert len(response.json()["indicators"]) == 7
assert response.json()["stale"] is False
```

- [ ] **Step 2: Run `pytest -q tests/test_sentiment_router.py tests/test_gate.py`; verify route failures.**
- [ ] **Step 3: Add Pydantic wire models, exception mapping, a module cache/client lifecycle, and mount the router with `GATED`; close its client during application lifespan.**
- [ ] **Step 4: Re-run endpoint/gate tests and `pytest -q`.**
- [ ] **Step 5: Commit `feat(api): expose sentiment snapshot`.**

### Task 4: Shared crosshair geometry

**Files:**

- Create: `apps/web/src/shared/lib/chartCrosshair.ts`
- Create: `apps/web/src/shared/lib/chartCrosshair.test.ts`
- Modify: `apps/web/src/features/airfare/lib/crosshair.ts`
- Modify imports in `apps/web/src/features/airfare/ui/PriceBandChart.tsx`, `apps/web/src/features/airfare/ui/DepartureChart.tsx`, and `apps/web/src/features/greenlight/ui/CompoundCurve.tsx`

**Interfaces:**

- Produces: `pointerInView(box, view, clientX, clientY) -> {x, y} | null` and `nearestPointIndex(points, timestamp) -> number` from `shared/lib/chartCrosshair`.

- [ ] **Step 1: Copy the existing letterbox/pillarbox behavioral tests to the shared module and add failing nearest-index tie/boundary tests.**
- [ ] **Step 2: Run the shared and existing crosshair tests; verify the new import fails.**
- [ ] **Step 3: Move only the pure geometry into `shared/lib`, re-export where compatibility is useful, and update feature imports without changing behavior.**
- [ ] **Step 4: Run all Airfare, Greenlight, and shared crosshair tests.**
- [ ] **Step 5: Commit `refactor(web): share chart crosshair geometry`.**

### Task 5: Typed web client and eight-chart component

**Files:**

- Create: `apps/web/src/shared/api/sentiment.ts`
- Create: `apps/web/src/shared/api/sentiment.test.ts`
- Create: `apps/web/src/features/sentiment/hooks/useSentiment.ts`
- Create: `apps/web/src/features/sentiment/lib/chart.ts`
- Create: `apps/web/src/features/sentiment/lib/chart.test.ts`
- Create: `apps/web/src/features/sentiment/ui/SentimentChart.tsx`
- Create: `apps/web/src/features/sentiment/ui/SentimentChart.module.css`
- Create: `apps/web/src/features/sentiment/ui/SentimentChart.test.tsx`

**Interfaces:**

- Produces: `getSentiment(signal?) -> Promise<SentimentResponse>` and `useSentiment()` with 4-hour `staleTime`.
- Produces: `SentimentChart({ metric }: { metric: SentimentMetric })` with pointer/keyboard selection and data table.

- [ ] **Step 1: Write failing client and pure-layout tests for contract preservation, finite domains, single-point domains, line paths, aligned reference lines, nearest timestamps, and human-readable units.**
- [ ] **Step 2: Run focused tests; verify missing modules fail.**
- [ ] **Step 3: Implement typed client/hook and chart math.**
- [ ] **Step 4: Write failing component tests for labelled axes/legend, SVG path count, pointer crosshair, Arrow/Home/End navigation, live readout, table disclosure, touch-safe surface, and empty series.**
- [ ] **Step 5: Implement responsive SVG chart, animated transform group, tooltip/readout, and table; add `@media (prefers-reduced-motion: reduce) { .crosshair { transition: none; } }`.**
- [ ] **Step 6: Re-run chart/client tests and commit `feat(web): add accessible sentiment charts`.**

### Task 6: Page states, navigation, and router

**Files:**

- Create: `apps/web/src/features/sentiment/SentimentPage.tsx`
- Create: `apps/web/src/features/sentiment/SentimentPage.module.css`
- Create: `apps/web/src/features/sentiment/SentimentPage.test.tsx`
- Modify: `apps/web/src/app/layout/TopNav.tsx`
- Modify: `apps/web/src/app/layout/TopNav.test.tsx`
- Modify: `apps/web/src/app/router/routes.tsx`
- Modify: `apps/web/src/app/App.test.tsx`

**Interfaces:**

- Produces: lazy `/sentiment` route and sixth nav/drawer item.
- Consumes: `useSentiment()` and renders `SentimentChart` exactly eight times.

- [ ] **Step 1: Write failing tests for route arrival, six nav links, composite plus seven named indicators, loading, no-history empty, first-load error with Retry, stale warning/as-of timestamp, and mobile ordering.**
- [ ] **Step 2: Run focused page/nav/router tests; verify Sentiment is absent.**
- [ ] **Step 3: Implement the page with `PageHeader`, `Panel`, responsive two-to-one-column grid, metric score/rating labels, honest states, source attribution, and retry action.**
- [ ] **Step 4: Add lazy route/nav item and update shell fetch fixtures; re-run focused tests.**
- [ ] **Step 5: Commit `feat(web): add standalone sentiment page`.**

### Task 7: Decision log, operational docs, and release gates

**Files:**

- Modify: `docs/IMPLEMENTATION_PLAN.md`
- Modify: `docs/deploy-plan.md`
- Modify: `.env.example` only if the implementation introduces configuration

**Interfaces:**

- Records Sentiment as independent, marks INV-06/Pulse superseded without erasing history, documents the endpoint, 4-hour cadence, 7-day stale bound, storage location, and anti-bot limitation.

- [ ] **Step 1: Update current route tables/checklists and append a dated decision superseding 2.6; preserve the old row as historical context.**
- [ ] **Step 2: Run `npm run format`, `npm run format:api`, `npm run lint`, `npm run lint:api`, `npm run typecheck`, `npm run typecheck:api`, `npm test -- --run`, `npm run test:api`, and `npm run build`.**
- [ ] **Step 3: Fix only regressions attributable to this feature, adding a failing test before each behavioral fix; rerun every failed gate and then the full gate list.**
- [ ] **Step 4: Run `git diff --check`, inspect `git status --short`, and verify no live payload/cache/secret is tracked.**
- [ ] **Step 5: Commit `docs: record sentiment delivery`.**
- [ ] **Step 6: Push the branch and create a non-merged PR with source/cadence evidence, architecture, test output, limitations, and screenshots only if they can be produced without hardware acceleration.**
