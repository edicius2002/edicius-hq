import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { PostgresDialect } from 'kysely';
import { Pool } from 'pg';

const ORIGIN = 'https://edicius-hq-web.vercel.app';
const RP_ID = 'edicius-hq-web.vercel.app';

function required(name: 'DATABASE_URL' | 'BETTER_AUTH_SECRET'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the auth server`);
  return value;
}

const pool = new Pool({
  connectionString: required('DATABASE_URL'),
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const auth = betterAuth({
  database: {
    dialect: new PostgresDialect({ pool }),
    type: 'postgres',
    schemaName: 'app_auth',
  },
  baseURL: ORIGIN,
  basePath: '/api/auth',
  secret: required('BETTER_AUTH_SECRET'),
  trustedOrigins: [ORIGIN],
  emailAndPassword: { enabled: false },
  plugins: [
    passkey({ rpID: RP_ID, origin: ORIGIN, rpName: 'Edicius HQ' }),
    jwt({
      jwks: { keyPairConfig: { alg: 'ES256' } },
      jwt: {
        definePayload: ({ user }) => ({ sub: user.id, role: 'authenticated' }),
      },
    }),
  ],
});

export default {
  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.searchParams.get('__auth_path');
    if (path !== null) {
      if (!/^[a-zA-Z0-9/-]+$/.test(path) || path.includes('..')) {
        return Promise.resolve(new Response(null, { status: 400 }));
      }
      url.pathname = `/api/auth/${path}`;
      url.searchParams.delete('__auth_path');
      return auth.handler(new Request(url, request));
    }
    return auth.handler(request);
  },
};
