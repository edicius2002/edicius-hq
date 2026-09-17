# Finance Supabase cutover results

Recorded on 2026-09-17 after the approved hosted cutover. This report contains only
sanitized evidence: no email, one-time link, JWT, refresh token, passkey credential ID,
authenticator metadata, API key, request header, SSE frame, or Finance JSON payload is
stored here.

## Schema and Auth configuration

- Project ref verified: `abndifkxpfppmllgxfnu`
- Finance migrations: PASS, including non-retryable stale-revision conflicts through
  HTTP `409` / PostgREST `PT409`
- Remote/local configuration comparison: PASS for passkey, WebAuthn, site URL, redirect,
  and signup settings; unrelated hosted defaults are listed by `supabase config diff`
- Passkeys enabled: PASS
- RP display name / RP ID / sole production origin: `Edicius HQ` /
  `edicius-hq-web.vercel.app` / `https://edicius-hq-web.vercel.app`
- Self-service signup and anonymous sign-in disabled: PASS
- Asymmetric JWKS signing key observed: PASS, one EC/ES256 key
- Vercel variables present in Preview and Production: `VITE_API_URL`,
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
- API issuer configuration and real ES256 bearer validation: PASS

## Owner and imported documents

- Owner UUID: `de8ea1c6-5180-4593-8de6-b69382db84a3`
- `finance`: source/destination SHA-256
  `50a8cf44af6e92017c60662a4b080050c258de9f091e9f65d524c36927d1852f`, current
  revision 16 after reversible smoke writes, exact match PASS
- `finance-camera-views`: source/destination SHA-256
  `21453149f4376e4d607afe80aa5dd16dd97e706749fcb9879e44656ebc7f7221`, current
  revision 11 after reversible smoke writes, exact match PASS
- First apply: both documents inserted at revision 1
- Replay apply: no payload change; both revisions remained 1
- Final verification: PASS; both remote payloads exactly match the retained local sources
- Source payload sizes: `finance` 19,028 bytes; `finance-camera-views` 173 bytes

## Passkey and deployment proof

- Stable frontend: Vercel deployment `dpl_6PE6eF2zrT5aizTKMQr38p87TEih`
- Stable API: Tailscale Funnel paired with the reviewed FastAPI branch
- Bootstrap UI absent from routine sign-in: PASS
- Passkey registration at the stable production origin: PASS
- Fresh passkey sign-in: PASS; Supabase `last_used_at` advanced
- Passkey count: 1; credential identifiers and authenticator metadata omitted

## Finance behavior and latency

- Initial Finance graph and camera load: PASS
- Finance edit reached Saved, survived reload, changed only `finance`, then was restored:
  PASS
- Camera wheel change survived reload, changed only `finance-camera-views`, then was
  restored: PASS
- Forced stale-revision write returned HTTP 409 in 147 ms, displayed conflict state, and
  did not overwrite the newer document: PASS
- Direct Finance read latency, 5 samples: 857.2 ms total, 171.4 ms average, 130.5 ms
  median, 327.8 ms maximum

## API, routes, and SSE smoke checks

- Signed-out page exposed only passkey sign-in; sign-out plus reload restored no private
  shell: PASS
- Dashboard: PASS
- Finance: PASS
- Greenlight: PASS
- Investing: PASS
- Airfare: PASS
- Sentiment: PASS
- Anonymous API health rejected with 401; real Supabase ES256 bearer accepted: PASS
- Market, board-collection, calendar-collection, and tweet SSE: PASS
- Every application API/SSE request used an Authorization header; no query token: PASS
- The isolated headless browser was granted Chrome's `localNetwork` permission, equivalent
  to accepting the one-time browser prompt required because the Funnel hostname resolves to
  a Tailscale address on this PC.

## Supabase resources

- Database size: 114 MB on 2026-09-17
- `public.finance_documents`: 2 rows, 136 KB table + 16 KB index = 152 KB allocated
- Supabase Storage: 0 buckets, 0 object bytes
- Monthly egress: not recorded; the authenticated CLI does not expose the billing-period
  egress report without a Management API analytics token
- Monthly API requests: not recorded for the same reason

## Rollback readiness and local-file cleanup

- Prior stable frontend deployment retained as rollback target:
  `dpl_2LCy64uGHytCZ2hMGXt4VKyjFqEe`
- Local Finance sources remain untouched and retained: PASS
- The five staged importer reports (`source-before`, first apply/verify, replay apply, and
  final verify) are committed as sanitized CLI-shaped evidence under
  `docs/finance-supabase-evidence/`; the Finance payloads remain omitted
- Remote rows preserved; no reset, truncation, or deletion was used: PASS
- Seven-day observation window ends: 2026-09-24
- External backup reconfirmation: not recorded
- Local-file cleanup: not started; deletion requires a separate human-approved issue after
  the observation window
