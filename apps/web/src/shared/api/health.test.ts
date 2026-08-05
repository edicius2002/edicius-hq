import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchHealth } from '@/shared/api/health';
import { ApiError } from '@/shared/api/http';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchHealth', () => {
  it('returns the health payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status: 'ok' })),
    );

    await expect(fetchHealth()).resolves.toEqual({ status: 'ok' });
  });

  it('throws ApiError on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'unavailable' }, { status: 503 })),
    );

    await expect(fetchHealth()).rejects.toBeInstanceOf(ApiError);
  });
});
