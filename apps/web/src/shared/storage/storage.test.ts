import { afterEach, describe, expect, it, vi } from 'vitest';

import { readStorage, removeStorage, writeStorage } from '@/shared/storage/storage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storage facade', () => {
  it('reads, writes, and removes allowlisted keys', async () => {
    const store = new Map<string, unknown>();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const key = url.split('/').pop() ?? '';
        const method = init?.method ?? 'GET';

        if (method === 'PUT') {
          const body = JSON.parse(String(init?.body)) as { value: unknown };
          store.set(key, body.value);
          return Response.json({ key, value: body.value });
        }

        if (method === 'DELETE') {
          if (!store.has(key)) {
            return Response.json({ detail: 'Key not found' }, { status: 404 });
          }
          store.delete(key);
          return new Response(null, { status: 204 });
        }

        if (!store.has(key)) {
          return Response.json({ detail: 'Key not found' }, { status: 404 });
        }
        return Response.json({ key, value: store.get(key) });
      }),
    );

    await expect(readStorage('prefs')).resolves.toBeNull();
    await expect(writeStorage('prefs', { theme: 'light' })).resolves.toEqual({ theme: 'light' });
    await expect(readStorage('prefs')).resolves.toEqual({ theme: 'light' });
    await expect(removeStorage('prefs')).resolves.toBeUndefined();
    await expect(readStorage('prefs')).resolves.toBeNull();
  });

  it('rejects unknown keys before calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(writeStorage('not-allowed' as never, 1)).rejects.toThrow(/not allowlisted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves an old chart-views document untouched', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(readStorage('chart-views' as never)).rejects.toThrow(/not allowlisted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
