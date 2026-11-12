import { afterEach, describe, expect, it, vi } from 'vitest';

const neon = vi.hoisted(() => ({
  getNeonAccessToken: vi.fn(async () => 'neon-jwt'),
  getNeonOwnerId: vi.fn(async () => 'owner-1'),
  signInWithNeonPasskey: vi.fn(async () => {}),
  signOutFromNeon: vi.fn(async () => {}),
  registerNeonPasskey: vi.fn(async () => ({
    id: 'key-1',
    friendlyName: null,
    createdAt: '',
    lastUsedAt: null,
  })),
  listNeonPasskeys: vi.fn(async () => []),
  deleteNeonPasskey: vi.fn(async () => {}),
  subscribeToNeonAuth: vi.fn(() => vi.fn()),
}));

vi.mock('@/shared/supabase/client', () => ({ supabase: {} }));
vi.mock('./neonAuth', () => neon);

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('the staged Neon auth adapter', () => {
  it('uses Better Auth for tokens, owner identity, passkeys and sign-out', async () => {
    vi.stubEnv('VITE_DATA_BACKEND', 'neon');
    const auth = await import('./supabaseAuth');

    await expect(auth.getAccessToken()).resolves.toBe('neon-jwt');
    await expect(auth.getOwnerId()).resolves.toBe('owner-1');
    await auth.signInWithPasskey();
    await auth.signOut();

    expect(neon.getNeonAccessToken).toHaveBeenCalledOnce();
    expect(neon.getNeonOwnerId).toHaveBeenCalledOnce();
    expect(neon.signInWithNeonPasskey).toHaveBeenCalledOnce();
    expect(neon.signOutFromNeon).toHaveBeenCalledOnce();
  });

  it('subscribes to Better Auth session changes', async () => {
    vi.stubEnv('VITE_DATA_BACKEND', 'neon');
    const auth = await import('./supabaseAuth');
    const callback = vi.fn();
    const stop = auth.subscribeToAuth(callback);

    expect(neon.subscribeToNeonAuth).toHaveBeenCalledExactlyOnceWith(callback);
    stop();
  });
});
