# Remediation 3 — Supabase signup closure and authoritative deployment guidance

## Status

Completed locally on `feat/finance-supabase-auth`. No hosted configuration push,
database push, owner bootstrap, user creation, deployment, secret, or other remote
mutation was run.

## Configuration basis

The committed configuration uses only documented Supabase CLI/Auth settings:

- [Supabase CLI config reference — `auth.enable_signup`,
  `auth.email.enable_signup`, passkey, and WebAuthn fields](https://supabase.com/docs/guides/local-development/cli/config)
- [Supabase passkey configuration — RP ID/origin requirements](https://supabase.com/docs/guides/self-hosting/self-hosted-passkeys)
- [Supabase Admin `generateLink` — admin magic-link generation](https://supabase.com/docs/reference/javascript/auth-admin-generatelink)

`npx --yes supabase@2.105.0 --version` reported `2.105.0`. The CLI reference exposes
the two supported signup controls, but no password-disable TOML key; this remediation
therefore does not invent one. Disabling public/global and email signup preserves the
admin-only one-time `generateLink({ type: 'magiclink' })` bootstrap used before passkey
enrolment.

## RED then GREEN

Added `scripts/assert-supabase-auth-config.mjs` and the
`npm run test:supabase-auth-config` command. The assertion reads the committed TOML
deterministically and requires:

- `auth.enable_signup = false` and `auth.email.enable_signup = false`;
- enabled passkeys with the exact display name, RP ID, and sole production origin;
- the exact production Site URL, empty extra redirect list, and unchanged JWT expiry.

The first executable attempt exposed a syntax error in the newly added assertion; it
was corrected before the meaningful RED run. The RED run then failed as intended:

```text
auth.enable_signup: expected false, found true
auth.email.enable_signup: expected false, found true
```

After changing only those two supported config values to `false`, the same command
passed. This assertion will fail if either public signup control is re-enabled or the
passkey/RP/origin/site/JWT boundary drifts.

## Deployment-document correction

`docs/deploy-plan.md` now has one current model:

- Supabase Auth owns passkey ceremonies and issues the browser session.
- FastAPI validates a Supabase `Authorization: Bearer` JWT on every `/api` route.
- The home API remains on the owner's PC and Tailscale Serve/Funnel only changes
  transport exposure; Funnel is not an authentication check.
- Finance uses direct browser-to-Supabase RLS access; Airfare collection and its local
  archive remain on the home PC with a Supabase read replica.
- Task 11 keeps its owner-only magic-link bootstrap and existing `try`/`finally`
  cleanup, without outputting an action link, session, or secret.

Removed or rewrote stale current-tense descriptions of PC authentication routes, local
session/credential stores, home-PC WebAuthn ceremonies, and the former Funnel-store
gate. Home API, Tailscale, latency, Airfare, rollback, and cleanup guidance remains.

## Files

- `supabase/config.toml`
- `scripts/assert-supabase-auth-config.mjs`
- `package.json`
- `docs/deploy-plan.md`

## Verification

| Command                                                                                         | Result                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx --yes supabase@2.105.0 --version`                                                          | Exit 0; `2.105.0`.                                                                                                                                                      |
| `npm run test:supabase-auth-config`                                                             | RED on the two enabled signup values; GREEN exit 0 after the supported config change.                                                                                   |
| `npx --yes supabase@2.105.0 db reset`                                                           | Exit 0; Docker-local database recreated and Airfare/Finance migrations applied. No `--linked` option was used.                                                          |
| `npx --yes supabase@2.105.0 test db`                                                            | Exit 0; 5 files, 140 tests, PASS.                                                                                                                                       |
| `npx prettier --check docs/deploy-plan.md package.json scripts/assert-supabase-auth-config.mjs` | Exit 0. Prettier has no TOML parser in this repository, so TOML is covered by the assertion and pinned CLI local reset.                                                 |
| `npm run format:check`                                                                          | Exit 1 only because Prettier traverses 19 pre-existing ignored SDD artifacts. The changed report and every changed tracked format-supported file pass the scoped check. |
| `npx eslint scripts/assert-supabase-auth-config.mjs`                                            | Exit 0.                                                                                                                                                                 |
| obsolete-guidance `rg` scan                                                                     | Exit 0; no stale PC-auth deployment guidance matches.                                                                                                                   |
| `git diff --check`                                                                              | Exit 0.                                                                                                                                                                 |

## Self-review

- Only the two documented signup flags changed; passkey, RP ID/origin, Site URL,
  additional redirects, and JWT expiry remain exact and are assertion-protected.
- No password, OTP, email, or localhost routine sign-in UI/flow was added.
- The owner bootstrap remains an administrator-only one-time magic link, and its
  existing cleanup still removes the email environment variable and bootstrap response
  in `finally` without printing sensitive material.
- The documentation distinguishes a browser passkey session from API authorization: the
  latter is strictly a Supabase Bearer JWT.

## Concern

The local Supabase CLI is available only through the pinned `npx` command in this
environment; no globally installed CLI was used. The local reset required initial Docker
image pulls but completed successfully.
