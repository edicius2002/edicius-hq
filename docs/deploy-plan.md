# Deployment: Vercel, Neon, and Raspberry Pi

The public app runs on Vercel at `https://edicius-hq-web.vercel.app`. Better Auth
serves passkeys and sessions through `/api/auth`. Browser data uses the Neon Data
API with JWT and row-level security. The Raspberry Pi runs provider collectors
and syncs Airfare history to Neon. The SEACE PDF preview is served by a Vercel
Function at `/api/seace/document`, using the same browser session. The old home
API is for local development only.

The current migration record is [Neon migration trial and cutover](neon-migration-trial-2026-11-11.md).
The collector installation and checks are in the [Pi collector runbook](pi-collectors-runbook.md).

## Web release

1. Confirm that the target is the existing Vercel project and that the intended
   commit is clean. Deploy from versioned files only. Never package `.env.local`,
   `.local-data`, database dumps, or the Pi fare archive.
2. Keep `DATABASE_URL` and `BETTER_AUTH_SECRET` server-only. Set the public
   browser values for the Neon Data API and backend at build time. The web
   must not set `VITE_API_URL` in Vercel.
3. Run web type checking, focused tests, the SEACE proxy tests, and a production
   Vite build. Confirm that no Postgres connection string enters the browser
   bundle.
4. Deploy Preview and check `/api/seace/document` rejects an anonymous
   request with 401. Deploy Production only after its functions build cleanly.
5. On the stable production origin, sign in with a passkey. Check Finance,
   Investing, Airfare, Dashboard, Sentiment, and SEACE on desktop and mobile.
   Open a SEACE PDF preview and its original link. Check `/api/auth/jwks`.

## Pi release

Keep the fare archive as a source backup. Follow the Pi runbook to install and
verify the collector release, its Neon environment, timers, retention, and
Airfare sync. The Pi has no public HTTP API. Do not enable provider-facing
collection on Vercel.

## Rollback and storage

Keep the previous Vercel deployment available for rollback. Preserve the
ignored local Neon backups and the Pi fare archive. Check Neon branch storage
and write availability before making schema or retention changes. The current
storage observations and verified backup counts are in the migration record.

## Finance Supabase and passkey cutover runbook

This September 2026 runbook was superseded by the Neon cutover. Its historical
steps remain in Git history; use the migration record above for current checks.

## Airfare replica operator runbook

The live source, sync, and verification procedure is in the Pi collector
runbook and the migration record above.

### Target, schema, and credential gate

Use the Neon `production` branch and server-only database credentials. Confirm
the schema and row-level security before a collector release.

### Backfill, reconciliation, and idempotency gate

Compare archive hashes, row counts, and dirty routes using the migration
record's verified checks. Repeating a sync must not duplicate observations.

### Canary, read rollback, and retention

Verify browser reads and a durable database write before switching a collector.
Retain the source archive and a known-good web deployment for rollback.
