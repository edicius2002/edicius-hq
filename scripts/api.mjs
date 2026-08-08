import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODES = ['dev', 'test', 'lint', 'format'];

const mode = process.argv[2];
if (!MODES.includes(mode)) {
  console.error(`Usage: node scripts/api.mjs <${MODES.join('|')}>`);
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = path.join(repoRoot, 'services', 'api');
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
const ARGS = {
  test: [['-m', 'pytest']],
  dev: [['-m', 'uvicorn', 'app.main:app', '--reload', '--host', '127.0.0.1', '--port', '8000']],
  lint: [
    ['-m', 'ruff', 'check', '.'],
    ['-m', 'ruff', 'format', '--check', '.'],
  ],
  format: [
    ['-m', 'ruff', 'check', '.', '--fix'],
    ['-m', 'ruff', 'format', '.'],
  ],
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
