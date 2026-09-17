# Finance Supabase cutover results (sanitized template)

Complete this document only after the approved hosted cutover. It is a summary of
sanitized evidence, not a place to paste CLI output, dashboard exports, screenshots,
headers, URLs, or JSON documents. Leave a field as `not recorded` rather than adding
sensitive detail.

## Sanitization contract

Allowed values are UUIDs, document keys, SHA-256 digests, revision/count/byte values,
aggregate latency/resource metrics, dates without personal data, and pass/fail status.
Never record an owner email, one-time bootstrap link, JWT, session/refresh token,
passkey credential ID, authenticator metadata, publishable key, secret key, full JSON
payload, credentialed URL, request/response header, or SSE frame. Do not include an
absolute local path.

## Schema and Auth configuration

- Project ref verified: `not recorded`
- Finance migration result: `not recorded`
- Passkeys enabled: `not recorded`
- RP display name / RP ID / sole production origin verified: `not recorded`
- Asymmetric JWKS signing key observed: `not recorded`
- Vercel public-variable names present (values omitted): `not recorded`
- API issuer configuration present (value omitted): `not recorded`

## Owner and imported documents

- Owner UUID: `not recorded`
- `finance` source SHA-256 / destination SHA-256 / revision / matches: `not recorded`
- `finance-camera-views` source SHA-256 / destination SHA-256 / revision / matches: `not recorded`
- First apply outcome: `not recorded`
- Replay apply outcome (no payload change; revision remains 1): `not recorded`
- Final verification outcome: `not recorded`

## Passkey and deployment proof

- Paired frontend/API production deployment: `not recorded`
- Bootstrap UI absent after deployment: `not recorded`
- Passkey registration completed at the stable production origin: `not recorded`
- Fresh passkey sign-in: `not recorded`
- Credential IDs, action links, tokens, and authenticator metadata: omitted

## Finance behavior and latency

- Initial Finance and camera load: `not recorded`
- Finance edit reload persistence / revision change: `not recorded`
- Camera pan/zoom reload persistence / revision change: `not recorded`
- Stale-revision conflict protection: `not recorded`
- Aggregate Finance latency (operation, sample count, aggregate timing): `not recorded`

## API and JWT smoke checks

- Signed-out / sign-out-private-shell behavior: `not recorded`
- Dashboard: `not recorded`
- Greenlight: `not recorded`
- Investing: `not recorded`
- Airfare: `not recorded`
- Sentiment: `not recorded`
- JWT accepted only through an authorization header (header value omitted): `not recorded`

## SSE smoke checks

- Market stream: `not recorded`
- Board-collection stream: `not recorded`
- Calendar-collection stream: `not recorded`
- Tweet stream: `not recorded`
- Every stream used an authorization header and no query token: `not recorded`

## Supabase resource readings

- Database size (value, unit, observation date): `not recorded`
- Storage size (value, unit, observation date): `not recorded`
- Monthly egress (value, unit, observation date): `not recorded`
- Monthly API requests (count, observation date): `not recorded`
- Finance row sizes (document key, byte count only): `not recorded`

## Rollback readiness and local-file cleanup

- Prior paired release identified: `not recorded`
- Local Finance source files untouched and retained: `not recorded`
- Importer reports reviewed and retained: `not recorded`
- Remote rows preserved; no reset/truncation/deletion used: `not recorded`
- Seven-day observation-window end date: `not recorded`
- External backup reconfirmed before cleanup review: `not recorded`
- Separate human-approved cleanup issue: `not recorded`
- Local-file cleanup status: `not started; deletion is outside this cutover`
