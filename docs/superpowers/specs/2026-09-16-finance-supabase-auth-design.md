# Finance Supabase and passkey-auth design

**Status:** Approved for implementation on 2026-09-16.

## Outcome

Move the complete Finance persistence path from the PC-hosted KV API to the
`edicius-hq` Supabase project (`abndifkxpfppmllgxfnu`). The browser reads and
writes Finance directly through Supabase's Data API. The PC API is not a proxy,
fallback, cache, or authority for Finance after cutover.

Replace the app's local WebAuthn credential and opaque-session store with one
application-wide Supabase Auth session. Normal sign-in is passkey-only: one
passkey prompt signs the user into Finance and every other private page, token
refresh is automatic, and no second Finance-specific login exists.

The current source documents are:

| KV key | Local source | Current size |
| --- | --- | ---: |
| `finance` | `services/api/.local-data/kv/finance.json` | 19,027 bytes |
| `finance-camera-views` | `services/api/.local-data/kv/finance-camera-views.json` | 173 bytes |

Both become remote JSONB documents. No normalized financial sub-schema is
introduced in this change: the current graph is one consistency boundary and is
small enough that a whole-document write remains the simplest correct model.

## Chosen architecture

### One Supabase identity for the application

The web app adds `@supabase/supabase-js` at a version that includes the
experimental passkey API (at least `2.105.0`). One shared client is configured
with:

- `VITE_SUPABASE_URL`, which is public project configuration;
- `VITE_SUPABASE_PUBLISHABLE_KEY`, which is safe to ship to the browser because
  authorization is enforced by Row Level Security;
- `auth.experimental.passkey: true`;
- the SDK's persistent session and automatic token refresh.

The secret key named `edicius_hq_replica` is never bundled into the web app. It
is used only by controlled administrative and migration commands.

`App` derives its authenticated/anonymous/checking state from the Supabase Auth
session and auth-state events. `LoginScreen` calls
`supabase.auth.signInWithPasskey()` without requesting an email, username, or
password. Signing out calls Supabase Auth and clears its session. The old
`edicius-hq.session-token`, local enrolment-code flow, `/api/auth/*` ceremony
endpoints, and PC-resident credential/session/challenge records are retired
after cutover.

Supabase requires passkey registration to start from an already confirmed,
non-anonymous user. The existing WebAuthn credential cannot be imported through
the supported API, so cutover includes one deliberate bootstrap:

1. create or confirm the single owner account through an administrative path;
2. establish one temporary authenticated browser session at the production
   origin;
3. call `registerPasskey()` and complete a new platform passkey ceremony;
4. prove passkey sign-in in a fresh browser session;
5. remove the temporary bootstrap route and disable any exposed email/password
   login path.

That bootstrap is the only non-passkey login. Regular use presents only the
passkey action. Passkey registration, listing, and deletion are hidden behind a
small auth adapter because the Supabase API is currently experimental.

