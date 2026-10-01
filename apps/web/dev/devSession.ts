/*
 * Local sign-in for the Vite dev server only.
 *
 * Passkeys are bound to the production origin, so localhost can never use them.
 * Instead the dev server asks Supabase's admin API for a one-time magic-link
 * token (no email is sent) and the browser exchanges it for a session of its
 * own, independent of the production one. The secret key lives in one file per
 * machine, outside every checkout, so worktrees and agents share it without a
 * copy of `.env`. It stays in this Node process and never reaches the bundle.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { Plugin } from 'vite';

export type DevAuthConfig = {
  url: string;
  secretKey: string;
  publishableKey: string;
  email: string | null;
};

type RequestLike = {
  socket: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const DEV_SESSION_PATH = '/__dev/session';

export function devAuthFilePath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env.EDICIUS_DEV_AUTH_FILE || path.join(home, '.edicius-hq', 'dev-auth.env');
}

export function readDevAuthConfig(file: string): DevAuthConfig | null {
  if (!existsSync(file)) return null;
  const values = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const value = trimmed.slice(separator + 1).trim();
    values.set(trimmed.slice(0, separator).trim(), value.replace(/^(['"])(.*)\1$/, '$2'));
  }
  const url = values.get('SUPABASE_URL')?.replace(/\/+$/, '');
  const secretKey = values.get('SUPABASE_SECRET_KEY');
  const publishableKey = values.get('VITE_SUPABASE_PUBLISHABLE_KEY');
  if (!url || !secretKey || !publishableKey) return null;
  return { url, secretKey, publishableKey, email: values.get('EDICIUS_DEV_LOGIN_EMAIL') || null };
}

/**
 * Vite listens on every interface (`server.host: true`), so the LAN can reach
 * it. Only this machine's browser, on this page, may mint a session.
 */
export function isTrustedRequest(request: RequestLike): boolean {
  return (
    LOOPBACK.has(request.socket.remoteAddress ?? '') &&
    request.headers['sec-fetch-site'] === 'same-origin'
  );
}

export async function mintTokenHash(
  config: DevAuthConfig,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const headers = {
    apikey: config.secretKey,
    Authorization: `Bearer ${config.secretKey}`,
    'Content-Type': 'application/json',
  };
  let email = config.email;
  if (!email) {
    const listed = await fetcher(`${config.url}/auth/v1/admin/users`, { headers });
    if (!listed.ok) throw refused(listed.status);
    const { users } = (await listed.json()) as { users?: { email?: string }[] };
    const emails = (users ?? []).flatMap((user) => (user.email ? [user.email] : []));
    if (emails.length !== 1) {
      throw new Error('Set EDICIUS_DEV_LOGIN_EMAIL in the dev auth file to choose the user.');
    }
    [email] = emails;
  }
  const link = await fetcher(`${config.url}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  if (!link.ok) throw refused(link.status);
  const body = (await link.json()) as {
    hashed_token?: string;
    properties?: { hashed_token?: string };
  };
  const tokenHash = body.hashed_token ?? body.properties?.hashed_token;
  if (!tokenHash) throw new Error('Supabase returned no local sign-in token.');
  return tokenHash;
}

function refused(status: number): Error {
  return new Error(`Supabase refused the local sign-in link (${status}).`);
}

export function devSessionPlugin(file: string = devAuthFilePath()): Plugin {
  let config: DevAuthConfig | null = null;
  return {
    name: 'edicius-dev-session',
    apply: (_, { command, mode }) => command === 'serve' && mode === 'development',
    config() {
      config = readDevAuthConfig(file);
      // Vite reads VITE_* from process.env after config hooks, so a worktree
      // without its own .env.local still gets the public browser values.
      if (config) {
        process.env.VITE_SUPABASE_URL ||= config.url;
        process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||= config.publishableKey;
      }
    },
    configureServer(server) {
      server.middlewares.use(DEV_SESSION_PATH, (request, response) => {
        const reply = (status: number, body: object) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify(body));
        };
        if (!config) return reply(404, { error: `No dev auth file at ${file}.` });
        if (request.method !== 'POST' || !isTrustedRequest(request)) {
          return reply(403, { error: 'Local sign-in is only for this machine.' });
        }
        mintTokenHash(config).then(
          (tokenHash) => reply(200, { token_hash: tokenHash }),
          (error: unknown) =>
            reply(502, { error: error instanceof Error ? error.message : 'Local sign-in failed.' }),
        );
      });
    },
  };
}
