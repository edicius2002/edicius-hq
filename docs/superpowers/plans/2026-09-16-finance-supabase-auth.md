# Finance Supabase and Passkey Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Supabase the sole durable store for Finance and the sole issuer of application sessions, with direct browser data access protected by RLS and passkey-only routine sign-in.

**Architecture:** A typed Supabase browser client owns the authenticated session. Finance reads its two versioned JSONB documents directly and writes them through one compare-and-swap RPC, while FastAPI verifies the same Supabase JWT for every remaining API route. A shared fetch-based SSE transport keeps bearer tokens out of URLs, and an idempotent administrative importer performs and verifies the one-time local-to-cloud transfer.

**Tech Stack:** React 19, TypeScript 7, Vite 8, TanStack Query 5, `@supabase/supabase-js` >= 2.105.0, Vitest/Testing Library; Python 3.12, FastAPI 0.141.1, PyJWT 2.14.0 with `cryptography`, httpx 0.28.1, pytest 9.1.1; Supabase CLI 2.105.0, PostgreSQL, PostgREST, RLS, pgTAP.

**Spec:** `docs/superpowers/specs/2026-09-16-finance-supabase-auth-design.md`

## Global Constraints

- Supabase project ref is exactly `abndifkxpfppmllgxfnu`; project name is `edicius-hq`.
- Production WebAuthn RP ID is `edicius-hq-web.vercel.app`; the only real ceremony origin is `https://edicius-hq-web.vercel.app`.
- Random Vercel previews and localhost do not receive an authentication bypass and do not run real production passkey ceremonies.
- Use `@supabase/supabase-js` 2.105.0 or newer and opt in with `auth.experimental.passkey: true`.
- `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are public; `SUPABASE_SECRET_KEY` is administrative only and must never enter a browser bundle, source file, log, snapshot, or report.
- Finance runtime traffic is browser-to-Supabase only. Do not call its local KV endpoints and do not add a disk, API, IndexedDB, `localStorage`, service-worker, or offline fallback.
- The two existing JSON files remain untouched until remote equality and production behavior have been verified. Their deletion is a later, explicit cleanup.
- Preserve the 400 ms trailing write debounce, optimistic UI, serialized local edits, lifecycle flush, and in-memory undo behavior.
- A stale revision must never overwrite a newer remote document. Surface a conflict and retain the unsaved in-memory value.
- FastAPI accepts Supabase JWTs only in `Authorization: Bearer`; never put a JWT in an SSE URL or log it.
- Automated tests use local Supabase or fakes only. They never contact the hosted project.
- Do not use hardware acceleration.

---

## File map

**Create:**

- `supabase/migrations/20260916000000_finance_documents.sql` — Finance table, RLS, grants, and compare-and-swap RPC.
- `supabase/tests/finance_documents.test.sql` — pgTAP schema, privilege, isolation, insert/update, and conflict tests.
- `apps/web/src/shared/supabase/database.types.ts` — CLI-generated database types.
- `apps/web/src/shared/supabase/client.ts` — validated singleton browser client.
- `apps/web/src/shared/auth/supabaseAuth.ts` — passkey/session adapter used by UI and API calls.
- `apps/web/src/shared/auth/useSupabaseSession.ts` — reactive app-level auth state.
- `apps/web/src/shared/api/eventStream.ts` — bearer-authenticated fetch/SSE parser and reconnect loop.
- `apps/web/src/features/auth/AccountControls.tsx` — register-passkey and sign-out actions.
- `apps/web/src/features/auth/AccountControls.module.css` — compact account-menu layout.
- `apps/web/src/features/finance/data/financeDocuments.ts` — typed Supabase read/write boundary.
- `apps/web/src/features/finance/hooks/useRemoteDocument.ts` — revision-aware optimistic document store.
- `services/api/app/services/supabase_jwt.py` — JWKS-backed JWT verifier.
- `services/api/tests/test_supabase_jwt.py` — signature/claims/cache/rotation tests.
- `scripts/finance-supabase.py` — dry-run/apply/verify administrative migration command.
- `services/api/tests/test_finance_supabase_script.py` — importer and sanitized-report tests.
- `docs/finance-supabase-evidence/` — sanitized migration evidence.
- `docs/finance-supabase-results.md` — cutover and resource-use record.

**Modify:**

- `supabase/config.toml` — project identity and production passkey/RP configuration.
- `apps/web/package.json`, `package-lock.json` — Supabase JS dependency.
- `.env.example` — browser public variables and API JWT configuration; remove local WebAuthn settings.
- `apps/web/src/app/App.tsx` and tests — derive the global gate from Supabase Auth.
- `apps/web/src/features/auth/LoginScreen.tsx` and tests — one passkey-only sign-in action.
- `apps/web/src/app/layout/TopNav.tsx` and layout tests — replace local enrolment codes with account actions.
- `apps/web/src/shared/api/http.ts` and tests — acquire the current Supabase token asynchronously.
- `apps/web/src/features/investing/data/quoteStream.ts` and tests — use authenticated fetch SSE.
- `apps/web/src/features/airfare/data/collectionStream.ts` and tests — use authenticated fetch SSE.
- `apps/web/src/shared/api/tweets.ts` and `apps/web/src/shared/api/tweets.test.ts` — use authenticated fetch SSE.
- `apps/web/src/test/setup.ts` — remove obsolete global `EventSource` shim.
- `apps/web/src/features/finance/hooks/useFinanceData.ts` and tests — remote Finance document.
- `apps/web/src/features/finance/hooks/useDiagramCamera.ts` and tests — remote camera document.
- `apps/web/src/features/finance/FinancePage.tsx` and `apps/web/src/features/finance/FinancePage.test.tsx` — conflict/error state and no file controls.
- `apps/web/src/shared/storage/keys.ts` — remove both Finance KV keys.
- `services/api/requirements.txt` — replace custom WebAuthn dependency with JWT verification dependencies.
- `services/api/app/config.py` and tests — strict Supabase issuer/JWKS settings.
- `services/api/app/auth.py`, `services/api/tests/test_gate.py`, and `services/api/app/main.py` — Supabase JWT gate and no open local auth router.
- `scripts/api.mjs` and `package.json` — replace local credential commands with the Finance migration command.
- `services/api/app/routers/kv.py` and `services/api/tests/test_kv.py` — Finance keys are no longer accepted.
- `docs/deploy-plan.md` — new auth, Finance authority, setup, rollback, and cleanup runbook.

**Delete after replacements pass:**

- `apps/web/src/features/auth/ceremony.ts`
- `apps/web/src/features/auth/EnrolDevice.tsx`
- `apps/web/src/features/auth/EnrolDevice.module.css`
- `apps/web/src/features/auth/EnrolDevice.test.tsx`
- `apps/web/src/shared/auth/session.ts`
- `apps/web/src/shared/auth/streamUrl.ts`
- `apps/web/src/shared/auth/streamUrl.test.ts`
- `apps/web/src/features/finance/ui/BackupControls.tsx`
- `apps/web/src/features/finance/ui/BackupControls.module.css`
- `apps/web/src/features/finance/ui/BackupControls.test.tsx`
- `apps/web/src/features/finance/lib/backup.ts`
- `apps/web/src/features/finance/lib/backup.test.ts`
- `services/api/app/routers/auth.py`
- `services/api/app/services/auth_store.py`
- `services/api/app/services/webauthn_ceremony.py`
- `services/api/app/cli/auth_cli.py`
- `services/api/tests/test_auth_router.py`
- `services/api/tests/test_auth_store.py`
- `services/api/tests/test_webauthn_ceremony.py`

---

### Task 1: Add and Test the Finance Database Contract

**Files:**

- Create: `supabase/migrations/20260916000000_finance_documents.sql`
- Create: `supabase/tests/finance_documents.test.sql`
- Modify: `supabase/config.toml`

**Interfaces:**

- Consumes: `auth.uid()` from a Supabase authenticated JWT.
- Produces: `public.finance_documents` and `public.write_finance_document(p_document_key text, p_payload jsonb, p_expected_revision bigint)` returning the saved `finance_documents` row.

- [ ] **Step 1: Write failing pgTAP tests for shape, grants, RLS, and compare-and-swap**

Create `supabase/tests/finance_documents.test.sql`. Seed two `auth.users`, set
`request.jwt.claim.sub` before each authenticated assertion, and include these
executable checks:

```sql
begin;
select plan(18);

