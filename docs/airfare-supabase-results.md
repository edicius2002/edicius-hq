# Airfare Supabase migration results

Date: 2026-09-16

Project: `edicius-hq` (`abndifkxpfppmllgxfnu`, `sa-east-1`)

## Hosted schema and backfill

Migration `20260915000000_airfare_archive.sql` is applied to the hosted project. The
nine aggregate reports required by the [deployment runbook](./deploy-plan.md) are
committed. Their deterministic gates passed:

- source-before equals source-after;
- first, second-before, second-after, and final verification all report `matches: true`
  with zero mismatches;
- the normalized second-before and second-after destination manifests are identical;
- the incremental pass completed; and
- no report contains credentials, payload rows, headers, query credentials, or absolute
  source paths.

The accepted point-in-time source and destination counts are identical:

| Dataset         | Records |
| --------------- | ------: |
| snapshots       |  14,442 |
| baseline        |  59,785 |
| calendar        |     171 |
| board checks    |  17,554 |
| calendar checks |     186 |
| airports        |      10 |
| documents       |       1 |

The commands ran from an isolated migration worktree against the verified canonical
main-checkout `services/api/.local-data`. The safe report label is therefore
`<external-source>`; the reports deliberately do not disclose an absolute path.

One board-check line is intentionally skipped in both stable-source manifests. It is
the existing malformed JSON line `2572` in repository-relative journal
`services/api/.local-data/fares/checks/AQP-LIM.jsonl`: parsing fails at byte one with a
JSON decode error. Its SHA-256 is
`7b3103a78d48dd1bbb05fab1dc70cd37a793caa0bfd3935d20f48f11f8349dc3`. The source was
not edited to repair or remove it.

The local archive, collection state, cursors, spend ledger, pass ledger, backups, and
catalog remain in place. No remote rows or tables were deleted or reset.

## Read cutover result

The read cutover is not accepted. After correcting the parity tool to issue one bounded
RPC per watched month, hosted `read_airfare_history` still returns HTTP 500 for a single
AQP-LIM month. Supabase reports SQLSTATE `57014` (`statement timeout`); measured failures
arrived after approximately 11 to 13 seconds for one month and 25 seconds for the two
watched months together. The route carries thousands of full snapshot payloads, so this
raw response shape is not a low-latency read path.

Consequently:

- `AIRFARE_DATA_BACKEND` remains `local`;
- the failed `read-parity.json` is not accepted or committed as cutover evidence;
- continuous replication is not enabled until a permanent backend secret is installed;
  and
- the API and collector were resumed after the stable backfill window.

The dedicated temporary migration key was revoked after verification and a probe with
that key returned HTTP 401. A future read cutover needs a smaller derived read model or
pagination/downsampling, then a fresh incremental sync, parity run, configured-backend
canary, fallback drill, and full quality gate.
