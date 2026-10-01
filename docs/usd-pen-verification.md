# USD/PEN verification

Verification date: September 29, 2026. Work is isolated on
`feat/dashboard-usd-pen`, tracked by [issue #250](https://github.com/edicius2002/edicius-hq/issues/250).

## Source acquisition

The implemented HTTP adapters were exercised in no-write mode. Kambista,
Tu Cambista, Securex, Cambio Seguro, DollarHouse, Rextie and TKambio all returned
usable standard quotes. A separate BCRP/SBS pass made one shared HTTP request
and parsed 20 official observations with zero failures. These checks did not
write to Supabase, the local outbox or collector scheduling state.

The initial duplicate BCRP request exposed an intermittent protection response;
the implementation now shares a single response per date window within a pass.
Offline regression tests cover the shared request, malformed metadata,
non-finite retry headers, source isolation and continued outbox replay.

## Automated checks

- API suite: **1,226 passed, 28 skipped** after the backend fixes.
- API Ruff and mypy passed; mypy checked 93 source files.
- Final web suite: **2,458 passed, 2 skipped**, after the chart and owner-cache
  fixes. The focused App/Dashboard suite also passed **41 tests**.
- Project-wide web typecheck, ESLint and formatting passed.
- Production web build passed. Vite reported a shared bundle above its 500 kB
  warning threshold.
- New SQL tests: **24 pgTAP assertions passed**, including owner isolation,
  denied browser writes, historical revision selection and daily aggregation.
  The existing collector data plane baseline also passed **111 assertions**.

SQL execution used a new schema-only database inside the local Supabase Docker
container. The shared database and hosted Supabase were not changed. An optional
broader legacy SQL run was interrupted by a Docker engine HTTP 500 response after
two legacy files passed; this does not represent a completed full SQL suite.

## Browser checks

Playwright rendered the authenticated Dashboard at 1440 px and 390 px with
intercepted synthetic data and GPU acceleration disabled. Checks passed for:

- Source and range selection, including the actual RPC arguments.
- Online/reference filtering and two visible quote columns.
- Favorites, selected source and range surviving a page reload.
- Keyboard point selection with Home and ArrowRight.
- A wider expanded desktop chart and a taller expanded mobile chart.
- Official values with many decimal places, without page overflow.
- No browser page errors or horizontal page overflow.

Additional offline regressions verify visible isolated chart captures across gaps
and account isolation: switching owners while offline, denied reads for the new
owner, sign-out cancellation and late responses from the old owner.

History for every source starts at 2026-10-01 00:00 America/Lima; earlier
data is intentionally absent and the historical backfill was removed in #255.
Production activation is documented separately in the collector runbook.