select has_table('public', 'finance_documents');
select col_is_pk('public', 'finance_documents', array['owner_id', 'document_key']);
select has_function('public', 'write_finance_document', array['text', 'jsonb', 'bigint']);
select ok(not has_table_privilege('anon', 'public.finance_documents', 'select'),
          'anon cannot read Finance');
select ok(has_table_privilege('authenticated', 'public.finance_documents', 'select'),
          'authenticated can read through RLS');
select ok(not has_table_privilege(
            'authenticated', 'public.finance_documents', 'insert,update,delete'),
          'authenticated cannot bypass the RPC');

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated',
   'owner-one@example.invalid', now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated',
   'owner-two@example.invalid', now(), now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select is(
  (public.write_finance_document('finance', '{"diagrams":[]}'::jsonb, 0)).revision,
  1::bigint,
  'revision zero inserts the first document'
);
select is(
  (public.write_finance_document('finance', '{"diagrams":[{"id":"a"}]}'::jsonb, 1)).revision,
  2::bigint,
  'matching revision updates exactly once'
);
select throws_ok(
  $$ select public.write_finance_document('finance', '{}'::jsonb, 1) $$,
  '40001', 'finance_revision_conflict', 'stale revisions are rejected'
);
select throws_ok(
  $$ select public.write_finance_document('unknown', '{}'::jsonb, 0) $$,
  '22023', 'invalid_finance_document_key', 'unknown keys are rejected'
);
select throws_ok(
  $$ select public.write_finance_document('finance', '[]'::jsonb, 2) $$,
  '22023', 'finance_payload_must_be_object', 'array payloads are rejected'
);

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select is((select count(*) from public.finance_documents), 0::bigint,
          'RLS hides the first owner from the second');

select is(
  (public.write_finance_document('finance-camera-views', '{"views":{}}'::jsonb, 0)).revision,
  1::bigint,
  'the second owner can create a camera document'
);

reset role;
select ok(
  (select relrowsecurity from pg_class where oid = 'public.finance_documents'::regclass),
  'Finance has RLS enabled'
);
select ok(not has_function_privilege(
            'anon', 'public.write_finance_document(text,jsonb,bigint)', 'execute'),
          'anon cannot call the writer');
select ok(has_function_privilege(
            'authenticated', 'public.write_finance_document(text,jsonb,bigint)', 'execute'),
          'authenticated can call the writer');
