# Implementation Plan and Decision Log

> **Status:** Finance delivered — core, undo/redo, multiple diagrams, the canvas camera and frames; Investing not started.
> **Last updated:** 2026-08-06
> **Review status:** Finance frames merged ([#28](https://github.com/edicius2002/edicius-hq/pull/28)).
> **Phase closure:** Delivery steps 0–5 complete, minus backup and restore.
> **Next delivery:** Backup and restore, then Investing.

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
    |-- chart/              # Lightweight Charts adapter
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
- Feature-specific deps (Lightweight Charts, Supabase client, TanStack Query) only in their phases.

---

## Feature IDs

| ID          | Function                                                                            |
| ----------- | ----------------------------------------------------------------------------------- |
| SHELL-01…05 | Nav (4 tabs), desktop layout, branding, local/cloud indicator, storage facade usage |
| HOME-01…04  | `/` → `/dashboard`; Coming soon; richer hub later; English                          |
| FIN-01…10   | Finance diagram capabilities                                                        |
| GL-01…07    | Greenlight CSV / weekly analytics                                                   |
| INV-00      | Coming soon on Investing                                                            |
| INV-*       | Full markets (detail when Investing phase opens)                                    |
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

**Status:** Core complete — [#14](https://github.com/edicius2002/edicius-hq/issues/14) / [#15](https://github.com/edicius2002/edicius-hq/pull/15). Domain model recorded in [ADR 0001](ADRs/0001-finance-cash-flow-domain-model.md).

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

**Follow-up, in progress:** backup and restore — [#30](https://github.com/edicius2002/edicius-hq/issues/30). The last piece of step 5.

### 6+ — Feature phases

Follow the delivery sequence table. Expand INV-* IDs when the Investing phase starts.

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

| ID   | Decision                                                                                              | Rationale                                                                                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1  | Fees belong to holdings only; accounts charge nothing.                                                | An account is never an endpoint of a flow, so it cannot charge one. The legacy's account-fee code was unreachable.                                                                                                                                                          |
| 7.2  | A transfer takes the source's out-fee, then the destination's in-fee, each on the **running** amount. | 1000 at 10% and 10% nets 810, not 800; a flat 50 then 10% nets 855, where the reverse order gives 850.                                                                                                                                                                      |
| 7.3  | Assets never convert. Each code totals on its own.                                                    | The diagram records what is held, not what it would be worth in something else.                                                                                                                                                                                             |
| 7.4  | A source may not commit more than it holds; when it does, all its flows leave the in-transit total.   | Ported from the legacy. Checked per asset for a job, since a job holds several.                                                                                                                                                                                             |
| 7.5  | A switched-off holding keeps its amount but leaves the canvas, the totals and its flows.              | One idea of "out of play", so the drawing and the numbers cannot disagree about it.                                                                                                                                                                                         |
| 7.6  | Only two connections exist: job → holding, and holding → holding across different accounts.           | Matches the legacy's rules, but as typed refusals with reasons rather than silent no-ops.                                                                                                                                                                                   |
| 7.7  | Undo history lives in memory, not storage.                                                            | Undo fixes what you just did. Persisting it would cost a write per pointer move and let history drift from the saved diagram.                                                                                                                                               |
| 7.8  | Undo is per diagram, and edits that fire in runs merge into one step.                                 | Ctrl+Z should affect the diagram on screen. Without merging, one drag becomes an entry per pointer move and undo steps back a few pixels at a time.                                                                                                                         |
| 7.9  | Deleting the last diagram leaves an empty one.                                                        | The document always needs an active diagram, so it can never end up with none.                                                                                                                                                                                              |
| 7.10 | The camera lives in memory, one per diagram, and is never stored.                                     | Departs from the legacy, which kept `{panX, panY, zoom}` per tab. Persisting costs a write per wheel notch and per pan frame, and puts view state in a document that otherwise holds only money. `Fit` and `100%` buy back what persistence was for. Same reasoning as 7.7. |
| 7.11 | The canvas moves by transform, not by scroll.                                                         | Pan must reach past the content in every direction, and the minimap's frame has to be the same numbers the canvas transform uses. A scroll box only travels right and down from the origin, and would leave two things deciding what is on screen.                          |
| 7.12 | The canvas is clipped, not hidden.                                                                    | A hidden box is still a scroll container, and the browser scrolls one to reveal a focused child — pressing a zoom button shoved the diagram out of view behind the camera's back. A clipped box cannot scroll, so the camera is the only thing that moves the world.        |
| 7.13 | The canvas has no corner. Node positions are not clamped, and content is measured in both directions. | The clamp at the origin was invisible while the canvas was a scroll box, because a scroll box cannot reach past it either. The camera exposed it as a wall you could pan up to but not drag through.                                                                        |
| 7.14 | Frame membership is derived from the geometry, never stored.                                          | The legacy stored `nodeIds` on each group _and_ recomputed them, which is one truth in two places. Same call ADR 0001 made for holding ownership. Dragging a node into a frame is then the whole gesture.                                                                   |
| 7.15 | A frame reports through the same selector the headline totals use, across every asset.                | The legacy filtered to fiat, so a frame holding crypto reported nothing, and it recomputed `total − outgoing` inline. Sharing `availableOf` means a frame can never disagree with the totals above it.                                                                      |
| 7.16 | A frame's body is transparent to the pointer; only its header and handles answer to one.              | A frame is often the largest thing on the canvas. If its body caught presses it would swallow every pan started inside it and stop the nodes underneath being the first thing you can grab.                                                                                 |
| 7.17 | Moving a frame carries the members it had when the gesture started.                                   | Read before the move, not after, so a frame sliding across a stationary node picks it up on arrival rather than shoving it along. Because members travel with the frame they stay inside it, which is what stops membership flickering mid-drag.                            |
| 7.18 | A backup is the whole document, not the diagram on screen.                                            | The legacy exported one diagram, labelled `scope: "current-diagram"`. With tabs that is a trap: you press Export believing your finances are safe and you saved one tab. Moving a single diagram between documents is sharing, not backup.                                  |
| 7.19 | Restore replaces; it does not merge.                                                                  | Merging by diagram id has no obvious right answer for a collision, and every answer surprises someone. Replacing is one rule you can hold in your head. It is destructive, so it asks first, naming the file.                                                               |
| 7.20 | A backup file is parsed by `normalizeDocument`, and the check that it _is_ a backup comes first.      | A file off the disk is as untrusted as a value off the wire. But that parser turns anything unusable into an empty document, so without a shape check in front of it, importing a holiday photo would succeed and replace every diagram with nothing.                       |
| 7.21 | No automatic snapshots, and restore is not undoable.                                                  | The legacy carried a snapshot-and-self-heal system because `localStorage` silently evaporates; our documents are files on disk behind the API, so that would be copying the scar rather than the lesson. Undo is per diagram and in memory; restore swaps them all at once. |

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
