import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'test') {
  console.error('Usage: node scripts/api.mjs <dev|test>');
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

const args =
  mode === 'test'
    ? ['-m', 'pytest']
    : ['-m', 'uvicorn', 'app.main:app', '--reload', '--host', '127.0.0.1', '--port', '8000'];

const result = spawnSync(python, args, {
  cwd: apiRoot,
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
