import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Publishes the map's first-level subdivisions as static files of the web app.
 *
 * They were a route on the home API (`/api/geography/subdivisions`), served as
 * the files sit on disk. Production has no such API — the web app fell back to
 * `http://localhost:8000` — so the globe asked for its subdivisions and never
 * drew one. The files are reference data (Natural Earth, public domain) that no
 * collection changes, so the app now ships them itself.
 *
 * `services/api/app/data/subdivisions` stays the single source: this copies it
 * into `apps/web/public/geography/subdivisions` (gitignored) before every dev
 * server and build, Vercel's included, and writes the index the API used to
 * compute — every country with a file and that file's length in bytes, which
 * is what lets the map budget a viewport before it asks.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'services/api/app/data/subdivisions');
const destination = join(root, 'apps/web/public/geography/subdivisions');
const EXPECTED = 167;

const files = readdirSync(source)
  .filter((name) => name.endsWith('.json'))
  .sort();
const invalid = files.filter((name) => !/^\d{3}\.json$/.test(name));
if (invalid.length) throw new Error(`Unexpected subdivision files: ${invalid.join(', ')}`);
if (files.length !== EXPECTED)
  throw new Error(`Expected ${EXPECTED} subdivision files, found ${files.length}.`);

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });

const countries = {};
for (const name of files) {
  copyFileSync(join(source, name), join(destination, name));
  countries[name.slice(0, 3)] = statSync(join(source, name)).size;
}
writeFileSync(join(destination, 'index.json'), JSON.stringify({ countries }), 'utf8');

console.log(`Published ${files.length} subdivision files to apps/web/public/geography.`);
