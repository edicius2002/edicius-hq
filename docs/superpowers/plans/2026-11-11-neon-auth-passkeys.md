# Neon Auth With Existing Passkeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the owner's two existing WebAuthn credentials usable at the current Vercel origin while moving application data to Neon.

**Architecture:** Self-host Better Auth with its passkey and JWT plugins in a Vercel Function under `/api/auth/*`. Store identity, credentials, sessions, and signing keys in a separate Neon schema. Preserve the Supabase user UUID as the Better Auth user ID and the `owner_id` in application data. Use a JWT with `sub` and `role: authenticated` for the Neon Data API and home API. Keep the existing Supabase deployment untouched until a real passkey login succeeds.

**Tech Stack:** Vite SPA, Vercel Functions, Better Auth, PostgreSQL on Neon, WebAuthn, JWT, FastAPI.

**Spec:** [Migration data plan](../../neon-migration-data-plan.md), especially identity, RLS, and cutover sections.

## Global Constraints

- Never print or commit connection strings, signing secrets, passkey credential bytes, session tokens, or user rows.
- Existing RP ID and production origin are `edicius-hq-web.vercel.app` and `https://edicius-hq-web.vercel.app`.
- Keep the existing user UUID. Do not cut over before the owner signs in with an imported passkey.
- The trial branch expires on 2026-11-18; production remains unchanged while the trial runs.
- The Data API must have least-privilege grants and row-level policies before browser access.

## Review Focus

- A credential with the wrong RP ID must never authenticate.
- A second account must not read or write the owner's rows.
- A JWT without `role: authenticated` must not reach private rows.
- An expired or unknown signing key must fail closed in the home API.
- Both imported passkeys must remain distinct and have their original counters.

---

### Task 1: Trial import and evidence

**Files:** `scripts/neon-migration-trial.py`, a new trial report under `docs/`.

**Interfaces:** Private Supabase dumps and ignored Neon branch env in; table counts, relation sizes, and import status out.

- [x] Export public schema, public data, and Auth data to ignored local files.
- [x] Load 21 selected tables into an isolated branch and verify counts from a new connection.
- [x] Record checksums, selected/excluded tables, storage, and missing production capabilities in a report.

### Task 2: Auth server and schema

**Files:** `api/auth.ts`, `vercel.json`, root `package.json`, Auth migration SQL.

**Interfaces:** `auth.handler(Request) -> Response`; JWKS at `/api/auth/jwks`; JWT at `/api/auth/token`.

- [x] Add Better Auth, passkey, JWT, and PostgreSQL dependencies.
- [x] Configure Better Auth with an isolated schema, stable origin and RP ID, and no public signup.
- [x] Generate and review schema SQL; apply only to the Neon trial branch.
- [x] Test server routes and JWT claims without showing secrets or tokens. JWKS and opciones WebAuthn responden 200 en Vercel; la prueba real de llave confirmó sesión y claims.

### Task 3: Existing credential transfer

**Files:** `scripts/neon-import-passkeys.py` and tests.

**Interfaces:** Private Auth dump in; preserved user UUID and two mapped credentials in Better Auth schema out.

- [x] Decode `bytea` credential IDs and COSE public keys; map them to Better Auth fields.
- [x] Import one user and two passkeys in one transaction, rejecting duplicate IDs and unexpected formats.
- [x] Verify counts, public key byte equivalence, and counter equality without printing values.
- [x] Require a live passkey sign-in at the production origin before proceeding. El dueño confirmó el resultado en la pantalla de prueba.

### Task 4: Data API, application, and cutover

**Files:** `neon.ts`, SQL migrations, web data adapters, API verifier, Pi collectors, tests, deployment config.

**Interfaces:** Better Auth JWT with `sub` and `role` to Neon Data API and home API.

- [x] Enable external JWKS on a trial Data API and migrate RLS/RPC/grants. Clon de `production` con 27 tablas protegidas, 41 funciones y pruebas positivas y negativas de lectura/escritura.
- [ ] Adapt browser and collector data calls; replace Realtime flows with tested alternatives.
- [ ] Restore Airfare from its authoritative Pi archive or preserve sufficient source data for projection rebuild and fallback.
- [ ] Verify real login, pages, writes, workers, storage and growth; then prepare a reviewed production cutover.
