#!/usr/bin/env node
/**
 * Puts back the platform binaries npm removed.
 *
 * This tree is opened from Windows and from WSL over the same `node_modules`.
 * npm only ever keeps the optional binaries of the platform it last ran on, so
 * an install from either side deletes the other's — Vitest then fails on
 * `rolldown-binding.wasi.cjs` under WSL, and the build fails on
 * `lightningcss.win32-x64-msvc.node` under Windows. Both mean the same thing.
 *
 * Run it from the side that is broken; it only ever adds.
 *
 *   node scripts/restore-native-bindings.mjs          # report and fix
 *   node scripts/restore-native-bindings.mjs --check  # report only, exit 1 if any missing
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const { platform, arch } = process;

/** The lockfile knows which optional packages exist and what they are for. */
function wantedForThisPlatform() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const wanted = [];

  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/')) continue;
    // Only the packages that declare a platform are at risk; the rest are shared.
    if (!entry.os || !entry.cpu) continue;
    if (!entry.os.includes(platform) || !entry.cpu.includes(arch)) continue;

    const name = path.slice('node_modules/'.length);
    wanted.push({ name, version: entry.version, dir: join(root, 'node_modules', name) });
  }

  return wanted;
}

const missing = wantedForThisPlatform().filter((pkg) => !existsSync(pkg.dir));

if (!missing.length) {
  console.log(`All ${platform}-${arch} binaries present.`);
  process.exit(0);
}

console.log(`Missing ${missing.length} binary package(s) for ${platform}-${arch}:`);
for (const pkg of missing) console.log(`  ${pkg.name}@${pkg.version}`);

if (checkOnly) process.exit(1);

// Installed in a throwaway tree and copied in: installing into the real one
// makes npm re-evaluate every optional dependency and delete the other
// platform's binaries, which is the problem this script exists to undo.
const staging = mkdtempSync(join(tmpdir(), 'native-bindings-'));
try {
  execFileSync(
    'npm',
    [
      'install',
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--force',
      `--os=${platform}`,
      `--cpu=${arch}`,
      ...missing.map((pkg) => `${pkg.name}@${pkg.version}`),
    ],
    { cwd: staging, stdio: 'inherit', shell: platform === 'win32' },
  );

  for (const pkg of missing) {
    const from = join(staging, 'node_modules', pkg.name);
    if (!existsSync(from)) throw new Error(`npm did not provide ${pkg.name}`);
    cpSync(from, pkg.dir, { recursive: true });
    console.log(`Restored ${pkg.name}`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

console.log("Done. The other platform's binaries were left untouched.");
