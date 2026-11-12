import { afterEach, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({ data: { user: { id: 'owner-1' } }, error: null })),
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock('@better-auth/passkey/client', () => ({ passkeyClient: () => ({}) }));
vi.mock('better-auth/client/plugins', () => ({ jwtClient: () => ({}) }));
vi.mock('better-auth/client', () => ({
  createAuthClient: () => ({
    getSession: session.getSession,
    $store: { atoms: { $sessionSignal: { subscribe: session.subscribe } } },
  }),
}));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it('resolves the initial Neon session even when the session signal does not fire on subscription', async () => {
  const { subscribeToNeonAuth } = await import('./neonAuth');
  const callback = vi.fn();
  const stop = subscribeToNeonAuth(callback);

  await vi.waitFor(() => {
    expect(callback).toHaveBeenCalledWith('INITIAL_SESSION', { user: { id: 'owner-1' } });
  });
  stop();
});
