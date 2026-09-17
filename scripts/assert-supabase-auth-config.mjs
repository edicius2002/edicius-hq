import { readFileSync } from 'node:fs';

const configUrl = new URL('../supabase/config.toml', import.meta.url);
const source = readFileSync(configUrl, 'utf8');
const sections = new Map();
let currentSection = '';

for (const [index, sourceLine] of source.split(/\r?\n/u).entries()) {
  const line = sourceLine.trim();
  if (!line || line.startsWith('#')) continue;

  const section = /^\[([^\]]+)\]$/u.exec(line);
  if (section) {
    currentSection = section[1];
    if (!sections.has(currentSection)) sections.set(currentSection, new Map());
    continue;
  }

  const assignment = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/u.exec(line);
  if (!assignment) continue;

  const values = sections.get(currentSection) ?? new Map();
  if (values.has(assignment[1])) {
    throw new Error(`Duplicate ${currentSection}.${assignment[1]} at line ${index + 1}.`);
  }
  values.set(assignment[1], assignment[2]);
  sections.set(currentSection, values);
}

const expected = [
  ['auth', 'enable_signup', 'false'],
  ['auth.email', 'enable_signup', 'false'],
  ['auth.passkey', 'enabled', 'true'],
  ['auth.webauthn', 'rp_display_name', '"Edicius HQ"'],
  ['auth.webauthn', 'rp_id', '"edicius-hq-web.vercel.app"'],
  ['auth.webauthn', 'rp_origins', '["https://edicius-hq-web.vercel.app"]'],
  ['auth', 'site_url', '"https://edicius-hq-web.vercel.app"'],
  ['auth', 'additional_redirect_urls', '[]'],
  ['auth', 'jwt_expiry', '3600'],
];

const failures = expected.flatMap(([section, key, value]) => {
  const actual = sections.get(section)?.get(key);
  return actual === value
    ? []
    : [`${section}.${key}: expected ${value}, found ${actual ?? '<missing>'}`];
});

if (failures.length) {
  throw new Error(`Supabase Auth configuration assertion failed:\n${failures.join('\n')}`);
}

console.log('Supabase Auth configuration assertion passed.');
