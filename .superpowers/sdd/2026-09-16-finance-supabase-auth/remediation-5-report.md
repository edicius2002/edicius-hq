# Remediation 5 — supersede stale PC-auth guidance

## Status

Completed locally on `feat/finance-supabase-auth`. This remediation changes only
`docs/IMPLEMENTATION_PLAN.md` and this SDD report. No runtime source, configuration,
hosted resource, secret, or credential was read or changed.

## Documentation correction

The implementation plan now makes the approved 2026-09-16 model authoritative:

- Supabase Auth owns the browser passkey session.
- FastAPI verifies the Supabase Bearer JWT for every API and SSE route.
- SSE uses header-only authenticated fetch streaming.
- Tailscale Serve/Funnel and `tailnet.mjs` are transport-only.
- Finance reads directly under Supabase RLS and writes through its CAS RPC.

The delivery overview, product baseline, data-plane table, decision status, decisions
13.3–13.8, and the 2026-09-03/04 summaries now point to the Finance cutover runbook
and approved design. Retired local WebAuthn/session, PC-enrollment, query-token, and
Funnel credential-gate material remains only as explicitly labelled `Superseded`
historical context. The old commands and current-tense operating instructions were
removed.

## Verification

| Check                                                      | Result                                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused static documentation assertion                     | Passed: all six legacy references are explicitly historical; no operative local-auth command, route exception, credential store, or Funnel gate remains. |
| `npm exec prettier -- --check docs/IMPLEMENTATION_PLAN.md` | Exit 0.                                                                                                                                                  |
| `git diff --check`                                         | Exit 0.                                                                                                                                                  |
| Diff scope                                                 | Only `docs/IMPLEMENTATION_PLAN.md` plus this required SDD report.                                                                                        |

## Concern

This is a documentation-only correction. It intentionally does not rerun runtime or
hosted checks; the plan links to the existing Finance cutover runbook and approved
design for the operational procedure.
