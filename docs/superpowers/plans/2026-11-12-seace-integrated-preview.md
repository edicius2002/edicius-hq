# SEACE Integrated PDF Preview Implementation Plan

> **For agentic workers:** Implement the tasks on `feat/seace-integrated-preview` with focused tests and review each subsystem before release.

**Goal:** Show SEACE PDFs inside the public Vercel web app when Vercel cannot fetch the source directly, using an outbound-only Raspberry Pi worker.

**Architecture:** Keep the existing fast `prod4` proxy. An authenticated Vercel endpoint verifies that a requested document belongs to an owner-visible SEACE record, enqueues a bounded job, and returns an owner-bound ticket. The Pi polls a narrow worker endpoint, obtains signed private Blob uploads, fetches and classifies SEACE bytes, and acknowledges the Queue lease after upload; a same-origin Function streams the private PDF into the web modal. The [feasibility study](../../seace-integrated-preview-options.md) and [tested spike](../../seace-integrated-preview-spike-2026-11-12.md) are the design basis.

**Tech Stack:** TypeScript Vercel Functions, Better Auth, Postgres membership lookup, Vercel Queues, private Vercel Blob, Python 3 worker, React/Vitest, systemd.

**Spec:** `docs/seace-integrated-preview-options.md` and `docs/seace-integrated-preview-spike-2026-11-12.md`.

## Global Constraints

- No Tailscale, inbound Pi port, extra domain, or browser access to signed PUT URLs.
- Keep the original SEACE link available when one exists and preview cannot be produced.
- Keep PDF bytes and queue job metadata out of Neon; use private Blob for immutable PDF files and terminal manifests.
- Verify the Better Auth session and owner-visible record membership before accepting a browser request; bind status/file access to that owner.
- Check source hosts and paths, redirects, actual bytes, ZIP paths/count/expanded size/ratio, and PDF size before upload. Never label ZIP/RAR as PDF.
- Never print or commit Neon connection strings, worker secrets, OIDC tokens, or signed Blob URLs.
- No production enablement until Preview data path, Auth, Pi worker, desktop/mobile and fallback checks pass.

## Review Focus

1. A URL is valid but absent from the selected owner-visible record: request must be rejected.
2. A queued job is retried or delivered twice: Blob paths and acknowledgement stay idempotent.
3. A ZIP contains several PDFs, unsafe paths, or oversized members: only safe members are offered, within limits.
4. The Pi is offline, SEACE returns 403, or Blob quota is exhausted: bounded wait ends in an actionable fallback.
5. A valid ticket is used with another account or after expiry: status and file access are denied.

## Tasks

### Task 1: Vercel API and private storage

**Files:** Create `api/seace/preview.ts`, `api/seace/preview-file.ts`, `api/seace/preview-worker.ts` and focused helper/test files. Modify `vercel.json` only during integration.

**Interfaces:** Browser `POST /api/seace/preview` takes `{kind,recordKey,document:{url?:string,uuid?:string}}` and returns `{jobId,ticket,status,files?,expiresAt}`. Browser `GET /api/seace/preview?jobId=&ticket=` returns `{status,files?}`. `GET /api/seace/preview-file?jobId=&ticket=&file=0` streams a private PDF. Worker `GET /api/seace/preview-worker` returns a lease or 204; worker `POST` actions `upload` and `complete` issue path-scoped PUT and verify/acknowledge results.

- [ ] Test invalid document membership, ticket owner/expiry, Queue/Blob failure, safe status and stream headers.
- [ ] Implement session, membership, ticket, Queue, private Blob manifest and stream boundaries.
- [ ] Run focused API tests and TypeScript checks.

### Task 2: Outbound Pi worker and deployment lifecycle

**Files:** Create `services/seace/preview_worker.py`, its focused tests, a systemd unit and runbook; update Pi installer/deploy scripts behind an explicit enabled/credential gate.

**Interfaces:** Consume Task 1 worker contract. Classify `url` or resolved `process` source, then upload up to five safe PDFs and complete the lease. Use 30 MiB per PDF, 20 ZIP entries and 60 MiB total expanded. Leave transient errors unacknowledged for retry.

- [ ] Test direct PDF, ZIP PDF selection, hostile ZIP, oversized/non-PDF and retry behavior.
- [ ] Implement sequential bounded worker, configuration and guarded service install/restart.
- [ ] Run focused Python tests and dry-run deployment checks.

### Task 3: Web modal and polling

**Files:** Modify `apps/web/src/features/seace/SeacePage.tsx`, `data.ts`, styles and focused tests.

**Interfaces:** Consume Task 1 browser contract with same-origin cookies. Keep the current `prod4` fast path; queue on click for `prod6`, resolved process documents, and `prod4` failure. Poll every 2 seconds for at most 90 seconds, cancel on close, display multiple PDF members and original/open-in-tab fallbacks.

- [ ] Test pending/ready/multiple files/unsupported/offline/close and existing `prod4` behavior.
- [ ] Implement request, status polling and responsive modal states.
- [ ] Run focused web tests and typecheck.

### Task 4: Integration and Preview release gate

**Files:** Modify root dependencies, lockfile and `vercel.json`; add release notes/runbook evidence.

- [ ] Align contracts and run API, Python, web, lint, typecheck and build checks.
- [ ] Provision a Preview-only Queue/Blob and secret, deploy Preview, run real Pi end-to-end and auth/desktop/mobile/fallback checks without printing credentials.
- [ ] Review quotas and failure behavior, then decide whether production activation is justified. Keep the worker disabled until its runtime credentials are present.