Reference: [Supabase Auth passkeys](https://supabase.com/docs/guides/auth/passkeys).

### Stable relying-party boundary

The production WebAuthn configuration is:

- display name: `Edicius HQ`;
- RP ID: `edicius-hq-web.vercel.app`;
- origin: `https://edicius-hq-web.vercel.app`.

Changing the RP ID invalidates registered passkeys. Random Vercel preview hosts
and `localhost` are siblings of, not subdomains of, this RP ID and therefore
cannot use the production passkey. Real ceremonies are supported only on the
stable production origin. Unit/integration tests inject a fake auth client;
there is no authentication bypass in production builds. A future custom parent
domain can deliberately reopen the preview/local-development decision, but it
is outside this migration.

### Existing API authentication

Pages other than Finance continue to call FastAPI. Each request obtains the
current Supabase access token from the shared auth adapter and sends it in the
`Authorization: Bearer` header. FastAPI validates the JWT against the project's
JWKS and verifies, at minimum:

- the signature with an explicit algorithm allowlist;
- issuer `https://abndifkxpfppmllgxfnu.supabase.co/auth/v1`;
- the expected authenticated audience/role;
- expiration and not-before claims;
- a nonempty UUID subject.

The JWKS cache has a bounded lifetime and refreshes once on an unknown key ID so
Supabase key rotation does not require a deployment. Authentication failures
remain uniform 401 responses and never log the bearer token.

Native `EventSource` cannot set the Authorization header. The four current SSE
call sites therefore move to one authenticated fetch-stream adapter. It sends
the JWT as a header, parses named SSE frames, carries `Last-Event-ID` on
reconnect, preserves cancellation/retry behavior, and never puts the JWT in a
URL. The old `token` query parameter and `withStreamToken` are removed.

## Finance storage contract

### Table

`public.finance_documents` contains:

```text
owner_id      uuid        not null references auth.users(id) on delete cascade
document_key  text        not null check in ('finance', 'finance-camera-views')
payload       jsonb       not null, constrained to a JSON object
revision      bigint      not null, positive
updated_at    timestamptz not null default now()
primary key (owner_id, document_key)
```

RLS is enabled. `anon` has no access. `authenticated` can select only rows whose
`owner_id = auth.uid()`. Direct insert, update, and delete privileges are not
granted to browser roles, which prevents a client from bypassing revision
checks.

### Compare-and-swap writer

The browser writes through a narrowly scoped
`write_finance_document(document_key, payload, expected_revision)` RPC. It is a
`security definer` function with an empty search path, fully qualified objects,
no caller-supplied owner ID, and explicit rejection when `auth.uid()` is null.
Only the authenticated role can execute it.

- An absent document can be inserted only with expected revision `0`.
- An existing document can be updated only when its stored revision equals the
  expected revision.
- A successful write increments the revision exactly once and returns the row's
  new revision and timestamp.
- A mismatch returns a recognizable conflict without changing either document.
- The function accepts only the two known keys and object-shaped JSON.

The SQL migration includes pgTAP coverage for anonymous denial, per-user read
isolation, forbidden direct writes, successful insert/update, stale-revision
rejection, key validation, and the inability to select another user's row.

## Browser data flow

Finance replaces `useStoredDocument` with a Finance-specific remote document
store. The page requests `finance` and `finance-camera-views` directly from
Supabase in parallel. Runtime state consists of normalized payload plus its
revision; React Query and React component state hold it only in memory.

Edits retain the current behavior:

- the UI updates optimistically;
- edit functions are serialized so simultaneous local intents cannot lose one
  another;
- the existing 400 ms trailing debounce coalesces pointer and typing bursts;
- page hide, tab hide, and unmount request a best-effort flush;
- restore/replace operations, if any remain as domain operations, wait for the
  remote write rather than entering the debounce.

Each queued write carries the revision obtained by the previous successful
read/write. The queue advances its revision only after Supabase confirms the
RPC. A conflict causes an explicit blocked/conflict state and a refetch; it does
not silently overwrite the other device's document. The user's in-memory edit
is retained for an explicit retry after reconciliation.

Finance does not call `/api/kv/finance` or
`/api/kv/finance-camera-views`. It has no automatic file, IndexedDB,
`localStorage`, service-worker, API-disk, or server-side cache fallback. The
existing Finance backup import/export UI is removed so the page itself no
longer reads or writes PC files. In-memory undo history remains because it is
ephemeral editing state, not persistence.

The only browser-persisted security state is the Supabase session required to
avoid prompting for the passkey on every tab and reload. It contains no Finance
document payload.

## Failure behavior

- An initial read failure renders the existing error/retry state and blocks
  edits, preventing an empty placeholder from replacing remote data.
- A failed save keeps the latest value in memory, marks saving as failed, and
  retries only on user action or a later deliberate flush. It never writes a
  hidden local copy.
- A revision conflict is distinct from network failure. The client refetches,
  reports that another copy changed, and requires deliberate reconciliation.
- Supabase Auth refreshes an expiring token automatically. If refresh fails,
  the application returns to the passkey screen without discarding data on the
  server.
- A valid Supabase session rejected by FastAPI produces the existing private
  page error/sign-out path; tokens and JWT claim contents are not logged.
- Supabase unavailability can leave the already loaded page visible, but the UI
  must not claim an edit is saved until the RPC confirms it.

## Migration and cutover

The migration is staged so no local data is deleted before remote behavior is
proved:

1. Add and test the database migration locally.
2. Push the schema, RPC, grants, and RLS to the linked `edicius-hq` project.
3. Bootstrap the owner Supabase user and register the new passkey on the stable
   production origin.
4. Run an idempotent administrative importer against the two ignored source
   files. The importer receives the owner UUID explicitly, uses the secret key
   only from the process environment, and never prints it.
5. Produce a sanitized verification report containing each key, byte count,
   canonical JSON SHA-256 digest, destination revision, and match result.
6. Repeat the import and verification to prove idempotency and exact JSON
   equality.
7. Deploy the web auth adapter, direct Finance store, and FastAPI JWT verifier
   together. There is no Finance local fallback flag after deployment.
8. Verify fresh sign-in, automatic session restoration, both Finance reads,
   an edit/reload round trip, camera restoration, conflict handling, every
   existing API page, and every SSE stream on the deployed origin.
9. Revoke all old local sessions and stop mounting the local auth and Finance KV
   paths.
10. Keep the two original files read-only as a short-lived rollback artifact.
    Delete them only in a separate, explicit cleanup after production
    verification and a confirmed remote backup.

Rollback before step 9 can restore the previous deployment without mutating the
source files. After step 9, rollback requires intentionally restoring the old
auth service and local documents; the application never performs this
automatically.

## Configuration and secret boundaries

Tracked examples document names, never values:

- web: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`;
- API: `SUPABASE_URL` plus the issuer/JWKS settings derived from that URL;
- administrative migration only: `SUPABASE_SECRET_KEY`.

Vercel receives only public web variables. The API receives no Supabase secret
for ordinary request authentication because JWKS validation is sufficient.
The migration runner receives `edicius_hq_replica` through an ignored local
environment variable or a secret manager, and the value is never committed.

## Verification

Frontend tests cover auth initialization, passkey success/cancel/error, session
restoration and refresh, logout, Supabase query shapes, two-document parallel
loading, optimistic edits, serialized/debounced writes, unload flush, failed
saves, conflict behavior, camera restoration, and absence of Finance KV/file
calls. Existing Finance domain tests remain unchanged.

Backend tests cover valid and invalid JWTs, issuer/audience/expiry checks, JWKS
rotation, uniform 401s, removal of query-token authentication, and authenticated
stream behavior. Stream adapter tests cover framing, named events,
`Last-Event-ID`, abort, reconnect, 401, and truncated responses.

The cutover gates are SQL tests, frontend format/lint/typecheck/tests/build,
backend format/lint/typecheck/tests, an importer dry run, two matching remote
verification runs, and a deployed production smoke test. Hardware acceleration
is not used.

## Alternatives rejected

1. **Keep local WebAuthn and add a second Supabase Finance login.** This creates
   two passkey prompts, two sessions, and inconsistent identity. It contradicts
   the requested single automatic sign-in.
2. **Move the custom WebAuthn implementation to an Edge Function.** This makes
   Supabase the host but leaves this project responsible for cryptographic
   ceremony, credential storage, session issuance, rotation, and recovery.
   Native Supabase Auth has a smaller security surface despite its experimental
   passkey API.
3. **Simple last-write-wins upsert.** It is shorter but can silently erase a
   second device's edits. A revisioned RPC keeps whole-document simplicity
   without accepting silent loss.
4. **Keep a local Finance fallback.** It would reintroduce the PC dependency and
   split authority, making it unclear which copy is current.
5. **Normalize every node, flow, and frame now.** The current data is about 19
   KB, and edits operate on the graph as a unit. Normalization adds joins and
   transaction boundaries without a demonstrated latency or scale benefit.

## Out of scope and accepted limitations

- Passkeys in Supabase Auth are experimental, so the adapter and pinned minimum
  SDK version are deliberate containment points.
- Real passkey ceremonies do not work on random Vercel previews or localhost
  with the chosen RP ID.
- This change does not move Airfare collection or the other feature datasets;
  it changes the shared authentication used to reach their existing APIs.
- This change does not add collaborative merging or realtime co-editing.
  Revision conflicts are detected and surfaced, not automatically merged.
- Removing the two local source files is a post-cutover cleanup, not part of the
  first deployment.
