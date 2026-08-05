# Contributing

Follow **[docs/IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md)**.

1. Open or use a GitHub Issue.
2. Branch from `main` using `chore/`, `feat/`, `fix/`, or `docs/`.
3. Use Conventional Commits.
4. Open a pull request; prefer squash merge.
5. Update the Implementation Plan when a phase starts, a decision changes, or a phase completes.

All repository and user-facing text is English.

## Local checks before opening a PR

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:api
```

Or use Docker Compose for end-to-end local DX (`docker compose up --build`). See the root README.
