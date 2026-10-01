import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  devAuthFilePath,
  isTrustedRequest,
  mintTokenHash,
  readDevAuthConfig,
  type DevAuthConfig,
} from './devSession';

const config: DevAuthConfig = {
  url: 'https://project.supabase.co',
  secretKey: 'sb_secret_test',
  publishableKey: 'sb_publishable_test',
  email: null,
};

function request(remoteAddress: string, headers: Record<string, string>) {
  return { socket: { remoteAddress }, headers };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

describe('devAuthFilePath', () => {
  it('defaults to a per-user file outside every checkout', () => {
    expect(devAuthFilePath({}, 'C:/Users/me')).toBe(
      path.join('C:/Users/me', '.edicius-hq', 'dev-auth.env'),
    );
  });

  it('honours an explicit override', () => {
    expect(devAuthFilePath({ EDICIUS_DEV_AUTH_FILE: 'D:/x.env' }, 'C:/Users/me')).toBe('D:/x.env');
  });
});

describe('readDevAuthConfig', () => {
  function file(text: string) {
    const target = path.join(mkdtempSync(path.join(tmpdir(), 'dev-auth-')), 'dev-auth.env');
    writeFileSync(target, text);
    return target;
  }

  it('reads the project, both keys and an optional login email', () => {
    const target = file(
      [
        '# local only',
        'SUPABASE_URL=https://project.supabase.co/',
        'SUPABASE_SECRET_KEY="sb_secret_test"',
        'VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test',
        'EDICIUS_DEV_LOGIN_EMAIL=owner@example.com',
        '',
      ].join('\r\n'),
    );

    expect(readDevAuthConfig(target)).toEqual({ ...config, email: 'owner@example.com' });
  });

  it('is absent when the file is missing or incomplete', () => {
    expect(readDevAuthConfig(path.join(tmpdir(), 'missing-dev-auth.env'))).toBeNull();
    expect(readDevAuthConfig(file('SUPABASE_URL=https://project.supabase.co\n'))).toBeNull();
  });
});

describe('isTrustedRequest', () => {
  it('accepts a same-origin browser request from this machine', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(isTrustedRequest(request(address, { 'sec-fetch-site': 'same-origin' }))).toBe(true);
    }
  });

  it('refuses the LAN, other sites and clients that do not say where they come from', () => {
    expect(isTrustedRequest(request('192.168.1.20', { 'sec-fetch-site': 'same-origin' }))).toBe(
      false,
    );
    expect(isTrustedRequest(request('127.0.0.1', { 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isTrustedRequest(request('127.0.0.1', {}))).toBe(false);
  });
});

describe('mintTokenHash', () => {
  it('generates a one-time link for the only user without sending email', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, { users: [{ email: 'owner@example.com' }] }))
      .mockResolvedValueOnce(json(200, { hashed_token: 'hash-1' }));

    await expect(mintTokenHash(config, fetcher)).resolves.toBe('hash-1');

    const [linkUrl, linkInit] = fetcher.mock.calls[1] ?? [];
    expect(linkUrl).toBe('https://project.supabase.co/auth/v1/admin/generate_link');
    expect(linkInit?.method).toBe('POST');
    expect(JSON.parse(String(linkInit?.body))).toEqual({
      type: 'magiclink',
      email: 'owner@example.com',
    });
    expect(new Headers(linkInit?.headers).get('apikey')).toBe('sb_secret_test');
  });

  it('uses the configured email instead of listing users', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, { properties: { hashed_token: 'hash-2' } }));

    await expect(mintTokenHash({ ...config, email: 'owner@example.com' }, fetcher)).resolves.toBe(
      'hash-2',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refuses to guess between several users', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, { users: [{ email: 'a@x.com' }, { email: 'b@x.com' }] }));

    await expect(mintTokenHash(config, fetcher)).rejects.toThrow('EDICIUS_DEV_LOGIN_EMAIL');
  });

  it('reports a refused link without echoing credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(401, { msg: 'bad key' }));

    const failure = mintTokenHash({ ...config, email: 'owner@example.com' }, fetcher);

    await expect(failure).rejects.toThrow('Supabase refused the local sign-in link (401).');
    await expect(failure).rejects.not.toThrow('sb_secret_test');
  });
});
