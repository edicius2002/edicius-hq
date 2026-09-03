import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiRequest } from '@/shared/api/http';
import { clearToken, readToken, writeToken } from '@/shared/auth/session';

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

function respondWith(status: number) {
  const fetchSpy = vi.fn(async () => Response.json({ detail: 'no' }, { status }));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function headersOf(fetchSpy: ReturnType<typeof respondWith>): Record<string, string> {
  const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
  return (init.headers ?? {}) as Record<string, string>;
}

describe('apiRequest and the session', () => {
  it('attaches the bearer token when there is one', async () => {
    writeToken('a-token');
    const fetchSpy = respondWith(200);

    await apiRequest('/api/health');

    expect(headersOf(fetchSpy).Authorization).toBe('Bearer a-token');
  });

  it('sends no Authorization header when there is no token', async () => {
    const fetchSpy = respondWith(200);

    await apiRequest('/api/health');

    expect(headersOf(fetchSpy).Authorization).toBeUndefined();
  });

  it('clears the token on a 401', async () => {
    writeToken('a-token');
    respondWith(401);

    await expect(apiRequest('/api/health')).rejects.toBeInstanceOf(ApiError);
    expect(readToken()).toBeNull();
  });

  it('still throws on a 401 rather than swallowing it', async () => {
    writeToken('a-token');
    respondWith(401);

    await expect(apiRequest('/api/health')).rejects.toBeInstanceOf(ApiError);
  });

  it('keeps the token when the failure is not a 401', async () => {
    writeToken('a-token');
    respondWith(503);

    await expect(apiRequest('/api/health')).rejects.toBeInstanceOf(ApiError);
    expect(readToken()).toBe('a-token');
  });
});
