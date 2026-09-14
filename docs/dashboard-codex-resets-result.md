# Dashboard Codex resets — implementation result

## Result

The Dashboard now places a live Codex reset summary and a 53-week reset calendar above the existing Posts and Replies columns. The two timelines still use the scraper's `@thsottiaux` records and `isReply` split, including the existing refresh, SSE, loading, and error behavior; only their presentation was adapted to the announcement-card language of Codex Resets.

The adapted visual system uses the reference's heavy outlines, offset shadows, warm surface, bright statistic tiles, compact metadata, avatar-led cards, and speech-bubble treatment while retaining this application's layout and theme tokens. The calendar scrolls inside its own frame on narrow screens, so it does not create page-level horizontal overflow.

## Data and behavior decisions

- The authenticated app reads `/api/codex-resets`; the backend uses a separate unauthenticated client for `codex-resets.com`, so the application's bearer token is never forwarded upstream.
- The adapter reads `/api/v1/status` and every required `/api/v1/resets` page with `limit=100`, follows cursors, detects cursor loops, and deduplicates records by ID.
- Only entries in reset history count as executed resets. Scheduled entries and active-watch predictions from status are intentionally not rendered as facts.
- The longest wait is derived from consecutive executed history records. The total and average interval use the live status statistics.
- A 60-second disk cache follows the upstream freshness window. Status requests reuse ETags; `304` retains the previous snapshot; `429` preserves `Retry-After`; transient errors return the last valid snapshot marked stale rather than converting missing data to zeros.
- Day placement and exact labels use `America/Bogota`; the UI explicitly displays `GMT-5`. Relative labels update every 30 seconds.
- Calendar cells distinguish regular, banked, no-reset, and future dates. Each day is keyboard focusable, has an accessible label, exposes detail on hover/focus, and keeps the selected detail on tap/click.

## Sources inspected

- Visual reference: <https://codex-resets.com/>
- API documentation: <https://codex-resets.com/api/docs>
- OpenAPI schema: <https://codex-resets.com/api/openapi.json>
- Live status: <https://codex-resets.com/api/v1/status>
- Reset history: <https://codex-resets.com/api/v1/resets?limit=100&order=asc>

Codex Resets is shown with discreet attribution as an independent tracker, not as an official OpenAI source.

## Verification

- Backend suite: `615 passed` (`python -m pytest -q` with an isolated basetemp).
- Web suite: `2248 passed, 2 skipped` across 153 files (`npm test`).
- Dashboard and calendar focused tests cover loading, initial failure, stale-data preservation, pagination/deduplication, reset type, Bogota midnight boundaries, and preservation of Posts/Replies.
- `npm run typecheck`: passed.
- `npm run typecheck:api`: passed, 65 source files.
- `npm run lint:api`: passed, 109 files formatted.
- `npm run lint`: passed with five pre-existing Fast Refresh warnings in `apps/web/src/app/router/routes.tsx` and no errors.
- `npm run build`: passed; Vite production build completed with 536 modules.
- Changed web sources pass scoped Prettier validation. The repository-wide formatter also traverses permission-locked pytest basetemp output, so generated test data was excluded from the scoped check.

## Browser review and artifacts

Chrome was run with `--disable-gpu` and `--disable-software-rasterizer`. Both the reference and the implemented Dashboard were inspected at desktop and mobile widths. The implemented page measured equal `clientWidth` and `scrollWidth` at 1440 px and 390 px, reported no browser errors, and the banked-reset touch interaction updated the detail panel.

- Reference desktop: [`codex-resets-reference-desktop.png`](codex-resets-reference-desktop.png)
- Reference mobile: [`codex-resets-reference-mobile.png`](codex-resets-reference-mobile.png)
- Dashboard desktop: [`dashboard-codex-resets-desktop.png`](dashboard-codex-resets-desktop.png)
- Dashboard mobile: [`dashboard-codex-resets-mobile.png`](dashboard-codex-resets-mobile.png)

The Dashboard capture used mocked read-only tweet responses and the real reset API; it did not write to the scraper or its data files.

## Limitations

- Fresh reset information depends on the independent `codex-resets.com` service. During an outage the UI clearly dates and labels cached data; without any prior snapshot it shows an unavailable state while leaving Posts and Replies usable.
- The announcement avatar is loaded from the tracker site's public asset, so it can be absent if that asset is unavailable even when cached reset data remains usable.
