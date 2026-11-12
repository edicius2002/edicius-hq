# Approved Pi Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically deploy production-marked Pi releases and reuse already prepared Python dependencies across releases.

**Architecture:** A root `systemd` timer polls `refs/heads/pi-production`, loads the exact promoted deployment script through Git, and calls the existing guarded deployment path. A root-owned immutable virtualenv cache is keyed by Python version and requirements digest, with each release's ignored `.venv` symlink pointing to its matching cache entry.

**Tech Stack:** Bash, Python 3.12/3.13, Git, pip, systemd, pytest.

**Spec:** [Approved Pi updates and shared Python environments](../specs/2026-11-12-pi-approved-updates-design.md).

## Global Constraints

- Keep the current Neon release and its rollback path; never deploy every `main` commit automatically.
- Preserve exact-SHA manual deployment and the existing deployment lock, collector verification, and release retention.
- Never mutate a ready shared environment in place or delete it while a release could use it.
- Do not put credentials in Git or the timer unit.
- All repository text is English.

## Review Focus

1. A moved production ref or a concurrent manual deployment must not silently downgrade the Pi.
2. A half-built virtualenv must not be mistaken for a reusable complete environment.
3. Rollback to an older release-local virtualenv must continue to work.
4. Release pruning must unlink shared-env symlinks without deleting the shared target.
5. A missing GitHub connection must leave the active release and services untouched.

---

### Task 1: Immutable Python environment cache

**Files:** Create `ops/pi/prepare_venv.py`; modify `ops/pi/deploy-release.sh` and `ops/pi/prune_releases.py`; add `ops/pi/tests/test_prepare_venv.py` and release-retention coverage.

**Interfaces:** `environment_key(requirements: Path, version: tuple[int, int]) -> str`; `prepare(release: Path, cache_root: Path) -> Path`; CLI `python3 ops/pi/prepare_venv.py <release>`.

- [ ] Write tests for stable keys, one-time creation, reuse without pip, incomplete-cache refusal, legacy environment handling, and safe release pruning of a shared-env symlink.
- [ ] Run the new tests and confirm they fail against the current code.
- [ ] Implement the helper and call it before any collector service is stopped; keep an existing legacy local environment valid for manual rollback.
- [ ] Run the new tests and all Pi operator tests; confirm the helper does not modify a ready cache entry.
- [ ] Commit this independently testable change.

### Task 2: Production-ref updater

**Files:** Create `ops/pi/auto-update.sh`, `ops/pi/systemd/edicius-pi-update.service`, and `.timer`; modify `ops/pi/deploy-release.sh`, `ops/pi/install.sh`; add `ops/pi/tests/test_auto_update.py` and update relevant existing tests.

**Interfaces:** `auto-update.sh` takes no arguments and reads only `refs/heads/pi-production`; `deploy-release.sh <sha> --auto` revalidates the ref and ancestry under the deployment lock.

- [ ] Write tests for unchanged-ref skip, changed-ref invocation, stale/ref-rewrite rejection, no automatic downgrade, timer schedule, and installer wiring.
- [ ] Run the tests and confirm they fail against the current code.
- [ ] Implement the updater and locked validation; install the timer with a release, then enable it once after the verified rollout.
- [ ] Run the Pi tests, Bash syntax checks, and the repository's required checks.
- [ ] Commit this independently testable change.

### Task 3: Documentation and rollout

**Files:** Modify `docs/pi-collectors-runbook.md`, `docs/IMPLEMENTATION_PLAN.md`; publish the spec and this plan.

- [ ] Document production promotion, timer inspection/pause, shared cache behavior, and manual rollback; format-check the docs.
- [ ] Open a PR against `main`, review the whole branch, wait for CI, and merge after checks pass.
- [ ] Rebase on the merged Neon `main`, resolve integration conflicts, review the final diff, and merge after CI.
- [ ] Deploy the exact merged `main` commit with operator `sudo`, create the `pi-production` ref at that verified commit, enable the timer once, and verify the current SHA, services, rollback release, and shared cache on `bodas`.
