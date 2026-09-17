import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  clearLocalSession: vi.fn(),
  getAccessToken: vi.fn(),
}));

vi.mock('@/shared/auth/supabaseAuth', () => auth);

import { ApiError, apiFetch, apiRequest } from '@/shared/api/http';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

beforeEach(() => {
  auth.getAccessToken.mockResolvedValue('jwt-one');
  auth.clearLocalSession.mockResolvedValue(undefined);
});

function respondWith(status: number) {
  const fetchSpy = vi.fn(async () => Response.json({ detail: 'no' }, { status }));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function headersOf(fetchSpy: ReturnType<typeof respondWith>): Record<string, string> {
  const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
  return Object.fromEntries(new Headers(init.headers).entries());
}

describe('apiFetch and the Supabase session', () => {
  it('awaits and attaches the current bearer token', async () => {
    const fetchSpy = respondWith(200);

    await apiFetch('/api/health');

    expect(auth.getAccessToken).toHaveBeenCalledOnce();
    expect(headersOf(fetchSpy).authorization).toBe('Bearer jwt-one');
  });

  it('sends no Authorization header when signed out', async () => {
    auth.getAccessToken.mockResolvedValueOnce(null);
    const fetchSpy = respondWith(200);

    await apiFetch('/api/health');

    expect(headersOf(fetchSpy).authorization).toBeUndefined();
  });

  it('keeps a caller-supplied Authorization header', async () => {
    const fetchSpy = respondWith(200);

    await apiFetch('/api/health', { headers: { Authorization: 'Bearer caller-token' } });

    expect(headersOf(fetchSpy).authorization).toBe('Bearer caller-token');
  });

  it('clears only the local Supabase session on a 401', async () => {
    respondWith(401);

    await apiFetch('/api/health');

    expect(auth.clearLocalSession).toHaveBeenCalledOnce();
  });
});

describe('apiRequest', () => {
  it('still throws on a 401 rather than swallowing it', async () => {
    respondWith(401);

    await expect(apiRequest('/api/health')).rejects.toBeInstanceOf(ApiError);
    expect(auth.clearLocalSession).toHaveBeenCalledOnce();
  });

  it('keeps a non-401 failure as an API error', async () => {
    respondWith(503);

    await expect(apiRequest('/api/health')).rejects.toBeInstanceOf(ApiError);
    expect(auth.clearLocalSession).not.toHaveBeenCalled();
  });
});
