import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('browser data backend', () => {
  it('rejects a missing backend instead of silently using Supabase', async () => {
    vi.stubEnv('VITE_DATA_BACKEND', '');
    await expect(import('./backend')).rejects.toThrow('VITE_DATA_BACKEND');
  });

  it('rejects an unknown backend instead of silently using Supabase', async () => {
    vi.stubEnv('VITE_DATA_BACKEND', 'other');
    await expect(import('./backend')).rejects.toThrow('VITE_DATA_BACKEND');
  });

  it('accepts an explicit Neon backend', async () => {
    vi.stubEnv('VITE_DATA_BACKEND', 'neon');
    await expect(import('./backend')).resolves.toMatchObject({ isNeonBackend: true });
  });
});
