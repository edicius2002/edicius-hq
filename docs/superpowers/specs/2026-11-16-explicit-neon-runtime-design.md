# Explicit Neon runtime configuration

## Intent

Prevent any normal application or collector startup from silently selecting Supabase after the Neon cutover. Keep the existing Supabase implementation available only when an operator explicitly selects it for rollback or historical work.

## Approach

Require explicit backend selectors at runtime: `VITE_DATA_BACKEND`, `API_AUTH_BACKEND`, `COLLECTOR_DATA_BACKEND`, and `AIRFARE_SYNC_BACKEND`. An absent or unknown value fails before opening a remote client. Keep `AIRFARE_DATA_BACKEND=local` for the Pi archive, which is a separate local source rather than a Supabase default. The committed example configuration names Neon for each selector and explains the public Data API URL and server-only Postgres URL. Pi installation and verification must reject a missing selector.

The browser continues to use `supabase-js` as a PostgREST-compatible transport to Neon's Data API. Its module name does not determine the destination; the explicit selector and URL do. Production auth remains Better Auth backed by Neon Postgres.

## Boundaries

This change does not reimplement local passkey sign-in. Better Auth is bound to the production origin, so a local Neon build must report that limitation instead of attempting Supabase sign-in. It also leaves historical Supabase migration importers intact for audit and rollback, but removes them from ordinary package commands.

## Verification

Test missing-selector rejection and explicit Neon/Supabase paths at the selector boundaries. Run focused web, API, and Pi tests, then typecheck and audit source for remaining implicit Supabase defaults.
