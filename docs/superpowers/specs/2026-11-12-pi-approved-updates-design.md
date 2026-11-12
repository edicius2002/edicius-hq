# Approved Pi updates and shared Python environments

The owner approved periodic updates of the pinned releases on `bodas` and reuse of Python packages when the dependency set has not changed. The active Pi release follows the Neon migration line, which has since merged into `main`; unattended updates must follow a separate production promotion ref rather than every new `main` commit.

## Release selection and activation

`refs/heads/pi-production` is the sole unattended deployment source. Advancing this ref is the explicit production promotion. A daily `systemd` timer checks its exact SHA at 08:11 UTC and does nothing when it matches `/opt/edicius-hq/current`. The service runs as root and invokes the same pinned deployment script, lock, preflight, rollback, verification, and release retention used by manual deployments. It logs to the journal and retries on the next timer run after a network or preparation failure.

The updater reads the deployment script from the promoted commit through Git, rather than running whatever is on `main` or the draft branch. The deployment script rechecks the promoted ref and requires the new commit to descend from the active commit while holding the deployment lock. A branch rewrite, stale fetch, or automatic downgrade fails without switching releases. Manual exact-SHA deployment remains available for recovery. The production ref starts at the verified Neon release after the updater has been integrated there; future promotions require passing CI and review before advancing the ref.

## Python dependency reuse

Each distinct combination of the system Python major/minor version and the exact bytes of `services/api/requirements.txt` gets a root-owned environment under `/opt/edicius-hq/venvs`. A new environment is built in a temporary sibling directory, checked with `pip check`, marked ready, and renamed into place. A release's ignored `services/api/.venv` is a symlink to the ready environment. An unchanged dependency set reuses that environment without running `pip install`; a changed set creates a new one before collectors are stopped. Existing legacy release-local environments remain usable for rollback. The cache is never edited in place after it is marked ready and is not pruned automatically until a separate, reference-aware cleanup is implemented.

Python environments contain absolute paths in installed scripts, so copying or moving a release-local environment into the cache is unsafe. The first deployment using this design creates one new shared environment; subsequent matching releases reuse it. The Playwright browser cache already lives outside releases and remains shared.

## Operations and failure behavior

The updater timer is installed with a release and enabled once by the operator after that release is verified. Later deployments preserve its enabled or disabled state, so pausing it for rollback remains effective. A missing production ref, unavailable GitHub, invalid SHA, changed active release, failed dependency preparation, or failed collector verification must leave the previous release and its services usable. The updater never accesses secrets or databases directly. The systemd journal records the selected SHA and outcome. The operator runbook must describe how to promote an exact reviewed commit, inspect the timer, pause it, and perform a manual rollback.
