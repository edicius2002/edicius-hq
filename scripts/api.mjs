import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODES = [
  'dev',
  'serve',
  'test',
  'lint',
  'format',
  'typecheck',
  'fares-collect',
  'fares-check',
  'fares-backfill',
  'enroll',
  'credentials',
  'revoke',
];

const mode = process.argv[2];
if (!MODES.includes(mode)) {
  console.error(`Usage: node scripts/api.mjs <${MODES.join('|')}>`);
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = path.join(repoRoot, 'services', 'api');

/*
 * `.env` was a Docker Compose and Vite file until the collector needed a
 * credential, and nothing loaded it into the Python process — a token written
 * there would have sat in the file doing nothing while looking configured,
 * which is the silent failure this feature keeps having to design against.
 * `loadEnvFile` fills in what is missing and never overrides a shell variable,
 * so `TRAVELPAYOUTS_TOKEN=... npm run fares:collect` still wins for one run.
 */
const envFile = path.join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const isWin = process.platform === 'win32';
const venvPython = path.join(
  apiRoot,
  '.venv',
  isWin ? 'Scripts' : 'bin',
  isWin ? 'python.exe' : 'python',
);

const pythonCandidates = [venvPython, 'python3', 'python'];
const python = pythonCandidates.find((candidate) => {
  if (candidate.includes(path.sep) || candidate.includes('/')) {
    return existsSync(candidate);
  }
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
});

if (!python) {
  console.error('Python not found. Create services/api/.venv with Python 3.12 first.');
  process.exit(1);
}

/*
 * Every one of these has to run against the API's own interpreter. `python -m
 * ruff` from the repo root picks up whatever happens to be on PATH, which is
 * how a check passes on one machine and fails on another.
 */
/*
 * The repo-root `scripts/` directory holds Python too — the load test and the
 * reachability probe — and nothing was checking it: ruff runs from
 * `services/api`, so those files were outside every gate. Anything not in CI
 * rots, which is the finding decision 10.1 came from.
 */
const PY_TARGETS = ['.', '../../scripts'];

const ARGS = {
  test: [['-m', 'pytest']],
  dev: [['-m', 'uvicorn', 'app.main:app', '--reload', '--host', '127.0.0.1', '--port', '8000']],
  /*
   * The same server without the reloader, for `npm start` — which serves the
   * built bundle and has no source to watch.
   *
   * It is not only tidiness. On Windows uvicorn switches to a selector event
   * loop whenever it runs a subprocess, reloader included, and that loop
   * cannot spawn one: `asyncio.create_subprocess_exec` raises
   * `NotImplementedError`, which is the first thing Playwright's driver needs
   * and therefore the tweet watcher never captured anything there. `dev` still
   * carries the reloader and still has that limitation.
   */
  serve: [['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000']],
  lint: [
    ['-m', 'ruff', 'check', ...PY_TARGETS],
    ['-m', 'ruff', 'format', '--check', ...PY_TARGETS],
  ],
  typecheck: [['-m', 'mypy']],
  format: [
    ['-m', 'ruff', 'check', ...PY_TARGETS, '--fix'],
    ['-m', 'ruff', 'format', ...PY_TARGETS],
  ],
  /*
   * The airfare scripts live at the repo root but import `app.*`, so they
   * need this interpreter and not whatever is on PATH — the same reason every
   * mode above goes through it. Extra argv is forwarded so `-- --dry-run`
   * reaches the script rather than npm.
   */
  'fares-collect': [['../../scripts/fares-collect.py', ...process.argv.slice(3)]],
  'fares-check': [['../../scripts/gflights-check.py', ...process.argv.slice(3)]],
  'fares-backfill': [['../../scripts/fares-viapoints-backfill.py', ...process.argv.slice(3)]],
  /*
   * Passkey enrolment, listing and revocation. `-m` rather than a path under
   * `scripts/` because this one lives inside the package it talks to — it
   * reads `app.services.auth_store` and nothing else — and `-m` is how every
   * other in-package entry point above is reached.
   *
   * These are the root of trust for the whole login: authorising a new device
   * means running a command on the machine the data is already on. There is
   * deliberately no way to do it from the web client.
   */
  enroll: [['-m', 'app.cli.auth_cli', 'enroll']],
  credentials: [['-m', 'app.cli.auth_cli', 'credentials']],
  revoke: [['-m', 'app.cli.auth_cli', 'revoke', ...process.argv.slice(3)]],
};

for (const args of ARGS[mode]) {
  const result = spawnSync(python, args, {
    cwd: apiRoot,
    stdio: 'inherit',
    env: process.env,
  });
  // Stop at the first failure: a lint error and a format error at once is two
  // walls of output for one thing to fix.
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.exit(0);
