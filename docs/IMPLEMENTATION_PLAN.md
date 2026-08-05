# Implementation Plan and Decision Log

> **Status:** Greenlight in progress on `feat/greenlight` ([#9](https://github.com/edicius2002/edicius-hq/issues/9)).
> **Last updated:** 2026-08-05
> **Review status:** UI foundation merged ([#11](https://github.com/edicius2002/edicius-hq/pull/11)).
> **Phase closure:** Delivery steps 0–3b complete.
> **Next delivery:** Finish Greenlight MVP, then Finance.

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
| `/finance`    | `FinancePage`    | Title + “Coming soon.” | Flow diagram (FIN-*)                    |
| `/greenlight` | `GreenlightPage` | Title + “Coming soon.” | CSV weekly analytics (GL-*)             |
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

**Status:** In progress — issue [#9](https://github.com/edicius2002/edicius-hq/issues/9), branch eat/greenlight.

- [x] Replace Coming soon on /greenlight
- [x] CSV import (ES/EN aliases, Deliverable/Entregable only)
- [x] Replace modes: all + current-month (markers preserved)
- [x] Persist via shared/storage key greenlight (stats, meta, markers)
- [x] Totals + weekly line chart + monthly bars + week cards (% of month)
- [x] Markers between weeks + segment summaries
- [x] Sample data + JSON export + clear
- [x] Synthetic CSV / aggregation tests (no real CSVs in git)
- [x] Adapted to UI foundation primitives / dark tokens
- [ ] PR linked to Greenlight issue

### 5+ — Feature phases

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
