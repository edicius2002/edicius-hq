# Implementation Plan and Decision Log

> **Status:** Finance complete. Investing under way — the data plane is in.
> **Last updated:** 2026-08-07
> **Review status:** INV-04, technical analysis, in review ([#45](https://github.com/edicius2002/edicius-hq/issues/45)).
> **Phase closure:** Delivery steps 0–5 complete, nothing deferred.
> **Next delivery:** INV-05, portfolio. One issue per slice, written before its work.

---

## Documentation Rule

This file is the repository’s source of truth for confirmed product decisions, implementation progress, scope changes, and technical rationale.

- Update it before starting a phase, when a decision changes, and when a phase is completed.
- Preserve prior decisions in the Decision Log; do not rewrite history.
- Repository content, issues, pull requests, commits, and user-facing application text are written in **English**.

---

## Repository and Delivery Workflow

| Item             | Value                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Repository       | [edicius2002/edicius-hq](https://github.com/edicius2002/edicius-hq) (private)                |
| Default branch   | `main`                                                                                       |
| Legacy reference | [ediciuscorp](https://github.com/edicius2002/ediciuscorp) — behavior only, not folder layout |
| Package manager  | **npm** (`package-lock.json` versioned)                                                      |
| Node             | **22** (`apps/web`)                                                                          |
| Python           | **3.12** (`services/api`)                                                                    |
| Local DX         | **Docker Compose** (`web` + `api`, hot-reload)                                               |
| API data dir     | `services/api/.local-data/` (gitignored + Compose volume)                                    |
| Branches         | `chore/…`, `feat/…`, `fix/…`, `docs/…`                                                       |
| Commits          | Conventional Commits                                                                         |
| Merge            | Squash merge preferred                                                                       |
| Workflow         | Issue → branch → PR → checks → merge                                                         |

### Delivery sequence

| Order | Delivery                 | Scope                                                                                                                                       |
| ----- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | **Docs PR**              | Clean `README.md`, `NOTICE`, `.gitignore`, this plan; minimal GitHub templates if needed. No application scaffold.                          |
| 1     | **Initial Setup**        | Tooling only: workspaces, Vite/TS skeleton, FastAPI `/api/health`, lint/format/test/CI, Docker Compose. **No AppShell / no product pages.** |
| 2     | **Shell + placeholders** | Router, AppShell, sidebar (4 tabs), all pages as title + “Coming soon.”, NotFound, error boundaries.                                        |
| 3     | **API client + storage** | Typed `shared/api`, local KV facade, **TanStack Query** provider.                                                                           |
| 3b    | **UI foundation**        | Dark tokens (ediciuscorp), Berkeley Mono, shell migration, primitives `Button` / `Panel` / `PageHeader` / `Stat` (no Radix yet).            |
| 4     | **Greenlight**           | Full feature (replace Coming soon); adapt to UI foundation.                                                                                 |
| 5     | **Finance**              | Full feature (replace Coming soon).                                                                                                         |
| 6     | **Investing**            | Markets UI, quote bus, candle cache via API, charts; Pulse as extra panels on `/investing`.                                                 |
| 7     | **Cloud**                | Supabase Auth (magic link), RLS, deploy.                                                                                                    |
| 8     | **Cutover**              | Archive `ediciuscorp`.                                                                                                                      |

---

## Confirmed Folder Structure

Create folders only when they have an active responsibility. No empty placeholders. No generic `components/` directory.

```text
edicius-hq/
|-- apps/
|   `-- web/                         # React + TypeScript + Vite (Node 22)
|       `-- src/
|           |-- app/                 # Providers, router, shell (from Shell phase)
|           |-- features/
|           |-- shared/
|           `-- styles/
|-- services/
|   `-- api/                         # FastAPI (Python 3.12)
|       |-- .local-data/             # gitignored — bars cache + local KV
|       `-- app/
|           |-- routers/
|           |-- services/
|           `-- adapters/
|-- supabase/
|   `-- migrations/
|-- docs/
|   |-- IMPLEMENTATION_PLAN.md       # THIS FILE
|   `-- ADRs/
|-- examples/                        # Synthetic samples only (when needed)
|-- .github/
|   |-- ISSUE_TEMPLATE/
|   |-- PULL_REQUEST_TEMPLATE.md
|   `-- workflows/
|-- docker-compose.yml               # or compose.yml — Initial Setup
|-- package.json                     # npm workspaces root
|-- .env.example
|-- .gitignore
|-- NOTICE
|-- CONTRIBUTING.md
`-- README.md
```

### `apps/web/src`

```text
app/
|-- providers/
|-- router/
|-- layout/                 # AppShell, Sidebar
`-- App.tsx

features/
|-- dashboard/
|-- finance/
|-- greenlight/
`-- investing/
    |-- data/               # Quote bus, WS/poll (Investing phase)
    |-- chart/              # Hand-built candle chart (canvas)
    |-- pulse/              # Extra panels: Fear & Greed + Sentiment (not a route)
    `-- ui/

shared/
|-- api/                    # Typed FastAPI client
|-- auth/                   # Supabase (cloud phase)
|-- storage/                # User-data facade
|-- lib/
|-- types/
`-- ui/                     # Primitives (Radix later)

styles/
|-- fonts.css
|-- tokens.css
`-- reset.css
```

### Dependency rules

- `features/X` → may import `shared/*` and its own modules; must **not** import `features/Y`.
- `shared/*` must not import features.
- Market UI uses only `shared/api` (no raw Yahoo/CNN URLs in components).
- Named exports by default; `index.ts` only for deliberate public APIs.

---

## Product Baseline

Desktop-first web suite for personal finance and markets. Medium-term: cloud deploy with Supabase Auth (magic link) and RLS.

**Out of scope:** Status / local PC network monitoring; real brokerage; microservices; Next.js; public deploy without Auth + RLS.

### Tabs and routes

| Path          | Page             | Shell UI               | Later                                   |
| ------------- | ---------------- | ---------------------- | --------------------------------------- |
| `/`           | Redirect         | → `/dashboard`         | —                                       |
| `/dashboard`  | `DashboardPage`  | Title + “Coming soon.” | Optional hub widgets                    |
| `/finance`    | `FinancePage`    | Title + “Coming soon.” | Flow diagram (FIN-\*) — **built**       |
| `/greenlight` | `GreenlightPage` | Title + “Coming soon.” | CSV weekly analytics (GL-*) — **built** |
| `/investing`  | `InvestingPage`  | Title + “Coming soon.” | Markets + Pulse panels (INV-_, PULSE-_) |
| `*`           | `NotFoundPage`   | —                      | —                                       |

Sidebar: **Dashboard · Finance · Greenlight · Investing** only.

**Pulse** is not a tab or route. Fear & Greed and Sentiment are **additional Investing panels** under `features/investing/pulse/`, rendered on `/investing` only.

### Feature outcomes (post–Coming soon)

| Area                 | Outcome                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Finance              | Jobs, accounts, currencies, flows, frames, canvas, undo/redo, backup/restore, persistence             |
| Greenlight           | CSV import (EN UI; ES/EN header aliases OK), weekly summary, charts, persistence; no real CSVs in git |
| Investing            | Ticker, chart, TA, watchlist, heatmap, alerts, portfolio, etc.; data-plane rules apply                |
| Pulse (on Investing) | Fear & Greed composite + components + Sentiment panels                                                |

---

## Data Plane

Do not mix these traffics.

```text
A) User state     → Supabase (Auth + Postgres + RLS) and/or local KV
B) Market data    → FastAPI (+ optional public WS) + client memory
```

| Kind                                                                        | Store                                                                    | Notes                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| Watchlist, prefs, portfolio, alert **rules**, finance, greenlight, drawings | Path A                                                                   | Low frequency; RLS in cloud                          |
| Live quotes / ticks                                                         | Client quote bus (+ WS / API poll)                                       | In-memory hot path                                   |
| OHLCV / candle history                                                      | FastAPI cache under `services/api/.local-data/` (cloud: service storage) | Upstream Yahoo (or successor); not per-user Postgres |
| Live forming candle                                                         | Client chart memory                                                      | Ephemeral                                            |
| Fundamentals, Fear & Greed payloads                                         | FastAPI + short TTL cache                                                | Not user tables                                      |

**Quotes are not stored as a primary design in Supabase.**  
**TanStack Query:** HTTP/history; quote bus for streams. Added in **API client + storage** phase.

### Investing runtime (when built)

1. Load watchlist/prefs from storage facade.
2. Poll/subscribe market data for that set.
3. History via TanStack Query → API bar/quote endpoints.
4. Ticks update in-memory bus → UI/chart.
5. Alerts compare in-memory quotes to stored rules.

---

## Architecture Targets

### Shell (phase 2)

```text
AppErrorBoundary
`-- Router
    `-- AppShell
        |-- Sidebar
        `-- Outlet
            |-- DashboardPage
            |-- FinancePage
            |-- GreenlightPage
            |-- InvestingPage
            `-- NotFoundPage
```

### Styling

- CSS Modules (colocated), `camelCase` class names.
- Global CSS: `fonts.css` + reset + design tokens (dark ediciuscorp palette).
- Typeface: **Berkeley Mono** (commercial; self-host under `apps/web/public/fonts/`; binaries gitignored by default).
- Current primitives in `shared/ui` (no Radix yet): `Button`, `Panel`, `PageHeader`, `Stat`.
- Radix UI headless wrappers deferred until a later UI issue.
- Desktop-first; English copy only.
- `focus-visible` and `prefers-reduced-motion` where relevant.

### Quality

- TypeScript strict (`strict`, unused locals/parameters, no fallthrough).
- ESLint (TS, React Hooks, Refresh, a11y) + Prettier (`eslint-config-prettier`).
- Vitest + React Testing Library.
- CI on PR and `main`: `format:check`, `typecheck`, `lint`, `test`, `build`.
- No E2E, Commitlint, or mandatory coverage thresholds unless later justified.

```text
npm run format | format:check | typecheck | lint | lint:fix | test | test:watch | build
```

### Errors

| Source                      | Behavior                               | Phase          |
| --------------------------- | -------------------------------------- | -------------- |
| Unknown URL                 | `NotFoundPage` → dashboard             | Shell          |
| Route failure               | Route error page → retry / dashboard   | Shell          |
| React render failure        | `AppErrorBoundary` → retry / dashboard | Shell          |
| API / mutation / validation | Page-level or field-level recovery     | Feature phases |

### Configuration

- `.env.example` without secrets; `.env.local` gitignored.
- Shared env module when scaffolding web.
- Vite: React plugin, source aliases, Vitest when tests exist.
- No secrets in git or CI logs.

### Code conventions

- Components `PascalCase.tsx`; hooks `useCamelCase.ts`; utils `camelCase.ts`; folders `kebab-case`.
- Feature-specific deps (`d3-scale`, Supabase client, TanStack Query) only in their phases.

---

## Feature IDs

| ID          | Function                                                                            |
| ----------- | ----------------------------------------------------------------------------------- |
| SHELL-01…05 | Nav (4 tabs), desktop layout, branding, local/cloud indicator, storage facade usage |
| HOME-01…04  | `/` → `/dashboard`; Coming soon; richer hub later; English                          |
| FIN-01…10   | Finance diagram capabilities                                                        |
| GL-01…07    | Greenlight CSV / weekly analytics                                                   |
| INV-00      | Coming soon on Investing                                                            |
| INV-01…07   | Full markets — one per delivery slice, expanded below                               |
| PULSE-01…05 | Fear & Greed / Sentiment panels on `/investing`                                     |
| API-01…08   | Health, Yahoo/charts/fundamentals/market, storage KV                                |
| DATA-01…05  | Storage facade, allowlist, magic link, RLS, local without login                     |

---

## Phase Checklists

### 0 — Docs PR

**Status:** Complete ([PR #1](https://github.com/edicius2002/edicius-hq/pull/1)).

- [x] Clean rewrite: `README.md`, `NOTICE`, `.gitignore`, `docs/IMPLEMENTATION_PLAN.md`
- [x] Minimal issue/PR templates
- [x] Remove stale bootstrap clutter from the working tree
- [x] Open `docs/…` PR to `main`

### 1 — Initial Setup (tooling)

**Status:** Implementation complete on `chore/initial-setup` — issue [#3](https://github.com/edicius2002/edicius-hq/issues/3). Awaiting PR/merge.

- [x] npm workspaces + `apps/web` Vite/React/TS (Node 22)
- [x] `services/api` FastAPI + `/api/health` (Python 3.12)
- [x] Dockerfiles + Compose (`web`, `api`), hot-reload, volume → `services/api/.local-data/`
- [x] ESLint, Prettier, EditorConfig, quality scripts
- [x] Vitest smoke baseline
- [x] GitHub Actions CI
- [x] `.env.example`, `@/` aliases, README (`docker compose up`)
- [x] PR linked to Initial Setup issue — [#4](https://github.com/edicius2002/edicius-hq/pull/4)

**Out of scope:** AppShell, product pages, Radix chrome, TanStack Query, Supabase Auth, cloud deploy.

### 2 — Shell + placeholders

**Status:** Complete — [#5](https://github.com/edicius2002/edicius-hq/issues/5) / [#6](https://github.com/edicius2002/edicius-hq/pull/6).

- [x] Router, AppShell, sidebar (4 tabs)
- [x] All four pages: English **title + “Coming soon.”**
- [x] NotFoundPage, route error page, AppErrorBoundary
- [x] Tokens / reset / minimal `shared/ui` for shell
- [x] Nav / error smoke tests
- [x] PR linked to Shell issue — [#6](https://github.com/edicius2002/edicius-hq/pull/6)

### 3 — API client + storage

**Status:** Complete — [#7](https://github.com/edicius2002/edicius-hq/issues/7) / [#8](https://github.com/edicius2002/edicius-hq/pull/8).

- [x] Typed `shared/api` client (`/api/health`, `/api/kv/...`)
- [x] FastAPI local KV (allowlisted keys → `.local-data/kv/`)
- [x] `shared/storage` facade (path A)
- [x] TanStack Query provider + health query (`ApiStatus`)
- [x] Smoke tests (web + API)
- [x] PR linked to API client + storage issue — [#8](https://github.com/edicius2002/edicius-hq/pull/8)

### 3b — UI foundation

**Status:** Complete — [#10](https://github.com/edicius2002/edicius-hq/issues/10) / [#11](https://github.com/edicius2002/edicius-hq/pull/11).

- [x] Dark tokens aligned with ediciuscorp
- [x] Berkeley Mono self-host wiring + license docs
- [x] Shell / Coming soon / errors migrated
- [x] Primitives: `Button`, `Panel`, `PageHeader`, `Stat` (no Radix)
- [x] PR linked to UI foundation issue — [#11](https://github.com/edicius2002/edicius-hq/pull/11)

### 4 — Greenlight

**Status:** Complete — [#9](https://github.com/edicius2002/edicius-hq/issues/9) / [#12](https://github.com/edicius2002/edicius-hq/pull/12).

- [x] Replace Coming soon on `/greenlight`
- [x] CSV import (ES/EN aliases, Deliverable/Entregable only)
- [x] TimeRecords format support (`Date/Start` headers)
- [x] Replace modes: all + current-month (markers preserved)
- [x] Persist via `shared/storage` key `greenlight` (stats, meta, markers, widgets)
- [x] Totals: Gross + Fee 10% (AnyoneAI, min $1,000 per period) + Net
- [x] Weekly line chart + monthly bars + week cards (% of month)
- [x] Charts size to their container; weekly line keeps the legacy draw-in reveal
- [x] Markers between weeks + segment summaries (counted in calendar weeks)
- [x] Clear action; sample data and JSON export cut from the MVP (see 6.1)
- [x] Task counting removed from the product (see 6.2)
- [x] Tool subscription widgets, one per tool per month (see 6.3)
- [x] Synthetic CSV / aggregation / subscription tests (no real CSVs in git)
- [x] Adapted to UI foundation primitives / dark tokens
- [x] PR linked to Greenlight issue — [#12](https://github.com/edicius2002/edicius-hq/pull/12)

### 5 — Finance

**Status:** Complete, follow-ups included — [#14](https://github.com/edicius2002/edicius-hq/issues/14) / [#15](https://github.com/edicius2002/edicius-hq/pull/15). Domain model recorded in [ADR 0001](ADRs/0001-finance-cash-flow-domain-model.md), which held: every follow-up landed as an addition, and the one change to the persisted shape defaulted cleanly for documents stored before it.

- [x] Replace Coming soon on `/finance`
- [x] Jobs, accounts and holdings, created, edited, dragged and deleted
- [x] Flows drawn between holdings, with the connection rules as typed refusals
- [x] Fee chain: source out-fee then destination in-fee, each on the running amount
- [x] Available and In transit totals, no currency ever added to another
- [x] Account view: what its active holdings have left, plus in/out operation counts
- [x] Ownership drawn on the canvas as a tether, derived rather than stored
- [x] Persist via `shared/storage` key `finance`, in a shape that leaves room for more diagrams
- [x] Domain tested without React: document, fees, summary, transitions, geometry
- [x] PR linked to the Finance issue — [#15](https://github.com/edicius2002/edicius-hq/pull/15)

**Follow-up, delivered:** undo/redo and multiple diagrams — [#17](https://github.com/edicius2002/edicius-hq/issues/17) / [#18](https://github.com/edicius2002/edicius-hq/pull/18). Both landed without changing the persisted shape or rewriting anything, which is what ADR 0001 was betting on.

**Follow-up, delivered:** canvas zoom, pan and minimap as one camera — [#20](https://github.com/edicius2002/edicius-hq/issues/20) / [#21](https://github.com/edicius2002/edicius-hq/pull/21). The camera is a new concern rather than an extension of the domain, so it landed as its own module with the persisted shape untouched.

**Follow-up, delivered:** the canvas has no corner — the origin clamp on node positions is gone and content is measured in both directions — [#25](https://github.com/edicius2002/edicius-hq/issues/25) / [#26](https://github.com/edicius2002/edicius-hq/pull/26).

**Follow-up, delivered:** frames — [#24](https://github.com/edicius2002/edicius-hq/issues/24) / [#28](https://github.com/edicius2002/edicius-hq/pull/28). First change to the persisted `Diagram` since ADR 0001, and it landed as an addition: `normalizeDocument` defaults the new field and a document stored before it opens unchanged. The ADR's bet is now tested rather than assumed.

**Follow-up, delivered:** backup and restore — [#30](https://github.com/edicius2002/edicius-hq/issues/30) / [#31](https://github.com/edicius2002/edicius-hq/pull/31). The last piece of step 5, which is now complete with nothing deferred.

**Follow-up:** the drag gestures — decisions 7.22 and 7.23. Two faults, both found by measuring in a browser rather than by reading. Text was being selected mid-drag because only the nodes carried `user-select: none`, so a drag anchored a selection in the frame header it crossed; and every drag was drawn from the stored document, so the thing being moved trailed the pointer by a write and froze entirely when a write was slow. Across node drag, pan, frame move, frame resize, minimap drag, double- and triple-click, the selection is now empty in every case, while the properties panel, the diagram-tab rename and ordinary page text still select and edit normally.

### 6 — Investing

**Status:** Under way. Scope agreed 2026-08-06; decisions in section 8.

- [x] INV-01 — data plane ([#34](https://github.com/edicius2002/edicius-hq/issues/34))
- [x] INV-02 — chart ([#36](https://github.com/edicius2002/edicius-hq/issues/36))
- [x] INV-03 — watchlist and ticker ([#39](https://github.com/edicius2002/edicius-hq/issues/39))
- [x] INV-08 — live streaming ([#40](https://github.com/edicius2002/edicius-hq/issues/40))

The largest phase in the plan by a wide margin: the legacy carries roughly 14,000 lines of
JavaScript across `js/investing/`, plus a Python backend of its own (`server.py`,
`yahoo_cache.py`, `chart_history.py`, `chart_feeder.py`, `market_indicators.py`). Finance, for
comparison, was 3,800 lines. Every surface below is in scope; nothing is being cut.

It is delivered in seven slices, each with its own issue written immediately before the work and
its own PR — the rhythm Finance settled into, rather than one issue covering everything. An issue
freezes decisions at the moment it is written, so one written now would be deciding the heatmap
weeks before the heatmap is understood.

| ID     | Slice                    | Scope                                                                                                                            |
| ------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| INV-01 | **Data plane**           | FastAPI adapters (Yahoo, Binance), batched quotes, OHLCV cache under `.local-data/`, typed `shared/api` client, client quote bus |
| INV-02 | **Chart**                | Hand-built candle chart on canvas, the timeframe set, the extended-hours overlay, the live forming bar                           |
| INV-03 | **Watchlist and ticker** | Symbol search, watchlist persisted via `shared/storage`, ticker tape, market-status badge                                        |
| INV-04 | **Technical analysis**   | RSI, MACD, overlays and their toggles                                                                                            |
| INV-05 | **Portfolio**            | Positions with quantity and cost, market value and P&L against live quotes                                                       |
| INV-06 | **Pulse**                | Fear & Greed composite and components, sentiment panels — on `/investing`, not a route (decision 2.6)                            |
| INV-07 | **Secondary surfaces**   | Heatmap with tabs, symbol comparison, fundamentals, chart drawings and annotations                                               |
| INV-08 | **Live streaming**       | Prices pushed over a WebSocket held by the API and relayed by SSE, with the poll reduced to a slow sweep                         |

**INV-01 comes first and draws nothing.** Every other slice reads from it, and the legacy's
`js/investing/config.js` is where the expensive knowledge lives — Yahoo's retention ceiling per
timeframe, caps that stop a `range=max` fetch exhausting memory, poll intervals matched to each bar
period. That is ported carefully, not reinvented. Building the chart first would mean building on
data nobody has yet shown to arrive reliably.

**Out of scope for the phase:** alerts that fire while the tab is closed, which would need a process
running outside the browser; that is a cloud-phase question, not a markets one.

---

## Decision Log

### 1. Repository and workflow

| ID  | Decision                                                                 | Rationale                                 |
| --- | ------------------------------------------------------------------------ | ----------------------------------------- |
| 1.1 | Private repo `edicius2002/edicius-hq`.                                   | Formal product home.                      |
| 1.2 | Issues, branches (`chore/feat/fix/docs`), Conventional Commits, PRs, CI. | Incremental, reviewable history.          |
| 1.3 | English for repo and UI.                                                 | Consistency.                              |
| 1.4 | `ediciuscorp` is behavior reference only.                                | Avoid copying global-script architecture. |
| 1.5 | This plan is the living source of truth; ADRs for principle changes.     | Single spine.                             |
| 1.6 | Docs-only PR first; then Initial Setup.                                  | Clean history before tooling.             |
| 1.7 | Docs PR cleans/rewrites only plan-required files.                        | No stale bootstrap clutter.               |

### 2. Product scope

| ID  | Decision                                                        | Rationale                              |
| --- | --------------------------------------------------------------- | -------------------------------------- |
| 2.1 | Tabs: Dashboard, Finance, Greenlight, Investing.                | Agreed surface.                        |
| 2.2 | `/` → `/dashboard`.                                             | Clear home.                            |
| 2.3 | Shell UI for all four tabs: title + “Coming soon.”              | Uniform minimal shell.                 |
| 2.4 | Full Investing (and Pulse panels) later.                        | Heaviest work after foundation.        |
| 2.5 | Status / network monitor out of scope.                          | Not a cloud product concern.           |
| 2.6 | Pulse = extra Investing panels on `/investing`; no Pulse route. | Markets widgets without extra URLs.    |
| 2.7 | Cloud: Supabase magic-link Auth + RLS.                          | Multi-device later, simple auth first. |
| 2.8 | Local mode without forced login until cloud auth.               | Dev/local usability.                   |

### 3. Architecture

| ID  | Decision                                                         | Rationale                            |
| --- | ---------------------------------------------------------------- | ------------------------------------ |
| 3.1 | Monorepo: `apps/web` + `services/api` + `docs` + `supabase`.     | Shared repo, separable deploy.       |
| 3.2 | Feature folders + `shared/*`; features do not import each other. | Scalable boundaries.                 |
| 3.3 | FastAPI for market proxies, health, local KV.                    | Clean FE/BE split.                   |
| 3.4 | CSS Modules + tokens; Radix later.                               | Brand-owned UI; Radix when needed.   |
| 3.5 | Desktop-first.                                                   | Matches usage.                       |
| 3.6 | Routes: `/dashboard`, `/finance`, `/greenlight`, `/investing`.   | English UI; no `/pulse`.             |
| 3.7 | Dark ediciuscorp palette as default UI tokens.                   | Match locked visual criteria.        |
| 3.8 | Berkeley Mono as product typeface (self-hosted).                 | Locked typography; license required. |
| 3.9 | UI foundation before Greenlight visual adaptation.               | Shared primitives first.             |

### 4. Tooling and phases

| ID  | Decision                                                   | Rationale                               |
| --- | ---------------------------------------------------------- | --------------------------------------- |
| 4.1 | Strict TS, ESLint, Prettier, Vitest/RTL, GitHub Actions.   | Useful gates.                           |
| 4.2 | npm only; secrets gitignored.                              | Simple and safe.                        |
| 4.3 | Initial Setup = tooling/Docker/CI only; Shell is separate. | Clear phase boundaries.                 |
| 4.4 | Docker Compose for local DX.                               | Reproducible FE+API.                    |
| 4.5 | API data at `services/api/.local-data/`.                   | Owned by the API service.               |
| 4.6 | Node 22, Python 3.12.                                      | Current stable pins.                    |
| 4.7 | TanStack Query in API client + storage phase.              | With HTTP client, before data features. |
| 4.8 | Defer charts/Supabase client until their phases.           | Focused PRs.                            |

### 5. Data plane

| ID  | Decision                                                         | Rationale                              |
| --- | ---------------------------------------------------------------- | -------------------------------------- |
| 5.1 | Split user state (A) vs market data (B).                         | Different frequency and tenancy.       |
| 5.2 | User config → Supabase and/or local KV.                          | RLS-friendly, low write rate.          |
| 5.3 | Live quotes → client bus + API poll / WS; not Supabase hot path. | High frequency.                        |
| 5.4 | Candle history → FastAPI cache; upstream provider.               | Shared market cache.                   |
| 5.5 | Live candle → client memory.                                     | Ephemeral.                             |
| 5.6 | Supabase Realtime only for user documents (optional).            | Wrong tool for tape.                   |
| 5.7 | Alerts: in-memory quote vs stored rules.                         | No need to persist last price.         |
| 5.8 | No tick/OHLCV primary design in Supabase unless a later ADR.     | Avoid Postgres time-series by default. |

### 6. Greenlight

| ID  | Decision                                                                                              | Rationale                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 6.1 | Sample data and JSON export cut from the MVP.                                                         | Real CSV import covers the need; the dead module was still shipping a chunk.                              |
| 6.2 | Task counting removed entirely (no `tasks`/`attempter`/`reviewer`).                                   | Most TimeRecords notes carry no task IDs, so per-day counts read as 0 next to real money. Money-only.     |
| 6.3 | Tool subscriptions recorded per month as widgets: VSCode $10, Cursor $20, at most one of each.        | Rates taken from the CSV `Expense` rows ($10 + $20 = $30 when both are billed).                           |
| 6.4 | Widgets are a record only — they never affect Gross, Fee or Net.                                      | They document what was reimbursed without disturbing the deliverable math.                                |
| 6.5 | Widgets auto-seed from `Expense` rows; import never overwrites a month that already has an entry.     | Manual edits must survive re-import. An emptied month is stored as `[]` so a removal is not undone.       |
| 6.6 | The 10% fee is charged only when a period's gross reaches **$1,000**; below that nothing is deducted. | Matches the contract minimum. Exactly $1,000 is charged.                                                  |
| 6.7 | The fee threshold applies **per marker period**, and the headline totals sum those periods.           | Keeps the top Stats reconciling with the segment cards; a sub-minimum period keeps its full gross.        |
| 6.8 | Greenlight storage writes are serialized, and a failed read blocks writing instead of saving empty.   | Read-modify-write on one document: overlapping writes dropped edits, and a failed read wiped stored data. |
| 6.9 | Segment length is reported in **calendar weeks**, not payment dates.                                  | A week can carry several payment dates, so counting dates overstated the period.                          |

### 7. Finance

Structural decisions live in [ADR 0001](ADRs/0001-finance-cash-flow-domain-model.md); this table records the product rules.

| ID   | Decision                                                                                              | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1  | Fees belong to holdings only; accounts charge nothing.                                                | An account is never an endpoint of a flow, so it cannot charge one. The legacy's account-fee code was unreachable.                                                                                                                                                                                                                                                                                                                                                                                |
| 7.2  | A transfer takes the source's out-fee, then the destination's in-fee, each on the **running** amount. | 1000 at 10% and 10% nets 810, not 800; a flat 50 then 10% nets 855, where the reverse order gives 850.                                                                                                                                                                                                                                                                                                                                                                                            |
| 7.3  | Assets never convert. Each code totals on its own.                                                    | The diagram records what is held, not what it would be worth in something else.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7.4  | A source may not commit more than it holds; when it does, all its flows leave the in-transit total.   | Ported from the legacy. Checked per asset for a job, since a job holds several.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7.5  | A switched-off holding keeps its amount but leaves the canvas, the totals and its flows.              | One idea of "out of play", so the drawing and the numbers cannot disagree about it.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 7.6  | Only two connections exist: job → holding, and holding → holding across different accounts.           | Matches the legacy's rules, but as typed refusals with reasons rather than silent no-ops.                                                                                                                                                                                                                                                                                                                                                                                                         |
| 7.7  | Undo history lives in memory, not storage.                                                            | Undo fixes what you just did. Persisting it would cost a write per pointer move and let history drift from the saved diagram.                                                                                                                                                                                                                                                                                                                                                                     |
| 7.8  | Undo is per diagram, and edits that fire in runs merge into one step.                                 | Ctrl+Z should affect the diagram on screen. Without merging, one drag becomes an entry per pointer move and undo steps back a few pixels at a time.                                                                                                                                                                                                                                                                                                                                               |
| 7.9  | Deleting the last diagram leaves an empty one.                                                        | The document always needs an active diagram, so it can never end up with none.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7.10 | The camera lives in memory, one per diagram, and is never stored.                                     | Departs from the legacy, which kept `{panX, panY, zoom}` per tab. Persisting costs a write per wheel notch and per pan frame, and puts view state in a document that otherwise holds only money. `Fit` and `100%` buy back what persistence was for. Same reasoning as 7.7.                                                                                                                                                                                                                       |
| 7.11 | The canvas moves by transform, not by scroll.                                                         | Pan must reach past the content in every direction, and the minimap's frame has to be the same numbers the canvas transform uses. A scroll box only travels right and down from the origin, and would leave two things deciding what is on screen.                                                                                                                                                                                                                                                |
| 7.12 | The canvas is clipped, not hidden.                                                                    | A hidden box is still a scroll container, and the browser scrolls one to reveal a focused child — pressing a zoom button shoved the diagram out of view behind the camera's back. A clipped box cannot scroll, so the camera is the only thing that moves the world.                                                                                                                                                                                                                              |
| 7.13 | The canvas has no corner. Node positions are not clamped, and content is measured in both directions. | The clamp at the origin was invisible while the canvas was a scroll box, because a scroll box cannot reach past it either. The camera exposed it as a wall you could pan up to but not drag through.                                                                                                                                                                                                                                                                                              |
| 7.14 | Frame membership is derived from the geometry, never stored.                                          | The legacy stored `nodeIds` on each group _and_ recomputed them, which is one truth in two places. Same call ADR 0001 made for holding ownership. Dragging a node into a frame is then the whole gesture.                                                                                                                                                                                                                                                                                         |
| 7.15 | A frame reports through the same selector the headline totals use, across every asset.                | The legacy filtered to fiat, so a frame holding crypto reported nothing, and it recomputed `total − outgoing` inline. Sharing `availableOf` means a frame can never disagree with the totals above it.                                                                                                                                                                                                                                                                                            |
| 7.16 | A frame's body is transparent to the pointer; only its header and handles answer to one.              | A frame is often the largest thing on the canvas. If its body caught presses it would swallow every pan started inside it and stop the nodes underneath being the first thing you can grab.                                                                                                                                                                                                                                                                                                       |
| 7.17 | Moving a frame carries the members it had when the gesture started.                                   | Read before the move, not after, so a frame sliding across a stationary node picks it up on arrival rather than shoving it along. Because members travel with the frame they stay inside it, which is what stops membership flickering mid-drag.                                                                                                                                                                                                                                                  |
| 7.18 | A backup is the whole document, not the diagram on screen.                                            | The legacy exported one diagram, labelled `scope: "current-diagram"`. With tabs that is a trap: you press Export believing your finances are safe and you saved one tab. Moving a single diagram between documents is sharing, not backup.                                                                                                                                                                                                                                                        |
| 7.19 | Restore replaces; it does not merge.                                                                  | Merging by diagram id has no obvious right answer for a collision, and every answer surprises someone. Replacing is one rule you can hold in your head. It is destructive, so it asks first, naming the file.                                                                                                                                                                                                                                                                                     |
| 7.20 | A backup file is parsed by `normalizeDocument`, and the check that it _is_ a backup comes first.      | A file off the disk is as untrusted as a value off the wire. But that parser turns anything unusable into an empty document, so without a shape check in front of it, importing a holiday photo would succeed and replace every diagram with nothing.                                                                                                                                                                                                                                             |
| 7.21 | No automatic snapshots, and restore is not undoable.                                                  | The legacy carried a snapshot-and-self-heal system because `localStorage` silently evaporates; our documents are files on disk behind the API, so that would be copying the scar rather than the lesson. Undo is per diagram and in memory; restore swaps them all at once.                                                                                                                                                                                                                       |
| 7.22 | Nothing on the canvas is selectable text, and a press that starts a gesture claims the default.       | Measured: six of the thirteen text-bearing elements inside the viewport were selectable, and a node drag anchored a selection in the frame header it passed, so labels lit up blue behind the node. Only the nodes had opted out, which is why it looked intermittent. The rule belongs to the viewport, which is the thing every gesture happens inside; the properties panel and the diagram tabs sit outside it and stay selectable and editable.                                              |
| 7.23 | A gesture draws from its own state until it ends, not from the stored document.                       | The canvas drew node and frame positions straight from the saved document, and a save is a round trip, so whatever was being dragged trailed the pointer by a write. With writes serialised, one slow write stopped the drag dead: held open, the node did not move at all. The gesture now owns the position while it lasts and hands it back on release, so a drag is immediate whatever storage is doing. The flows and the minimap read the same positions, so the canvas moves as one piece. |

### 8. Investing

Agreed before the phase opens, so the slices inherit them rather than each re-deciding.

| ID   | Decision                                                                                                                   | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1  | Market data comes from **Yahoo** for equities and **Binance** for crypto.                                                  | Chosen against the alternatives rather than inherited. No keyed free tier delivers live data: Finnhub is 20 minutes behind, Twelve Data 4 hours, Alpha Vantage allows 25 requests a day. A watchlist and a live bar fed by four-hour-old prices are theatre, and paying is 30–100 USD a month for a personal dashboard. Binance is additionally an official, documented, keyless API — a real gain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8.2  | Quotes are fetched in **batches**, never one request per symbol.                                                           | Yahoo's undocumented ceiling is a few hundred requests a day per IP. One request per symbol exhausts that in half an hour with a modest watchlist. The legacy batched up to 48 symbols per call for exactly this reason; here it is a requirement, not an optimisation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 8.3  | Every provider sits behind an **adapter in the API**, and no component ever names one.                                     | These are unofficial endpoints that can change without notice and already need cookie and crumb handling. Behind a typed contract, replacing a provider is rewriting one module; leaked into the frontend, it is rewriting the phase. Extends the existing rule that market UI talks only to `shared/api`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8.4  | The server-side cache is load-bearing, not a nicety.                                                                       | It is what keeps request counts under the ceiling and what keeps the page alive when upstream misbehaves. Revisit at the cloud phase: requests then leave from one datacenter IP rather than a home connection, which is far likelier to be throttled — 8.1 is explicitly open for review at that point.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 8.5  | A portfolio position is **not** a Finance holding, and the two are never unified.                                          | A holding is an amount you state; a position is a quantity whose value the market decides today. They look alike and behave nothing alike. Investing keeps its own store and its own types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8.7  | Quotes cache in memory, bars cache on disk, and both coalesce.                                                             | A quote is stale in seconds, so a disk write costs more than the fetch it saves; two years of daily candles is stable for hours and worth surviving a restart. Coalescing is what stops three panels opening at once from being three upstream requests instead of one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 8.8  | A refused symbol travels beside the ones that worked, not instead of them.                                                 | A watchlist of twenty must not go blank because one ticker was delisted. The API answers with quotes and failures together, each failure carrying a code the client can tell apart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8.9  | The chart is hand-built on canvas; only `d3-scale` is taken.                                                               | TradingView's Advanced Charts is excluded by licence, not by taste: it is for companies, in public projects, and bars personal use and anything behind auth — this repo is private, personal, and heads behind Supabase Auth at step 7. Of the usable libraries none was chosen, because the density this needs is a design decision and a library's defaults are what you fight. Indicators and drawings get cheaper when we own the renderer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 8.10 | The chart's x axis is bar index, not time.                                                                                 | Mapping timestamps to pixels draws every weekend and every night as dead space. Indexing by bar position collapses closed sessions on their own, and makes the scale linear over integers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8.11 | Extended-hours candles are fetched, drawn translucent, counted, and then gone.                                             | They come from `includePrePost` rather than accumulated ticks, so a reload at 3am restores them. They join the price autoscale and will feed the indicators. At the regular open we stop asking for them, so they vanish for good — the scale re-fitting and an indicator stepping at 9:30 are wanted, not faults. No candle is ever invented for a period with no trades.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8.12 | Three cadence regimes, and the session clock lives with the chart.                                                         | Nothing trades between 20:00 and 04:00 ET, so polling then buys nothing. Measured: one cadence around the clock is ~66k requests a day, three regimes ~24.5k, and the night alone falls from 48.3k to 6.6k. Clearing the overlay needs to know when the market opens, so the clock sits where it is first needed rather than in INV-03 with its badge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8.13 | Quotes are **batched behind a cookie-and-crumb session**, and the per-symbol path is the fallback.                         | Ten times fewer upstream requests, and flat in the number of symbols: forty cost the same as ten. But the handshake is the fragile thing INV-01 refused to take on — cookies expire and the crumb rotates — so a refusal drops back to the path that never needed a session, and a symbol the batch omits is asked for again alone. The saving is taken when it is there; nothing breaks when it is not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 8.14 | `marketState` decides **what is shown**; the session clock decides **cadence and clearing**.                               | Each answers what the other cannot. The exchange knows it is a holiday, which 8.12's clock deliberately does not model; only the clock knows when the next bell is, which is what the overlay needs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 8.15 | The tape and the watchlist are fed by **one** set of quotes, with the charted symbol riding along.                         | They show the same symbols. Two fetchers would double the request count for identical data and let the two disagree on screen, which is worse than either being slightly stale.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 8.16 | Outside regular hours the price shown is the **extended** one; the change is still measured against the **regular close**. | Reading only `regularMarketPrice` after the bell showed yesterday's number while the market moved — measured on NVDA, which read −0.10% when it was in fact +0.09%, the wrong colour as well as the wrong figure. The change stays against the regular close so the percentage answers "how is it doing today" rather than "how far has it drifted since the bell", which is a narrower and less useful question. The price is dimmed and tagged, for the same reason 8.11 draws extended candles translucent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 8.17 | The tape **runs on its own** at a constant **130 px/s**, packed at the density the references use.                         | It was `overflow-x: auto` — a scrollbar under the prices, so reading the market meant dragging it. Two identical halves translated by exactly half the track make the loop seamless; `clip` rather than `hidden`, because a hidden box is still a scroll container, the same trap the Finance camera fell into. Density and speed were measured, not chosen: Yahoo Finance fits an item into ~171px, and the first attempt here spent **362px** on a 160px item because `min-width: 100%` on a child of a `max-content` track is circular and the browser resolved it by doubling the group, which `space-around` then spent as 200px of dead air. Fixed, an item is 177px and nine are visible at once instead of four. Speed is held in pixels per second and the CSS duration derived from the measured width, so it does not change with the symbol count; a symbol now comes round every 13.5s rather than every 40. It pauses on hover, and the repeats that fill a short list are hidden from assistive tech and out of the tab order. |
| 8.18 | The stream **supplements** the poll; it never replaces it.                                                                 | Measured against the ten real watchlist symbols in pre-market: three — SCHD, GLDM, PFE — pushed nothing at all in 32 seconds. The socket carries trades, not a heartbeat, so silence means "nothing traded" and "the connection died" in one breath. It also never sends a previous close, a name or a currency, which are what a row and its percentage are built from. So the poll becomes a slow **sweep** rather than disappearing: it covers what never trades, supplies what a tick omits, and its returning is what proves the socket is alive. Naming it a fallback would invite someone to delete it.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 8.19 | One socket in the API, relayed to the browser by **SSE**.                                                                  | Decision 8.3 keeps provider names out of the client, and a socket opened in the browser would put `streamer.finance.yahoo.com` in it. One connection also serves every tab — the hub refcounts symbols, so two tabs on the same watchlist cost one subscription — and lets streamed and swept values merge before anyone reads them. SSE rather than a socket because only one direction carries anything and an `EventSource` reconnects by itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 8.20 | Protobuf is read by hand, not by a runtime.                                                                                | Yahoo's frames are base64 protobuf with no published schema. A runtime plus a generated `.proto` would be a dependency, a build step and a file to keep in sync with an endpoint that can change without notice — for one message shape the wire format makes readable in fifty lines. Reading it by hand also surfaced that field 3 is a `sint64`: taken as a plain varint the timestamp comes out doubled, which put a live tick in the year 2083.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 8.21 | Ticks are coalesced twice: per symbol on the server, per frame in the browser.                                             | Binance's rolling ticker sends every second whether or not anything traded, so most of what arrives overnight is the price already on screen — measured, deduplicating halved it. The server holds the newest tick per symbol per 250ms; the browser batches a frame's worth into one render. The browser queue is keyed by symbol rather than appended to, because a background tab runs no animation frames and a list would grow all night.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 8.22 | Indicator series are **index-aligned typed arrays**, not points keyed by time.                                             | The legacy carried `[{time, value}]` and looked them up with a binary search on every crosshair move — `seriesPointAtTime` and `candleCloseAtTime` are both O(log n) per read, and every point was an allocation. Our x axis is already the bar index (8.10), so a `Float64Array` indexed the same way makes that read a single array access and allocates once per series rather than once per bar. `NaN` carries "cannot speak for this bar yet", which keeps every series bar-length and makes the no-invented-value rule a property of the shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 8.23 | Computed once per series, never per frame.                                                                                 | Every indicator is a function of the bars alone, and panning changes the window fifty times a second without changing one of them. Memoised on the bars and the active set, so a drag walks arrays that already exist. Measured: all six over 50,000 bars is **7ms**, and a real chart holds a few hundred — but recomputing that per frame would be the difference between a chart and a slideshow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 8.24 | Panes are bands of the same canvas, not separate charts.                                                                   | Most of the legacy's 954-line TA module is `syncTaCrosshair`, `attachTaTimeSync` and friends: the machinery of keeping three LightweightCharts instances agreeing about the pointer. One surface means the panes share the camera, the bar index and the crosshair by construction. A short chart sheds panes from the end rather than squeezing three unreadable bands where one readable one would fit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 8.25 | Which indicators are on is **global and persisted**; their periods are **fixed**.                                          | The legacy kept the toggles in memory only, so every reload lost them — the one behaviour here deliberately not carried over. Global rather than per symbol, because per-symbol state needs a rule for what a new symbol inherits and there is no obviously right one. Periods stay constants: 14, 12/26/9, 20/2 are the industry defaults and the ones already being read, and exposing them would buy a settings UI, validation and per-number persistence for no decision anyone wanted to make. VWAP is offered intraday only, since one bar per session makes a session VWAP the typical price.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 8.6  | Alerts compare in-memory quotes to stored rules, and only while the page is open.                                          | Already implied by decision 5.7. Firing with the tab closed needs something running outside the browser, which belongs to the cloud phase rather than to markets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### 9. Shared storage

Cross-cutting: Finance and Greenlight both write through `shared/storage`, so these are decided
once rather than twice. Section 6.8 already fixed what the facade guarantees; these say when it
writes and what it says while it is doing so ([#38](https://github.com/edicius2002/edicius-hq/issues/38)).

| ID  | Decision                                                                              | Rationale                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1 | Edits reach storage on a trailing debounce, and the debounce lives in the facade.     | Measured against the real Finance document: a 30-event drag was 30 writes and 217 KB, and is now one write and 7.2 KB. Putting it in Finance would have left Greenlight writing eagerly and given two answers to one question. The document is written whole, so dragging in one diagram rewrote the other two as well.                                     |
| 9.2 | Local state leads and storage follows.                                                | The node's rendered position used to come back from the write, so the drag only moved as fast as the round trip. At 10 ms locally the queue drains just fast enough to hide it; at 30 ms the input outruns the writes and the node trails the pointer. Step 7 puts this behind a network, so the ordering is the change rather than a consequence of it.    |
| 9.3 | A debounce must be flushable, not only timed: on `pagehide`, on hide, and on unmount. | A timer alone loses whatever it holds when the page goes away, and routing off `/finance` mid-drag would have lost the drag. Flushing on unmount is the case tests would not have caught, because nothing in a test navigates.                                                                                                                              |
| 9.4 | A restore supersedes what the debounce is holding rather than queueing behind it.     | Writing the stale value first only to overwrite it a moment later spends a write to no end, and letting the two race lets the older one land last — a restore silently undone by a drag from before it. Anything already in flight still lands first, because the queue writes one value at a time.                                                         |
| 9.5 | `pending` and `blocked` are states of their own. `syncing` is not implemented.        | A debounce is a window in which your work exists only in memory; saying nothing during it would be the dishonest part of having one. `blocked` has a different remedy from `failed` — reload, not retry — so it is a different word. `syncing` was the legacy's Supabase phase and belongs to step 7; inventing it now would mean a state that never fires. |
| 9.6 | A write that has been overtaken reports nothing.                                      | A generation counter, so a slow response cannot paint "Saved" over edits that are still waiting. It mattered for a round trip before; with a debounce in front it matters for the length of a whole drag.                                                                                                                                                   |
| 9.7 | The test environment refuses an unstubbed `fetch`.                                    | Not a formality. A debounced write can fire after the test that caused it has finished and `vi.unstubAllGlobals()` has put the real `fetch` back, and it then goes to whatever serves the API base URL — in development, the developer's own API over their own data. This happened during the work: a fixture document replaced the real Finance one.      |

### Superseded decisions

| ID  | Change                                                             | When       |
| --- | ------------------------------------------------------------------ | ---------- |
| S.1 | Status removed from product.                                       | 2026-08-05 |
| S.2 | Migration-kit docs removed; spine is this file.                    | 2026-08-05 |
| S.3 | HTML/JS dump migration replaced by React strangler.                | 2026-08-05 |
| S.4 | Quotes/candles clarified as market path B, not Supabase.           | 2026-08-05 |
| S.5 | Pulse: separate tab → Investing panels only (no nested route).     | 2026-08-05 |
| S.6 | Initial Setup no longer includes AppShell; Shell is its own phase. | 2026-08-05 |

---

## Document Changelog

| Date       | Summary                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| 2026-08-05 | Formal plan established; data plane; Pulse in Investing; delivery Q&A; clean rewrite for repository initialization. |
| 2026-08-05 | Docs PR #1 merged to `main`; step 0 complete.                                                                       |
| 2026-08-05 | UI foundation (#10): dark tokens, Berkeley Mono, shell primitives before Greenlight.                                |
| 2026-08-05 | Greenlight MVP (#9): CSV weekly analytics on foundation UI.                                                         |
| 2026-08-05 | Greenlight scope change (#9): dead sample data removed, task counting dropped, tool subscription widgets added.     |
| 2026-08-05 | Greenlight merged (#12); step 4 complete. Next delivery is Finance.                                                 |
| 2026-08-05 | Finance core (#14): cash-flow canvas on a new domain model, recorded in ADR 0001. First ADR in the repository.      |
| 2026-08-06 | Finance core merged (#15). Step 5 complete apart from the pieces deferred by agreement.                             |
| 2026-08-06 | Finance undo/redo and multiple diagrams merged (#18). Both landed as additions, so ADR 0001 held.                   |
| 2026-08-06 | Finance canvas camera (#20): zoom, pan and minimap on one transform, held in memory per diagram.                    |
| 2026-08-06 | Finance canvas camera merged (#21). Two faults surfaced only by measuring the running app, not by the tests.        |
| 2026-08-06 | Finance canvas unbounded (#26): the origin clamp removed, content measured in both directions.                      |
| 2026-08-06 | Finance frames (#24): named regions with derived membership. First addition to the persisted shape since ADR 0001.  |
| 2026-08-06 | Finance frames merged (#28). Only backup and restore is left before Investing.                                      |
| 2026-08-06 | Finance backup and restore (#30): the whole document to a file and back, guarded by the storage parser.             |
| 2026-08-06 | Finance backup and restore merged (#31). Step 5 complete with nothing deferred; next delivery is Investing.         |
| 2026-08-06 | Investing planned: seven slices, INV-01…07, and the data-source decisions in section 8. Data plane goes first.      |
| 2026-08-06 | INV-01 delivered (#34): adapters, cache with coalescing, quote bus. Live against Yahoo and Binance.                 |
| 2026-08-07 | INV-02 delivered (#36): hand-built candle chart, extended-hours overlay, three cadence regimes.                     |
| 2026-08-07 | INV-03 delivered (#39): watchlist sidebar, tape, batched quotes. The legacy watchlist migrated in.                  |
| 2026-08-07 | Extended-hours prices shown after the bell, and the tape made to run rather than scroll (8.16, 8.17).               |
| 2026-08-07 | INV-08 added (#40): streaming measured against polling. ~2,160 requests/day → ~536, and 60s stale → sub-second.     |
| 2026-08-07 | INV-08 delivered: Yahoo and Binance sockets behind one SSE relay, the poll reduced to a sweep (8.18–8.21).          |
| 2026-08-07 | Debounced storage writes and the save-status widget (#38): a 30-event drag falls from 30 writes to one.             |
| 2026-08-07 | INV-04 delivered (#45): six indicators, RSI and MACD panes on the same canvas (8.22–8.25).                          |
