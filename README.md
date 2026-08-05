# Edicius HQ

Private suite for personal finance and markets.

## Source of truth

**[docs/IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md)** — product decisions, structure, data plane, and delivery phases.

## Requirements

- Node.js **22** (see `.nvmrc`)
- Python **3.12** (for local API without Docker)
- Docker Desktop (recommended local DX)
- **Berkeley Mono** license for the intended UI typeface (self-host under `apps/web/public/fonts/`; see that folder’s README). Without font files, the app falls back to system monospace.

## Quick start (Docker Compose)

```bash
cp .env.example .env   # optional
docker compose up --build
```

- Web: http://localhost:5173
- API health: http://localhost:8000/api/health

Hot-reload is enabled for both services. API local data persists in `services/api/.local-data/` (gitignored).

Stop with `docker compose down`.

## Local development (without Docker)

### Web

```bash
npm ci
npm run dev          # Vite on http://localhost:5173
```

### API

```bash
cd services/api
py -3.12 -m venv .venv          # Windows
# python3.12 -m venv .venv      # macOS/Linux
.\.venv\Scripts\python.exe -m pip install -r requirements.txt   # Windows
# .venv/bin/python -m pip install -r requirements.txt           # macOS/Linux
cd ../..
npm run api:dev      # http://127.0.0.1:8000
```

## Quality checks

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:api
```

CI runs the same web gates plus API pytest on pull requests and `main`.

## Delivery order

1. **Docs** — README, NOTICE, `.gitignore`, implementation plan
2. **Initial Setup** — tooling, CI, Docker Compose (no UI shell)
3. **Shell + placeholders** — four tabs with “Coming soon.”
4. **API client + storage** — typed client, local KV, TanStack Query
5. **UI foundation** — dark tokens, Berkeley Mono, shell primitives ([#10](https://github.com/edicius2002/edicius-hq/issues/10))
6. Feature phases — Greenlight → Finance → Investing → Cloud

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch and PR workflow.
