<p align="center">
  <img src="./apps/web/public/favicon-e.png" alt="Edicius HQ mark" width="64" />
</p>

<h1 align="center">Edicius HQ</h1>

<p align="center">
  A private workspace for personal finance, markets, airfare, and public procurement.
</p>

<p align="center">
  <a href="https://github.com/edicius2002/edicius-hq/actions/workflows/ci.yml"><img src="https://github.com/edicius2002/edicius-hq/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  &nbsp; React + TypeScript &nbsp;·&nbsp; FastAPI &nbsp;·&nbsp; Supabase
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

The app is responsive and uses Supabase Auth for browser sessions. Its production sign-in uses a passkey; localhost has a separate development sign-in described below.

## Run it locally

### Prerequisites

- **Node.js 22** and npm (`.nvmrc` pins the Node version).
- **Python 3.12** if you will run the local API.
- Access to the project's Supabase configuration and an authorized account. Local development reads production data.
- **Docker Compose** only if you want to build the containerized web and API services.

### Web development

```bash
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. Passkeys are bound to the production origin, so the Vite development server signs in on localhost using a one-time Supabase token. Create a per-machine file at `%USERPROFILE%\.edicius-hq\dev-auth.env` on Windows or `~/.edicius-hq/dev-auth.env` on macOS/Linux with these values:

```text
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=<secret key>
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable key>
EDICIUS_DEV_LOGIN_EMAIL=<owner email>  # needed when the project has multiple users
```

Set `EDICIUS_DEV_AUTH_FILE` to use a different file path. The secret stays in the local Vite process; keep this file out of Git. Signing out on localhost ends only that browser session.

### Local API

Some local workflows still use FastAPI. Create its virtual environment and start the server in another terminal:

```powershell
cd services/api
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ../..
npm run api:dev
```

On macOS/Linux, use `python3.12 -m venv .venv` and `.venv/bin/python -m pip install -r requirements.txt`. The API listens on **http://127.0.0.1:8000**; its `/api/*` routes, including `/api/health`, require a Supabase access token.

### Other ways to run

| Command                     | Purpose                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm start`                 | Build the web app, then serve its compiled bundle and the local API together on ports 5173 and 8000. The development-only localhost sign-in is not part of this preview. |
| `docker compose up --build` | Build and start the web and API containers. Compose does not mount the per-machine development auth file into the web container.                                         |

Stop Compose with `docker compose down`. Local API data lives in the ignored `services/api/.local-data/` directory.

## How the pieces fit

| Piece                            | Responsibility                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/web`](./apps/web)         | React, TypeScript, and Vite SPA; reads owner data and collected results through Supabase.                                                                |
| [Supabase](./supabase)           | Browser authentication, owner-scoped documents, and indexed reads for collected data.                                                                    |
| [`services/api`](./services/api) | Authenticated FastAPI routes for local development and retained workflows.                                                                               |
| [`ops/pi`](./ops/pi)             | Raspberry Pi collectors and workers for provider acquisition. The Airfare archive is an append-only Pi journal; Supabase holds its indexed read replica. |

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