select ok(
  has_table_privilege('service_role', 'public.finance_documents', 'select,insert')
  and not has_table_privilege(
    'service_role', 'public.finance_documents', 'update,delete,truncate,references,trigger'),
  'service role has only insert-once importer privileges'
);

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select throws_ok(
  $$ select public.write_finance_document('finance', '{}'::jsonb, 0) $$,
  '42501', 'anonymous callers cannot execute the writer'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run the database test and verify the missing relation fails**

```powershell
npx --yes supabase@2.105.0 start
npx --yes supabase@2.105.0 test db supabase/tests/finance_documents.test.sql
```

Expected: FAIL because `public.finance_documents` and its RPC do not exist.

- [ ] **Step 3: Implement the migration with a locked-down security-definer RPC**

Use this contract in `supabase/migrations/20260916000000_finance_documents.sql`:

```sql
create table public.finance_documents (
  owner_id uuid not null references auth.users(id) on delete cascade,
  document_key text not null check (document_key in ('finance', 'finance-camera-views')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, document_key)
);

alter table public.finance_documents enable row level security;
revoke all on table public.finance_documents from public, anon, authenticated, service_role;
grant select on table public.finance_documents to authenticated;
grant select, insert on table public.finance_documents to service_role;

create policy finance_documents_select_own
on public.finance_documents for select to authenticated
using (owner_id = auth.uid());

create function public.write_finance_document(
  p_document_key text,
  p_payload jsonb,
  p_expected_revision bigint
) returns public.finance_documents
language plpgsql security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_saved public.finance_documents;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if p_document_key not in ('finance', 'finance-camera-views') then
    raise exception using errcode = '22023', message = 'invalid_finance_document_key';
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'finance_payload_must_be_object';
  end if;

  if p_expected_revision = 0 then
    insert into public.finance_documents (owner_id, document_key, payload)
    values (v_owner, p_document_key, p_payload)
    on conflict do nothing
    returning * into v_saved;
  elsif p_expected_revision > 0 then
    update public.finance_documents
       set payload = p_payload, revision = revision + 1, updated_at = now()
     where owner_id = v_owner
       and document_key = p_document_key
       and revision = p_expected_revision
    returning * into v_saved;
  end if;

  if v_saved.owner_id is null then
    raise exception using errcode = '40001', message = 'finance_revision_conflict';
  end if;
  return v_saved;
end;
$$;

revoke all on function public.write_finance_document(text, jsonb, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.write_finance_document(text, jsonb, bigint)
  to authenticated;
```

- [ ] **Step 4: Configure the committed passkey boundary and rerun database tests**

Set these exact values in `supabase/config.toml`:

```toml
project_id = "edicius-hq"

[auth]
site_url = "https://edicius-hq-web.vercel.app"
additional_redirect_urls = []

[auth.passkey]
enabled = true

[auth.webauthn]
rp_display_name = "Edicius HQ"
rp_id = "edicius-hq-web.vercel.app"
rp_origins = ["https://edicius-hq-web.vercel.app"]
```

Then run:

```powershell
npx --yes supabase@2.105.0 db reset
npx --yes supabase@2.105.0 test db
```

Expected: every Supabase test passes from a clean database.

- [ ] **Step 5: Commit the database contract**

```powershell
git add supabase/config.toml supabase/migrations/20260916000000_finance_documents.sql supabase/tests/finance_documents.test.sql
git commit -m "feat(finance): add versioned Supabase documents"
```

---

### Task 2: Add the Typed Supabase Client and Auth Adapter

**Files:**

- Create: `apps/web/src/shared/supabase/database.types.ts`
- Create: `apps/web/src/shared/supabase/client.ts`
- Create: `apps/web/src/shared/supabase/client.test.ts`
- Create: `apps/web/src/shared/auth/supabaseAuth.ts`
- Create: `apps/web/src/shared/auth/supabaseAuth.test.ts`
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`

**Interfaces:**

- Produces: `supabase`; auth helpers whose final optional `SupabaseClient` parameter is
  injected only by tests: `getAccessToken(client?): Promise<string | null>`,
  `signInWithPasskey(client?): Promise<void>`,
  `registerPasskey(client?): Promise<PasskeySummary>`,
  `listPasskeys(client?): Promise<PasskeySummary[]>`,
  `deletePasskey(id: string, client?): Promise<void>`, `signOut(client?): Promise<void>`,
  `clearLocalSession(client?): Promise<void>`, and `subscribeToAuth(callback, client?): () => void`.
- `PasskeySummary` is `{ id: string; friendlyName: string | null; createdAt: string; lastUsedAt: string | null }`.

- [ ] **Step 1: Install the SDK and generate local database types**

```powershell
npm install -w web "@supabase/supabase-js@^2.105.0"
npx --yes supabase@2.105.0 gen types typescript --local | Set-Content -Encoding utf8 apps/web/src/shared/supabase/database.types.ts
```

- [ ] **Step 2: Write failing client and adapter tests**

Assert that missing public configuration throws a named configuration error, the client
enables passkeys/persistent sessions/refresh/URL detection, and every adapter method
turns a returned Supabase `error` into a rejected promise. Use this representative fake:

```ts
const auth = {
  getSession: vi.fn(async () => ({
    data: { session: { access_token: 'jwt-one' } },
    error: null,
  })),
  signInWithPasskey: vi.fn(async () => ({ data: { session: {} }, error: null })),
  registerPasskey: vi.fn(async () => ({
    data: { id: 'pk-1', friendly_name: 'Windows Hello', created_at: '2026-09-16T00:00:00Z' },
    error: null,
  })),
  passkey: {
    list: vi.fn(async () => ({ data: [], error: null })),
    delete: vi.fn(async () => ({ data: null, error: null })),
  },
  signOut: vi.fn(async () => ({ error: null })),
  onAuthStateChange: vi.fn(),
};

await expect(getAccessToken(authClient(auth))).resolves.toBe('jwt-one');
await expect(registerPasskey(authClient(auth))).resolves.toMatchObject({
  id: 'pk-1',
  friendlyName: 'Windows Hello',
});
await deletePasskey('pk-1', authClient(auth));
expect(auth.passkey.delete).toHaveBeenCalledWith({ passkeyId: 'pk-1' });
```

- [ ] **Step 3: Run the targeted tests and verify the modules are missing**

```powershell
npm test -w web -- src/shared/supabase/client.test.ts src/shared/auth/supabaseAuth.test.ts
```

Expected: FAIL on unresolved client/auth modules.

- [ ] **Step 4: Implement the client and narrow adapter**

`client.ts` validates the two variables before calling:

```ts
createClient<Database>(url, publishableKey, {
  auth: {
    experimental: { passkey: true },
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
```

`supabaseAuth.ts` contains the only direct calls to experimental passkey methods. Keep
the SDK injectable in tests and implement token retrieval exactly as:

```ts
export async function getAccessToken(client: SupabaseClient = supabase) {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
}
```

Map snake-case passkey metadata into `PasskeySummary`; route deletion only through
`auth.passkey.delete({ passkeyId: id })`; return only the unsubscribe function from
`onAuthStateChange`; use `signOut({ scope: 'local' })` only for local 401
recovery and ordinary `signOut()` for a user-requested logout. During client bootstrap,
remove the obsolete `edicius-hq.session-token` key once; test that this cleanup does not
touch Supabase's own persisted session key.

- [ ] **Step 5: Document public browser configuration and rerun tests**

Add to `.env.example`:

```dotenv
VITE_SUPABASE_URL=https://abndifkxpfppmllgxfnu.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_in_ignored_dotenv
```

Run:

```powershell
npm test -w web -- src/shared/supabase/client.test.ts src/shared/auth/supabaseAuth.test.ts
npm run typecheck -w web
```

Expected: PASS.

- [ ] **Step 6: Commit the browser boundary**

```powershell
git add apps/web/package.json package-lock.json .env.example apps/web/src/shared/supabase apps/web/src/shared/auth/supabaseAuth.ts apps/web/src/shared/auth/supabaseAuth.test.ts
git commit -m "feat(auth): add Supabase passkey client"
```

---

### Task 3: Replace the Application Login and Enrolment UI

**Files:**

- Create: `apps/web/src/shared/auth/useSupabaseSession.ts`
- Create: `apps/web/src/shared/auth/useSupabaseSession.test.tsx`
- Create: `apps/web/src/features/auth/AccountControls.tsx`
- Create: `apps/web/src/features/auth/AccountControls.module.css`
- Create: `apps/web/src/features/auth/AccountControls.test.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/App.test.tsx`
- Modify: `apps/web/src/features/auth/LoginScreen.tsx`
- Modify: `apps/web/src/features/auth/LoginScreen.test.tsx`
- Modify: `apps/web/src/app/layout/TopNav.tsx`
- Modify: `apps/web/src/app/layout/drawerFits.test.ts`
- Delete: `apps/web/src/features/auth/EnrolDevice.tsx`
- Delete: `apps/web/src/features/auth/EnrolDevice.module.css`
- Delete: `apps/web/src/features/auth/EnrolDevice.test.tsx`
- Delete: `apps/web/src/features/auth/ceremony.ts`
- Delete: `apps/web/src/shared/auth/session.ts`

**Interfaces:**

- Consumes: Task 2 auth adapter.
- Produces: `useSupabaseSession(): { status: 'checking' | 'authenticated' | 'anonymous' }` and UI that exposes only passkey sign-in, add-passkey, and sign-out actions.

- [ ] **Step 1: Rewrite auth tests first**

Cover these exact transitions:

```ts
it('waits for the initial Supabase session before rendering either gate', async () => {
  const session = deferred<Session | null>();
  mockGetSession.mockReturnValue(session.promise);
  render(<App />);
  expect(screen.queryByText('Sign in with passkey')).not.toBeInTheDocument();
  session.resolve(null);
  expect(await screen.findByText('Sign in with passkey')).toBeInTheDocument();
});

it('opens the app from a SIGNED_IN event and closes it from SIGNED_OUT', async () => {
  render(<App />);
  emitAuth('SIGNED_IN', signedInSession);
  expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  emitAuth('SIGNED_OUT', null);
  expect(await screen.findByText('Sign in with passkey')).toBeInTheDocument();
});
```

Also assert cancellation stays on the login screen, genuine errors render one alert,
`AccountControls` registers a passkey and reports its friendly name, logout calls
Supabase, and no enrolment-code field/copy remains.

- [ ] **Step 2: Run the auth/UI tests and verify old behavior fails**

```powershell
npm test -w web -- src/app/App.test.tsx src/features/auth/LoginScreen.test.tsx src/features/auth/AccountControls.test.tsx src/shared/auth/useSupabaseSession.test.tsx
```

Expected: FAIL because the hook and account controls do not exist and the old screen
still exposes enrolment codes.

- [ ] **Step 3: Implement reactive session state and passkey-only login**

On mount, `useSupabaseSession` subscribes first and then calls `getSession`, so an auth
event cannot fall into a gap between the initial read and listener registration. Ignore
late resolution after unmount. `LoginScreen` has one primary
button whose action is:

```ts
async function runSignIn() {
  setBusy(true);
  setMessage(null);
  try {
    await signInWithPasskey();
  } catch (error) {
    setMessage(describePasskeyError(error));
  } finally {
    setBusy(false);
  }
}
```

`App` renders the router only for `authenticated`, the login only for `anonymous`, and
nothing private while `checking`. It no longer calls `/api/auth/session`.

- [ ] **Step 4: Replace enrolment codes with account controls**

Render `AccountControls` in both TopNav menu branches. Its actions are:

```ts
await registerPasskey();
await signOut();
```

Show `Add passkey` and `Sign out`; do not show email, password, magic-link, enrolment
code, or local-PC instructions. Keep the existing menu width/responsive invariant in
`drawerFits.test.ts`, renamed to refer to `AccountControls`.

- [ ] **Step 5: Delete old local ceremony files and run the focused suite**

```powershell
npm test -w web -- src/app/App.test.tsx src/features/auth/LoginScreen.test.tsx src/features/auth/AccountControls.test.tsx src/app/layout/drawerFits.test.ts
npm run typecheck -w web
```

Expected: PASS with no imports from `ceremony.ts` or `session.ts`.

- [ ] **Step 6: Commit the UI cutover**

```powershell
git add -A apps/web/src/app apps/web/src/features/auth apps/web/src/shared/auth
git commit -m "feat(auth): use one Supabase passkey session"
```

---

### Task 4: Validate Supabase JWTs in FastAPI

**Files:**

- Create: `services/api/app/services/supabase_jwt.py`
- Create: `services/api/tests/test_supabase_jwt.py`
- Modify: `services/api/app/auth.py`
- Modify: `services/api/tests/test_gate.py`
- Modify: `services/api/app/config.py`
- Modify: `services/api/requirements.txt`

**Interfaces:**

- Produces: immutable `AuthenticatedUser(user_id: UUID)` and `SupabaseJwtVerifier.verify(token: str) -> AuthenticatedUser`.
- `require_session(request: Request) -> AuthenticatedUser` remains the sole FastAPI gate interface.

- [ ] **Step 1: Add pinned JWT dependencies and write failing verifier tests**

Add:

```text
PyJWT[crypto]==2.14.0
```

Install the pinned environment before running tests:

```powershell
python -m pip install -r services/api/requirements.txt
```

Tests generate an ephemeral ES256 key and serve its public JWK through injected
`httpx.MockTransport`. Cover a valid token plus wrong signature, algorithm, issuer,
audience, role, expiration, not-before, missing/invalid UUID subject, unavailable JWKS,
cached-key reuse, and one refresh on an unknown `kid`.

Use this valid claim set:

```python
claims = {
    "iss": "https://abndifkxpfppmllgxfnu.supabase.co/auth/v1",
    "aud": "authenticated",
    "role": "authenticated",
    "sub": "11111111-1111-1111-1111-111111111111",
    "iat": now,
    "nbf": now,
    "exp": now + 300,
}
```

- [ ] **Step 2: Run the verifier/gate tests and verify the module is missing**

```powershell
npm run api:test -- -q tests/test_supabase_jwt.py tests/test_gate.py
```

Expected: FAIL on unresolved `supabase_jwt` and old opaque-token behavior.

- [ ] **Step 3: Implement strict configuration and verification**

`config.py` reads `SUPABASE_URL`, strips one trailing slash, requires the exact HTTPS
project host, and derives:

```python
url = os.environ["SUPABASE_URL"].rstrip("/")
if url != "https://abndifkxpfppmllgxfnu.supabase.co":
    raise ValueError("SUPABASE_URL must name the edicius-hq HTTPS project host")
issuer = f"{url}/auth/v1"
jwks_url = f"{issuer}/.well-known/jwks.json"
audience = "authenticated"
```

Validate this once during FastAPI lifespan startup. The verifier allows only
`ES256` and `RS256`, requires `exp`, `iat`, `nbf`, `iss`, `aud`, `sub`, and `role`, and
checks `role == 'authenticated'` after decoding. Cache JWKS for ten minutes and refresh
once when the token's `kid` is absent; never fall back to the old JWT secret or accept
`alg=none`/HS256.

- [ ] **Step 4: Replace the gate implementation**

Reduce `auth.py` to header parsing, one uniform 401, and verifier delegation:

```python
def require_session(request: Request) -> AuthenticatedUser:
    token = bearer_token(request)
    if not token:
        raise _unauthenticated()
    try:
        return configured_verifier().verify(token)
    except SupabaseTokenError as error:
        raise _unauthenticated() from error

require_session_gate = require_session
```

Delete `STREAM_PATHS`, `TOKEN_QUERY_PARAM`, and query-token acceptance. Update gate tests
to assert every private route uses the same header-only dependency and `?token=` gets 401.

- [ ] **Step 5: Run backend checks**

```powershell
npm run lint:api
npm run typecheck:api
npm run api:test -- -q tests/test_supabase_jwt.py tests/test_gate.py
```

Expected: PASS.

- [ ] **Step 6: Commit JWT authentication**

```powershell
git add services/api/requirements.txt services/api/app/config.py services/api/app/auth.py services/api/app/services/supabase_jwt.py services/api/tests/test_supabase_jwt.py services/api/tests/test_gate.py
git commit -m "feat(api): validate Supabase access tokens"
```

---

### Task 5: Send Browser API and SSE Traffic with the Supabase Token

**Files:**

- Modify: `apps/web/src/shared/api/http.ts`
- Modify: `apps/web/src/shared/api/http.test.ts`
- Create: `apps/web/src/shared/api/eventStream.ts`
- Create: `apps/web/src/shared/api/eventStream.test.ts`
- Modify: `apps/web/src/features/investing/data/quoteStream.ts`
- Modify: `apps/web/src/features/investing/data/quoteStream.test.ts`
- Modify: `apps/web/src/features/airfare/data/collectionStream.ts`
- Modify: `apps/web/src/features/airfare/data/collectionStream.test.ts`
- Modify: `apps/web/src/features/airfare/hooks/useRouteCollection.test.tsx`
- Modify: `apps/web/src/features/airfare/hooks/useHorizonCollection.test.tsx`
- Modify: `apps/web/src/shared/api/tweets.ts`
- Create: `apps/web/src/shared/api/tweets.test.ts`
- Modify: `apps/web/src/test/setup.ts`
- Delete: `apps/web/src/shared/auth/streamUrl.ts`
- Delete: `apps/web/src/shared/auth/streamUrl.test.ts`

**Interfaces:**

- Produces: `apiFetch(path, init)` that awaits the current access token and `openApiEventStream(path, handlers, options?): () => void`.
- `EventStreamHandlers` contains `onOpen?`, `onEvent(event: { type: string; data: string; id: string | null })`, and `onError?`.

- [ ] **Step 1: Write failing HTTP and stream transport tests**

Assert ordinary fetch adds `Authorization: Bearer jwt-one`, omits it when signed out,
and performs local Supabase sign-out on 401. For SSE, feed deliberately split chunks:

```ts
const chunks = [
  'id: 41\nevent: quo',
  'tes\ndata: [{"symbol":"AAPL"}]\n\n',
  ': keep-alive\n\nid: 42\nevent: quotes\ndata: []\n\n',
];
```

Assert one parsed event per complete frame, comment ignored, `Last-Event-ID: 42` on
reconnect, authorization in headers, no `token=` in the URL, abort stops reconnecting,
and a 401 invokes the auth-expired path. Use fake timers for the 3,000 ms reconnect.

- [ ] **Step 2: Run focused tests and verify failures**

```powershell
npm test -w web -- src/shared/api/http.test.ts src/shared/api/eventStream.test.ts src/features/investing/data/quoteStream.test.ts src/features/airfare/data/collectionStream.test.ts
```

Expected: FAIL because HTTP still reads a local token and streams still construct
`EventSource` URLs.

- [ ] **Step 3: Make ordinary API fetch asynchronous over the auth adapter**

Use:

```ts
const token = await getAccessToken();
if (token && !headers.has('Authorization')) {
  headers.set('Authorization', `Bearer ${token}`);
}
const response = await fetch(url, { ...options, headers });
if (response.status === 401) await clearLocalSession();
```

Preserve timeout composition and response parsing. Never retry a non-idempotent API
request inside this layer.

- [ ] **Step 4: Implement the shared SSE parser/reconnect loop**

`openApiEventStream` uses `apiFetch` with `Accept: text/event-stream` and an
`AbortController`. Parse UTF-8 with a streaming `TextDecoder`, join repeated `data:`
lines with `\n`, default missing event types to `message`, remember the last nonempty
`id`, and reconnect after 3 seconds only when not aborted. Send remembered IDs via the
`Last-Event-ID` header.

- [ ] **Step 5: Migrate all four stream paths**

Map the common callback without changing feature wire types:

```ts
return openApiEventStream('/api/market/stream?symbols=AAPL%2CMSFT', {
  onOpen: options.onOpen,
  onError: options.onError,
  onEvent(event) {
    if (event.type !== 'quotes') return;
    const ticks = JSON.parse(event.data) as Tick[];
    if (Array.isArray(ticks) && ticks.length) options.onTicks(ticks);
  },
});
```

Apply the same transport to board collection, calendar collection, and tweet streams.
Replace injected `EventSource` fakes with an injected `open` function, remove the global
jsdom `EventSource` shim, and delete `streamUrl`.

- [ ] **Step 6: Run all stream and affected hook tests**

```powershell
npm test -w web -- src/shared/api/http.test.ts src/shared/api/eventStream.test.ts src/features/investing/data/quoteStream.test.ts src/features/airfare/data/collectionStream.test.ts src/features/airfare/hooks/useRouteCollection.test.tsx src/features/airfare/hooks/useHorizonCollection.test.tsx
npm run typecheck -w web
```

Expected: PASS and `rg -n "EventSource|withStreamToken|[?&]token=" apps/web/src` finds no
production call site.

- [ ] **Step 7: Commit authenticated transport**

```powershell
git add -A apps/web/src/shared apps/web/src/features/investing/data apps/web/src/features/airfare/data apps/web/src/features/airfare/hooks apps/web/src/test
git commit -m "feat(auth): send JWTs in API stream headers"
```

---

### Task 6: Build the Direct Finance Data Boundary

**Files:**

- Create: `apps/web/src/features/finance/data/financeDocuments.ts`
- Create: `apps/web/src/features/finance/data/financeDocuments.test.ts`
- Create: `apps/web/src/features/finance/hooks/useRemoteDocument.ts`
- Create: `apps/web/src/features/finance/hooks/useRemoteDocument.test.tsx`
- Modify: `apps/web/src/shared/storage/writeQueue.ts`
- Modify: `apps/web/src/shared/storage/writeQueue.test.ts`

**Interfaces:**

- `FinanceDocumentKey = 'finance' | 'finance-camera-views'`.
- `RemoteDocument<T> = { payload: T; revision: number; updatedAt: string }`.
- `DocumentConflict<T> = { status: 'loading'; local: T } | { status: 'load-failed'; local: T } | { status: 'ready'; local: T; remote: T; remoteRevision: number }`.
- `readFinanceDocument<T>(key, signal?): Promise<RemoteDocument<T> | null>`.
- `writeFinanceDocument<T>(key, payload, expectedRevision): Promise<RemoteDocument<T>>`.
- `FinanceRevisionConflict` is the only conflict error recognized by the hook.
- `useRemoteDocument<T>(options)` preserves the required `StoredDocument<T>` editing surface and adds `conflict: DocumentConflict<T> | null`, `refreshConflict(): Promise<void>`, `acceptRemote(): void`, and `overwriteRemote(): Promise<void>`.

- [ ] **Step 1: Write failing data-boundary tests**

Use an injected Supabase client and assert the exact calls:

```ts
expect(from).toHaveBeenCalledWith('finance_documents');
expect(eq).toHaveBeenNthCalledWith(1, 'document_key', 'finance');
expect(rpc).toHaveBeenCalledWith('write_finance_document', {
  p_document_key: 'finance',
  p_payload: document,
  p_expected_revision: 7,
});
```

Assert PostgREST code `40001` becomes `FinanceRevisionConflict`, a missing row is null,
and all other errors retain a sanitized message without request headers or tokens.

- [ ] **Step 2: Write failing hook/queue tests**

Cover initial read, missing-row revision zero, normalization, optimistic local edits,
400 ms debounce, strictly serialized writes, revision 1 then 2 across consecutive
writes, failed-write retry retaining the newest payload, conflict state retaining the
local and freshly fetched remote payloads, deliberate accept-remote and overwrite-remote
resolution, replace waiting for confirmation, and pagehide / visibilitychange / unmount
flush.

Add this write acknowledgement to the generic queue instead of hiding revision state in
the transport:

```ts
export type WriteQueueOptions<T, A = void> = {
  write: (value: T) => Promise<A>;
  onWritten?: (acknowledgement: A) => void;
  onError?: (error: unknown, value: T) => void;
  onState: (state: WriteState) => void;
  delayMs?: number;
};
```

- [ ] **Step 3: Run the focused tests and verify missing-module failures**

```powershell
npm test -w web -- src/features/finance/data/financeDocuments.test.ts src/features/finance/hooks/useRemoteDocument.test.tsx src/shared/storage/writeQueue.test.ts
```

Expected: FAIL on missing Finance data/hook modules and acknowledgement callbacks.

- [ ] **Step 4: Implement the typed Data API boundary**

Select only `payload, revision, updated_at`; rely on RLS rather than sending an owner ID.
Use `.abortSignal(signal)` for reads. RPC writes return one row and map it to camel case.
Never import `shared/api/http`, `shared/api/kv`, or `shared/storage/storage` from this
module.

- [ ] **Step 5: Implement the revision-aware hook**

Keep revision in a ref updated only by successful reads/writes. Each queue pass reads the
ref at send time:

```ts
write: async (payload) => {
  const saved = await writeFinanceDocument(key, payload, revision.current);
  return saved.revision;
},
onWritten(nextRevision) {
  revision.current = nextRevision;
},
onError(error, local) {
  if (!(error instanceof FinanceRevisionConflict)) return;
  setConflict({ status: 'loading', local });
  void loadConflict(local);
},
```

A failed initial read leaves React Query data undefined, reports `blocked`, and refuses
edits. A conflict immediately refetches into a separate conflict record while keeping
the optimistic local payload on screen. `loadConflict` moves to `ready` with the remote
payload/revision or `load-failed` without dropping `local`; `refreshConflict` retries the
same read. `acceptRemote` deliberately replaces the cache and revision with the fetched
row; `overwriteRemote` deliberately writes the retained local payload against
`remoteRevision`. Both choices are available only in `ready` and clear the conflict only
after their state transition succeeds.

- [ ] **Step 6: Run focused Finance storage tests**

```powershell
npm test -w web -- src/features/finance/data/financeDocuments.test.ts src/features/finance/hooks/useRemoteDocument.test.tsx src/shared/storage/writeQueue.test.ts
npm run typecheck -w web
```

Expected: PASS.

- [ ] **Step 7: Commit the remote document module**

```powershell
git add apps/web/src/features/finance/data apps/web/src/features/finance/hooks/useRemoteDocument.ts apps/web/src/features/finance/hooks/useRemoteDocument.test.tsx apps/web/src/shared/storage/writeQueue.ts apps/web/src/shared/storage/writeQueue.test.ts
git commit -m "feat(finance): add revisioned Supabase document store"
```

---

### Task 7: Cut Finance Hooks and UI Over to Supabase

**Files:**

- Modify: `apps/web/src/features/finance/hooks/useFinanceData.ts`
- Modify: `apps/web/src/features/finance/hooks/useFinanceData.test.tsx`
- Modify: `apps/web/src/features/finance/hooks/useDiagramCamera.ts`
- Modify: `apps/web/src/features/finance/hooks/useDiagramCamera.test.tsx`
- Modify: `apps/web/src/features/finance/FinancePage.tsx`
- Create: `apps/web/src/features/finance/FinancePage.test.tsx`
- Modify: `apps/web/src/shared/storage/keys.ts`
- Delete: `apps/web/src/features/finance/ui/BackupControls.tsx`
- Delete: `apps/web/src/features/finance/ui/BackupControls.module.css`
- Delete: `apps/web/src/features/finance/ui/BackupControls.test.tsx`
- Delete: `apps/web/src/features/finance/lib/backup.ts`
- Delete: `apps/web/src/features/finance/lib/backup.test.ts`

**Interfaces:**

- Consumes: `useRemoteDocument` from Task 6.
- Produces: unchanged Finance editing commands plus remote save/error/conflict state; no file import/export surface.

- [ ] **Step 1: Rewrite feature tests before changing hooks**

Replace `stubKvStore` with a Supabase Finance fake. Assert both keys load in parallel,
document edits call the RPC with the fetched revision, camera updates use
`finance-camera-views`, a conflict presents an alert and does not claim `Saved`, and no
rendered `Export`/`Import` buttons or file input remain.

Add a source-level guard:

```ts
const production = import.meta.glob(
  ['./**/*.ts', './**/*.tsx', '!./**/*.test.ts', '!./**/*.test.tsx'],
  {
    eager: true,
    query: '?raw',
    import: 'default',
  },
) as Record<string, string>;

for (const [path, source] of Object.entries(production)) {
  expect(source, path).not.toMatch(/shared\/(api\/kv|storage\/storage|storage\/useStoredDocument)/);
}
```

- [ ] **Step 2: Run focused Finance tests and verify old KV/file behavior fails**

```powershell
npm test -w web -- src/features/finance/hooks/useFinanceData.test.tsx src/features/finance/hooks/useDiagramCamera.test.tsx src/features/finance
```

Expected: FAIL because hooks still use local KV and backup controls are still rendered.

- [ ] **Step 3: Switch both hooks to `useRemoteDocument`**

Use key `finance` with `normalizeDocument`/`EMPTY_DOCUMENT`, and key
`finance-camera-views` with `normalizeFinanceCameraViews`/`NO_FINANCE_CAMERA_VIEWS`.
Preserve all editing commands and in-memory histories. Return `conflict` and the
reconciliation action alongside `saveState`/`retrySave`.

- [ ] **Step 4: Remove all Finance file and KV surfaces**

Remove `BackupControls`, restore parsing, and the `restore` action. Delete the backup
modules/tests/styles. Remove both Finance keys from `STORAGE_KEYS`; this makes any future
accidental `/api/kv/finance*` call fail at the shared client allowlist before network.

- [ ] **Step 5: Add explicit failure and conflict UI**

Keep the existing first-load and save-state behavior. Add an alert with this semantic
copy and, once the remote copy is loaded, two buttons wired to `acceptRemote` and
`overwriteRemote`:

```text
Finance changed in another session. Your unsaved version is still in this tab.
Choose the Supabase version or deliberately replace it with this tab's version.
```

Disable new edits while conflict reconciliation is pending; do not discard current
in-memory data merely because the refetch failed. A `load-failed` conflict displays a
`Retry loading Supabase version` button wired to `refreshConflict`.

- [ ] **Step 6: Run the entire Finance suite and typecheck**

```powershell
npm test -w web -- src/features/finance src/shared/storage
npm run typecheck -w web
rg -n "(/api/kv/finance|finance-camera-views.*api/kv|BackupControls|readBackup|createBackup)" apps/web/src
```

Expected: tests/typecheck PASS; ripgrep returns no production Finance persistence/file
call site.

- [ ] **Step 7: Commit the Finance cutover**

```powershell
git add -A apps/web/src/features/finance apps/web/src/shared/storage/keys.ts
git commit -m "feat(finance): persist directly to Supabase"
```

---

### Task 8: Build the Idempotent Finance Import and Verification Command

**Files:**

- Create: `scripts/finance-supabase.py`
- Create: `services/api/tests/test_finance_supabase_script.py`
- Modify: `scripts/api.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces: `npm run finance:supabase -- --dry-run|--apply|--verify --owner-id UUID --source DIRECTORY --report FILE`.
- Report entries are `{ key, sourceBytes, sourceSha256, destinationRevision, destinationSha256, matches }`; reports never contain payloads, URLs with credentials, request headers, or secrets.

- [ ] **Step 1: Write failing importer tests with mocked HTTP**

Load the real script through `importlib.util`. Use temporary `finance.json` and
`finance-camera-views.json` objects. Cover missing files, invalid/non-object JSON,
canonical digest stability across whitespace/key order, dry-run making zero requests,
apply inserting absent rows, retry-safe repeated apply, refusal to mutate a mismatched
existing row, verify
match/mismatch/missing destination, owner UUID validation, host allowlist, secret
redaction, and an atomic report write.

Canonical encoding is exact:

```python
def canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
```

- [ ] **Step 2: Run the script tests and verify the command is missing**

```powershell
npm run api:test -- -q tests/test_finance_supabase_script.py
```

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement dry-run, apply, and verify**

Read only these exact files from `--source`:

```python
DOCUMENTS = {
    "finance": "finance.json",
    "finance-camera-views": "finance-camera-views.json",
}
```

Require `SUPABASE_URL` and `SUPABASE_SECRET_KEY` only for apply/verify. Restrict the URL
to the configured HTTPS Supabase project host. Send the secret in both `apikey` and
`Authorization: Bearer` headers, refuse redirects, and sanitize every external error.
Before each apply, select `(owner_id,document_key)`. Insert an absent row at revision 1;
treat an identical existing row as an idempotent no-op; refuse a different existing row
without mutation. Verify by selecting the two rows and comparing canonical SHA-256
digests. This prevents a rerun from resetting or overwriting a document edited after
cutover.

- [ ] **Step 4: Expose the command through the repository launcher**

Add `finance-supabase` to `scripts/api.mjs` modes and:

```json
"finance:supabase": "node scripts/api.mjs finance-supabase"
```

to root `package.json`.

- [ ] **Step 5: Run importer checks**

```powershell
npm run api:test -- -q tests/test_finance_supabase_script.py
npm run finance:supabase -- --dry-run --owner-id 11111111-1111-1111-1111-111111111111 --source services/api/.local-data/kv
npm run lint:api
npm run typecheck:api
```

Expected: PASS; dry-run reports exactly two documents and performs no network request.

- [ ] **Step 6: Commit the migration command**

```powershell
git add scripts/finance-supabase.py services/api/tests/test_finance_supabase_script.py scripts/api.mjs package.json
git commit -m "feat(finance): add verified Supabase importer"
```

---

### Task 9: Retire Local Authentication and Finance KV Access

**Files:**

- Modify: `services/api/app/main.py`
- Modify: `services/api/app/routers/kv.py`
- Modify: `services/api/tests/test_kv.py`
- Modify: `scripts/api.mjs`
- Modify: `.env.example`
- Delete: `services/api/app/routers/auth.py`
- Delete: `services/api/app/services/auth_store.py`
- Delete: `services/api/app/services/webauthn_ceremony.py`
- Delete: `services/api/app/cli/auth_cli.py`
- Delete: `services/api/tests/test_auth_router.py`
- Delete: `services/api/tests/test_auth_store.py`
- Delete: `services/api/tests/test_webauthn_ceremony.py`

**Interfaces:**

- Consumes: Task 4 JWT gate.
- Produces: no `/api/auth/*` routes, no local WebAuthn/session files, and no allowlisted Finance KV key.

- [ ] **Step 1: Write regression assertions before deletion**

Update route/gate tests to assert:

```python
paths = {route.path for route in app.routes}
assert not any(path.startswith("/api/auth/") for path in paths)

for key in ("finance", "finance-camera-views"):
    response = client.get(f"/api/kv/{key}", headers=valid_supabase_header)
    assert response.status_code == 404
```

Also assert every non-root API route remains gated by the Supabase verifier.

- [ ] **Step 2: Run gate/KV tests and verify old routes still violate the contract**

```powershell
npm run api:test -- -q tests/test_gate.py tests/test_kv.py
```

Expected: FAIL because local auth routes and Finance KV keys still exist.

- [ ] **Step 3: Remove local auth registration and files**

Stop including `auth_router` from `main.py`; delete its router, store, ceremony, CLI, and
tests. Remove `enroll`, `credentials`, and `revoke` modes from `scripts/api.mjs`. Remove
the `webauthn` package from requirements after confirming no import remains, then run:

```powershell
python -m pip install -r services/api/requirements.txt
```

- [ ] **Step 4: Remove Finance from API storage and local WebAuthn configuration**

Delete `finance` and `finance-camera-views` from the backend KV allowlist in
`config.py`. Do not delete their physical source files. Remove `WEBAUTHN_RP_ID` and
`WEBAUTHN_ORIGIN` from `.env.example`; document `SUPABASE_URL` as JWT issuer input and
keep `SUPABASE_SECRET_KEY` explicitly administrative-only.

- [ ] **Step 5: Run all backend tests and static checks**

```powershell
npm run lint:api
npm run typecheck:api
npm run api:test -- -q
rg -n "auth_store|webauthn_ceremony|WEBAUTHN_|api/auth|finance-camera-views|['\"]finance['\"]" services/api scripts/api.mjs
```

Expected: all gates pass; remaining Finance strings occur only in importer tests/script,
not API runtime storage.

- [ ] **Step 6: Commit the local-runtime removal**

```powershell
git add -A services/api scripts/api.mjs .env.example
git commit -m "refactor(auth): remove PC-backed sessions"
```

---

### Task 10: Document Operations and Run the Complete Local Gate

**Files:**

- Modify: `docs/deploy-plan.md`
- Create: `docs/finance-supabase-results.md`

**Interfaces:**

- Produces: an exact rollout/rollback/cleanup runbook and a blank results structure that accepts only sanitized evidence.

- [ ] **Step 1: Update the runbook with exact boundaries and commands**

Document:

```powershell
npx --yes supabase@2.105.0 link --project-ref abndifkxpfppmllgxfnu
npx --yes supabase@2.105.0 db push --dry-run
npx --yes supabase@2.105.0 config push --project-ref abndifkxpfppmllgxfnu
npx --yes supabase@2.105.0 db push
npx --yes supabase@2.105.0 migration list
```

State explicitly that `db reset --linked`, table truncation, and local-file deletion are
forbidden. Record the Vercel public variables, API `SUPABASE_URL`, the one-time magic
link/bootstrap, passkey registration, disabling exposed bootstrap UI, importer commands,
smoke tests, rollback boundary, and later cleanup command.

- [ ] **Step 2: Create the sanitized results template**

Use sections for schema/config result, owner UUID (UUID is allowed), source/destination
digests, passkey proof without credential IDs, Finance latency, API/JWT smoke results,
all four SSE streams, Supabase database/storage/egress resource readings, rollback
readiness, and local-file cleanup status. Never include the owner's email, magic link,
JWT, passkey ID, publishable/secret key, or full JSON payload.

- [ ] **Step 3: Run the complete local gate**

```powershell
npx --yes supabase@2.105.0 db reset
npx --yes supabase@2.105.0 test db
npm run format:check
npm run lint
npm run typecheck
npm test -- --run
npm run build
npm run lint:api
npm run typecheck:api
npm run api:test -- -q
```

Expected: every command exits zero. If repository-wide format checks encounter ignored
generated artifacts, run Prettier on the changed tracked files as an additional scoped
diagnostic, fix tracked violations, and keep the failing global command visible rather
than claiming it passed.

- [ ] **Step 4: Prove forbidden paths are absent**

```powershell
rg -n "withStreamToken|new EventSource|/api/auth/(login|register|session|enrolment-code)|/api/kv/finance|/api/kv/finance-camera-views" apps/web/src services/api/app
git grep -n -E "sb_secret_[A-Za-z0-9]{20,}"
```

Expected: both commands return no matches in tracked production code. The legacy
`edicius-hq.session-token` string remains only in the one-time cleanup and its test.

- [ ] **Step 5: Commit documentation and any gate-only corrections**

```powershell
git add docs/deploy-plan.md docs/finance-supabase-results.md
git commit -m "docs: add Finance Supabase cutover runbook"
```

---

### Task 11: Apply, Import, Enrol, Deploy, and Verify

**Files:**

- Create: `docs/finance-supabase-evidence/source-before.json`
- Create: `docs/finance-supabase-evidence/first-apply.json`
- Create: `docs/finance-supabase-evidence/first-verify.json`
- Create: `docs/finance-supabase-evidence/second-apply.json`
- Create: `docs/finance-supabase-evidence/final-verify.json`
- Modify: `docs/finance-supabase-results.md`

**Interfaces:**

- Consumes: linked Supabase CLI login, ignored `SUPABASE_SECRET_KEY`, owner email supplied only at cutover, the two local source files, and the stable Vercel production origin.
- Produces: migrated revision-1 documents, one registered Supabase passkey, deployed single-session app, and sanitized reviewed evidence.

- [ ] **Step 1: Reconfirm exact remote target and preview changes**

```powershell
npx --yes supabase@2.105.0 projects list
npx --yes supabase@2.105.0 link --project-ref abndifkxpfppmllgxfnu
npx --yes supabase@2.105.0 db push --dry-run
```

Stop unless the linked project is named `edicius-hq`, ref is
`abndifkxpfppmllgxfnu`, and the dry run contains only the new Finance migration.
Open
`https://abndifkxpfppmllgxfnu.supabase.co/auth/v1/.well-known/jwks.json` and require at
least one public key whose `alg` is `ES256` or `RS256`. If the project still uses only a
legacy symmetric JWT secret, rotate to an asymmetric signing key in Supabase and wait
for JWKS propagation before deploying; never add HS256 or the legacy secret to the API
verifier.

- [ ] **Step 2: Push passkey configuration and schema**

```powershell
npx --yes supabase@2.105.0 config push --project-ref abndifkxpfppmllgxfnu
npx --yes supabase@2.105.0 db push
npx --yes supabase@2.105.0 migration list
```

Read back the auth configuration and verify passkeys enabled, RP display name
`Edicius HQ`, RP ID `edicius-hq-web.vercel.app`, and the single production origin.

- [ ] **Step 3: Create the owner and prepare the one-time bootstrap link**

Use the Admin API through the installed Supabase SDK to create the owner if absent and
generate a single-use magic link. Capture the JSON in memory, copy only the action link
to the Windows clipboard, and print only the UUID. Do not open the link yet: the new
account controls must be deployed first. Do not place the email or link in source, shell
history, logs, or reports:

```powershell
$env:SUPABASE_OWNER_EMAIL = Read-Host 'Owner email for the one-time bootstrap'
$bootstrap = node --input-type=module -e @'
import { createClient } from '@supabase/supabase-js';
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, experimental: { passkey: true } },
});
const { data, error } = await client.auth.admin.generateLink({
  type: 'magiclink',
  email: process.env.SUPABASE_OWNER_EMAIL,
  options: { redirectTo: 'https://edicius-hq-web.vercel.app' },
});
if (error) throw error;
process.stdout.write(JSON.stringify({
  ownerId: data.user.id,
  actionLink: data.properties.action_link,
}));
'@ | ConvertFrom-Json
$bootstrap.actionLink | Set-Clipboard
$ownerId = [guid]::Parse($bootstrap.ownerId).ToString()
Remove-Item Env:SUPABASE_OWNER_EMAIL
Write-Host "Owner UUID: $ownerId; bootstrap link copied to clipboard"
```

- [ ] **Step 4: Capture source evidence and import twice**

Set the secret only in the current process environment, never a `VITE_` variable. Then
run with the validated `$ownerId`:

```powershell
npm run finance:supabase -- --dry-run --owner-id $ownerId --source services/api/.local-data/kv --report docs/finance-supabase-evidence/source-before.json
npm run finance:supabase -- --apply --owner-id $ownerId --source services/api/.local-data/kv --report docs/finance-supabase-evidence/first-apply.json
npm run finance:supabase -- --verify --owner-id $ownerId --source services/api/.local-data/kv --report docs/finance-supabase-evidence/first-verify.json
npm run finance:supabase -- --apply --owner-id $ownerId --source services/api/.local-data/kv --report docs/finance-supabase-evidence/second-apply.json
npm run finance:supabase -- --verify --owner-id $ownerId --source services/api/.local-data/kv --report docs/finance-supabase-evidence/final-verify.json
```

Expected: both keys match on both verifies; the second apply changes no payload and
leaves each imported document at revision 1.

- [ ] **Step 5: Configure deployment variables and deploy the atomic cutover**

Retrieve the publishable key without displaying any secret key:

```powershell
$keys = npx --yes supabase@2.105.0 projects api-keys --project-ref abndifkxpfppmllgxfnu --output json | ConvertFrom-Json
$publishableKey = ($keys | Where-Object { $_.name -eq 'publishable' }).api_key
if (-not $publishableKey) { throw 'Supabase publishable key not found' }
```

Vercel receives `VITE_SUPABASE_URL` with the exact URL below,
`VITE_SUPABASE_PUBLISHABLE_KEY` from `$publishableKey`, and its already configured
`VITE_API_URL` unchanged:

```text
VITE_SUPABASE_URL=https://abndifkxpfppmllgxfnu.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=(value selected into $publishableKey)
VITE_API_URL=(retain the currently deployed value)
```

The FastAPI environment receives `SUPABASE_URL`. Retain its existing
`SUPABASE_SECRET_KEY` only because the Airfare replica already uses it; Finance and JWT
verification must not read that secret. Deploy frontend and API from the same reviewed
commit so the new JWT is never sent to the old opaque session gate and the old token is
never sent to the new verifier.

- [ ] **Step 6: Complete the only human ceremony**

After the new frontend and API are live, the human must:

1. open the prepared link on the production domain;
2. choose `Add passkey`;
3. complete the platform biometric/PIN/security-key prompt;
4. sign out;
5. select `Sign in with passkey` in a fresh browser session.

Continue only after `auth.passkey.list()` shows at least one passkey and the fresh
passkey sign-in succeeds. Record only `passkey sign-in: PASS`.

- [ ] **Step 7: Run deployed smoke tests**

On `https://edicius-hq-web.vercel.app`, verify:

1. signed-out state exposes only passkey sign-in;
2. one passkey prompt opens the whole app;
3. Finance loads the expected graph and camera;
4. one edit reaches `Saved`, survives reload, and increments only `finance` revision;
5. one pan/zoom survives reload and increments only `finance-camera-views` revision;
6. a forced stale-revision write shows the conflict state and does not overwrite;
7. Dashboard, Greenlight, Investing, Airfare, and Sentiment API reads succeed;
8. market, board collection, calendar collection, and tweet SSE requests carry an
   Authorization header and no query token;
9. sign-out returns to the passkey screen and a reload restores no private shell.

- [ ] **Step 8: Record resource use and commit sanitized evidence**

Record current Supabase database size, storage size, monthly egress/API request usage,
and the two Finance row sizes from the dashboard/SQL without copying credentials or
payloads. Complete `docs/finance-supabase-results.md`, inspect every evidence file, then:

```powershell
git grep -n -E "sb_secret_|eyJ[A-Za-z0-9_-]{20,}|token=|magiclink|@" -- docs/finance-supabase-evidence docs/finance-supabase-results.md
git add docs/finance-supabase-evidence docs/finance-supabase-results.md
git commit -m "docs: record Finance Supabase cutover evidence"
```

Expected: secret scan returns no matches; commit contains only digests, sizes,
revisions, status, latency, and resource metrics.

- [ ] **Step 9: Preserve rollback artifacts and defer deletion**

Confirm the deployed app makes no read/write to the two files, then leave these exact
files untouched and read-only for the agreed observation window:

```text
services/api/.local-data/kv/finance.json
services/api/.local-data/kv/finance-camera-views.json
```

Open a separate human-gated cleanup issue after a seven-day observation window. Include
the obsolete local auth files in the same reviewed cleanup. Do not delete any of these
files in this implementation plan:

```powershell
$earliestDeletion = (Get-Date).AddDays(7).ToString('yyyy-MM-dd')
$cleanupBody = @"
Production Finance reads/writes have used Supabase for seven days. Before deletion,
re-run docs/finance-supabase-evidence/final-verify.json and confirm the external backup.

Exact targets:
- D:\Work\research\edicius-hq\services\api\.local-data\kv\finance.json
- D:\Work\research\edicius-hq\services\api\.local-data\kv\finance-camera-views.json
- D:\Work\research\edicius-hq\services\api\.local-data\auth\credentials.json
- D:\Work\research\edicius-hq\services\api\.local-data\auth\sessions.json
- D:\Work\research\edicius-hq\services\api\.local-data\auth\challenges.json
- D:\Work\research\edicius-hq\services\api\.local-data\auth\codes.json

Earliest deletion date: $earliestDeletion
Deletion requires a fresh matching verification and explicit human confirmation.
"@
gh issue create --title "Delete retired local Finance and auth files" --body $cleanupBody --label ready-for-human
```

## Primary references

- [Supabase passkey authentication](https://supabase.com/docs/guides/auth/passkeys)
- [Supabase signing keys and JWKS](https://supabase.com/docs/guides/auth/signing-keys)
- [Supabase CLI `config push` and `db push`](https://supabase.com/docs/reference/cli/supabase-config-push)
- [Supabase Admin `generateLink`](https://supabase.com/docs/reference/javascript/auth-admin-generatelink)
