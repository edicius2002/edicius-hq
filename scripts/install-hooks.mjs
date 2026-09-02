/**
 * Point git at the repository's own hooks directory.
 *
 * `.git/hooks` is not versioned, so a hook written there reaches exactly one
 * clone. `core.hooksPath` is the supported way to keep hooks in the tree with
 * everything else — no husky, no extra dependency, and `.githooks/` reviews
 * like any other file.
 *
 * Runs from `prepare`, so `npm install` wires it up once per clone. It must
 * never fail the install: an environment without git, or an install from a
 * tarball rather than a checkout, is not an error worth stopping for.
 */
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // No git here, or no permission to write config. Hooks stay off; CI still runs.
}
