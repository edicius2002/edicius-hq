import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Serves the production web bundle and the local API together. The web server
 * stays on 5173 because that is one of the API's default CORS origins.
 */
const processes = [
  spawn(process.execPath, [path.join(repoRoot, 'scripts', 'api.mjs'), 'dev'], { stdio: 'inherit' }),
  spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', '5173'], {
    stdio: 'inherit',
    cwd: path.join(repoRoot, 'apps', 'web'),
  }),
];

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill();
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop());
}

for (const child of processes) {
  child.on('error', (error) => {
    console.error(`Could not start a local service: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code) => stop(code ?? 1));
}
