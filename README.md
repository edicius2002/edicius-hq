<p align="center">
  <img src="./apps/web/public/favicon-e.png" alt="Edicius HQ mark" width="64" />
</p>

<h1 align="center">Edicius HQ</h1>

<p align="center">
  A private workspace for personal finance, markets, airfare, and public procurement.
</p>

<p align="center">
  <a href="https://github.com/edicius2002/edicius-hq/actions/workflows/ci.yml"><img src="https://github.com/edicius2002/edicius-hq/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  &nbsp; React + TypeScript &nbsp;·&nbsp; FastAPI &nbsp;·&nbsp; Neon
</p>

---

Edicius HQ brings seven tools into one authenticated web app. The repository contains the React frontend, a local FastAPI service, and the collectors and workers that feed its data plane. This README describes what is in the codebase; rollout details and operational evidence live in the [implementation plan](./docs/IMPLEMENTATION_PLAN.md) and [Pi collector runbook](./docs/pi-collectors-runbook.md).

## Explore the workspace

| Area                           | What it does                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Dashboard** · `/dashboard`   | USD/PEN quotes and history, world clocks, recent X posts, and Codex reset activity.                           |
| **Finance** · `/finance`       | Visual cash-flow diagrams for accounts, jobs, currencies, and transfers, with saved views and backup/restore. |
| **Greenlight** · `/greenlight` | CSV-based income analysis, weekly and monthly charts, and compound-growth projections.                        |
| **Investing** · `/investing`   | Market charts, watchlists, technical indicators, positions, and browser price alerts.                         |
| **Airfare** · `/airfare`       | Watched city pairs, manual collection, fare history, route maps, and price analysis.                          |
| **SEACE** · `/seace/recent`    | Peruvian procurement notices with recent, open, closed, and published views, filters, and exclusions.         |
| **Sentiment** · `/sentiment`   | CNN Fear & Greed history and its seven component indicators.                                                  |

The app is responsive and uses Better Auth with Neon Postgres for production browser sessions. Its production sign-in uses a passkey.

## Run it locally

### Prerequisites

- **Node.js 22** and npm (`.nvmrc` pins the Node version).
- **Python 3.12** if you will run the local API.
- A Neon Data API URL and an authorized account. Local development reads production data.
- **Docker Compose** only if you want to build the containerized web and API services.

### Web development

```bash
npm ci
npm run dev
```

Copy `.env.example` to an ignored `.env`, then uncomment and set `VITE_NEON_DATA_API_URL` to the project's public Data API endpoint. Put the pooled `DATABASE_URL` in an ignored `.env.local` for server-side scripts. `VITE_DATA_BACKEND=neon` is required; an unset or unknown value stops startup instead of selecting Supabase. The existing passkeys are bound to the production origin, so the current localhost login cannot open private pages in Neon mode. Check authenticated pages on the production origin until a separate local Better Auth login flow is implemented.

### Local API

Some local workflows still use FastAPI. Create its virtual environment and start the server in another terminal:

```powershell
cd services/api
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ../..
npm run api:dev
```

On macOS/Linux, use `python3.12 -m venv .venv` and `.venv/bin/python -m pip install -r requirements.txt`. Set `API_AUTH_BACKEND=neon` explicitly. The API listens on **http://127.0.0.1:8000**; its `/api/*` routes, including `/api/health`, require a Better Auth access token.

### Other ways to run

| Command                                                           | Purpose                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm start`                                                       | Build the web app, then serve its compiled bundle and the local API together on ports 5173 and 8000. The development-only localhost sign-in is not part of this preview. |
| `docker compose --env-file .env --env-file .env.local up --build` | Build and start the web and API containers with the explicit Neon variables.                                                                                             |

Stop Compose with `docker compose --env-file .env --env-file .env.local down`. Local API data lives in the ignored `services/api/.local-data/` directory.

## How the pieces fit

| Piece                            | Responsibility                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/web`](./apps/web)         | React, TypeScript, and Vite SPA; reads owner data and collected results through the Neon Data API.                                                   |
| [Neon](./neon.ts)                | Postgres, Data API, and the database backing Better Auth.                                                                                            |
| [`services/api`](./services/api) | Authenticated FastAPI routes for local development and retained workflows.                                                                           |
| [`ops/pi`](./ops/pi)             | Raspberry Pi collectors and workers for provider acquisition. The Airfare archive is an append-only Pi journal; Neon holds its indexed read replica. |

The Raspberry Pi data-plane design is recorded in [ADR 0004](./docs/ADRs/0004-pi-collectors-supabase-data-plane.md). See the [domain glossary](./CONTEXT.md) for terms such as _watch_, _fare snapshot_, and _Airfare archive_. Repository implementation and production rollout are tracked separately in the [decision log](./docs/IMPLEMENTATION_PLAN.md).

## Check changes

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
npm run lint:api
npm run typecheck:api
npm run test:api
```

CI runs the web and API checks and builds the API image for pull requests and `main`. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the issue, branch, and PR workflow.

> **Typography:** Berkeley Mono is commercially licensed and is not bundled here. See the [font setup notes](./apps/web/public/fonts/README.md); the app falls back to system monospace fonts.
