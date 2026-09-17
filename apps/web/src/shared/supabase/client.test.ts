import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { clientSentinel, createClientMock } = vi.hoisted(() => ({
  clientSentinel: {},
  createClientMock: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

async function importClientModule() {
  return import('./client');
}

function configurePublicEnvironment(): void {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test_key');
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  createClientMock.mockReset();
});

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('the browser Supabase client', () => {
  it('rejects missing public Supabase configuration with a named error', async () => {
    await expect(importClientModule()).rejects.toMatchObject({
      name: 'SupabaseConfigurationError',
      message: expect.stringContaining('VITE_SUPABASE_URL'),
    });
  });

  it('rejects a missing publishable key with a named error', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');

    await expect(importClientModule()).rejects.toMatchObject({
      name: 'SupabaseConfigurationError',
      message: expect.stringContaining('VITE_SUPABASE_PUBLISHABLE_KEY'),
    });
  });

  it('creates the typed client with passkeys and browser session support enabled', async () => {
    configurePublicEnvironment();
    createClientMock.mockReturnValue(clientSentinel);

    const { supabase } = await importClientModule();

    expect(supabase).toBe(clientSentinel);
    expect(createClientMock).toHaveBeenCalledExactlyOnceWith(
      'https://example.supabase.co',
      'sb_publishable_test_key',
      {
        auth: {
          experimental: { passkey: true },
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      },
    );
  });

  it('removes only the obsolete application session key during bootstrap', async () => {
    configurePublicEnvironment();
    createClientMock.mockReturnValue(clientSentinel);
    const storage = new Map<string, string>([
      ['edicius-hq.session-token', 'obsolete-token'],
      ['sb-example-auth-token', 'persisted-supabase-session'],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    });

    await importClientModule();

    expect(storage.get('edicius-hq.session-token')).toBeUndefined();
    expect(storage.get('sb-example-auth-token')).toBe('persisted-supabase-session');
  });
});
