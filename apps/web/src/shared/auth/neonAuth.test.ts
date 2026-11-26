import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({
  getSession: vi.fn(),
  token: vi.fn(),
  signOut: vi.fn(),
  subscribe: vi.fn<(callback: () => void) => () => void>(),
}));
vi.mock('@better-auth/passkey/client', () => ({ passkeyClient: () => ({}) }));
vi.mock('better-auth/client/plugins', () => ({ jwtClient: () => ({}) }));
vi.mock('better-auth/client', () => ({
  createAuthClient: () => ({
    getSession: session.getSession,
    token: session.token,
    signOut: session.signOut,
    $store: { atoms: { $sessionSignal: { subscribe: session.subscribe } } },
  }),
}));
const jwt = (exp: number) => 'header.' + btoa(JSON.stringify({ exp })) + '.signature';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  session.getSession.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
  session.signOut.mockResolvedValue({ error: null });
  session.subscribe.mockReturnValue(vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.resetAllMocks();
  vi.useRealTimers();
});
it('resolves the initial session without a signal and shares it with later subscribers', async () => {
  const auth = await import('./neonAuth');
  const first = vi.fn();
  const second = vi.fn();
  const stop = auth.subscribeToNeonAuth(first);
  await vi.waitFor(() =>
    expect(first).toHaveBeenCalledWith('INITIAL_SESSION', { user: { id: 'owner-1' } }),
  );
  const stop2 = auth.subscribeToNeonAuth(second);
  await vi.waitFor(() =>
    expect(second).toHaveBeenCalledWith('INITIAL_SESSION', { user: { id: 'owner-1' } }),
  );
  expect(session.getSession).toHaveBeenCalledTimes(1);
  stop();
  stop2();
});
it('shares eight concurrent token reads and reuses a valid token', async () => {
  const token = jwt(Date.now() / 1000 + 300);
  session.token.mockResolvedValue({ data: { token }, error: null });
  const auth = await import('./neonAuth');
  expect(await Promise.all(Array.from({ length: 8 }, () => auth.getNeonAccessToken()))).toEqual(
    Array(8).fill(token),
  );
  expect(await auth.getNeonAccessToken()).toBe(token);
  expect(session.token).toHaveBeenCalledTimes(1);
});
it('refreshes at the expiry safety margin', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const token = jwt(1060);
  session.token.mockResolvedValue({ data: { token }, error: null });
  const auth = await import('./neonAuth');
  await auth.getNeonAccessToken();
  vi.setSystemTime(1_029_000);
  await auth.getNeonAccessToken();
  expect(session.token).toHaveBeenCalledTimes(1);
  vi.setSystemTime(1_030_000);
  await auth.getNeonAccessToken();
  expect(session.token).toHaveBeenCalledTimes(2);
});
it.each(['invalid', jwt(0), jwt(Number.NaN)])(
  'does not retain unusable expiry: %s',
  async (token) => {
    session.token.mockResolvedValue({ data: { token }, error: null });
    const auth = await import('./neonAuth');
    await auth.getNeonAccessToken();
    await auth.getNeonAccessToken();
    expect(session.token).toHaveBeenCalledTimes(2);
  },
);
it('allows recovery after a rejected token request', async () => {
  session.token
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ data: null, error: { status: 401 } });
  const auth = await import('./neonAuth');
  await expect(auth.getNeonAccessToken()).rejects.toThrow('offline');
  await expect(auth.getNeonAccessToken()).resolves.toBeNull();
});
it('discards a token completing after logout', async () => {
  const pending = deferred<{ data: { token: string }; error: null }>();
  session.token.mockReturnValue(pending.promise);
  const auth = await import('./neonAuth');
  const result = auth.getNeonAccessToken();
  await auth.signOutFromNeon();
  pending.resolve({ data: { token: jwt(Date.now() / 1000 + 300) }, error: null });
  expect(await result).toBeNull();
});
it('keeps other subscribers active and does not turn transient session errors into logout', async () => {
  const auth = await import('./neonAuth');
  const first = vi.fn();
  const second = vi.fn();
  const stop = auth.subscribeToNeonAuth(first);
  const stop2 = auth.subscribeToNeonAuth(second);
  await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
  stop();
  session.getSession.mockResolvedValue({ data: null, error: { status: 503, message: 'offline' } });
  session.subscribe.mock.calls[0][0]();
  await new Promise((done) => setTimeout(done, 0));
  expect(second).toHaveBeenCalledTimes(1);
  session.getSession.mockResolvedValue({ data: { user: { id: 'owner-2' } }, error: null });
  session.subscribe.mock.calls[0][0]();
  await vi.waitFor(() =>
    expect(second).toHaveBeenLastCalledWith('SIGNED_IN', { user: { id: 'owner-2' } }),
  );
  expect(first).toHaveBeenCalledTimes(1);
  stop2();
});

it('refuses token reads while logout is still in flight', async () => {
  const logout = deferred<{ error: null }>();
  session.signOut.mockReturnValue(logout.promise);
  session.token.mockResolvedValue({ data: { token: jwt(Date.now() / 1000 + 300) }, error: null });
  const auth = await import('./neonAuth');
  await auth.getNeonAccessToken();
  const signingOut = auth.signOutFromNeon();
  expect(await auth.getNeonAccessToken()).toBeNull();
  expect(session.token).toHaveBeenCalledTimes(1);
  logout.resolve({ error: null });
  await signingOut;
});
it('broadcasts confirmed logout even if all subscribers have unmounted', async () => {
  const messages: unknown[] = [];
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { location: { origin: 'https://example.test' } }),
  );
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      closed = false;
      postMessage(value: unknown) {
        if (this.closed) throw new Error('closed');
        messages.push(value);
      }
      close() {
        this.closed = true;
      }
    },
  );
  const logout = deferred<{ error: null }>();
  session.signOut.mockReturnValue(logout.promise);
  const auth = await import('./neonAuth');
  const stop = auth.subscribeToNeonAuth(vi.fn());
  await auth.getNeonOwnerId();
  const signingOut = auth.signOutFromNeon();
  stop();
  logout.resolve({ error: null });
  await signingOut;
  expect(messages).toContain('signed-out');
  expect(messages.at(-1)).toBe('changed');
  vi.unstubAllGlobals();
});

it('does not discard a valid in-flight token when the same owner focuses the window', async () => {
  const browser = Object.assign(new EventTarget(), {
    location: { origin: 'https://example.test' },
  });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('BroadcastChannel', undefined);
  const auth = await import('./neonAuth');
  const stop = auth.subscribeToNeonAuth(vi.fn());
  await auth.getNeonOwnerId();
  const pending = deferred<{ data: { token: string }; error: null }>();
  session.token.mockReturnValue(pending.promise);
  const result = auth.getNeonAccessToken();
  browser.dispatchEvent(new Event('focus'));
  const token = jwt(Date.now() / 1000 + 300);
  pending.resolve({ data: { token }, error: null });
  expect(await result).toBe(token);
  stop();
  vi.unstubAllGlobals();
});
it('retires the previous identity before reading a cross-window replacement', async () => {
  let receive!: (event: { data: string }) => void;
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { location: { origin: 'https://example.test' } }),
  );
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      set onmessage(value: (event: { data: string }) => void) {
        receive = value;
      }
      postMessage() {}
      close() {}
    },
  );
  const auth = await import('./neonAuth');
  const callback = vi.fn();
  const stop = auth.subscribeToNeonAuth(callback);
  await auth.getNeonOwnerId();
  const replacement = deferred<{ data: { user: { id: string } }; error: null }>();
  session.getSession.mockReturnValue(replacement.promise);
  receive({ data: 'changed' });
  expect(callback).toHaveBeenLastCalledWith('SIGNED_OUT', null);
  replacement.resolve({ data: { user: { id: 'owner-2' } }, error: null });
  await vi.waitFor(() =>
    expect(callback).toHaveBeenLastCalledWith('SIGNED_IN', { user: { id: 'owner-2' } }),
  );
  stop();
  vi.unstubAllGlobals();
});

it('keeps the confirmed identity and reports a failed logout without broadcasting completion', async () => {
  const auth = await import('./neonAuth');
  const callback = vi.fn();
  const stop = auth.subscribeToNeonAuth(callback);
  await auth.getNeonOwnerId();
  session.signOut.mockRejectedValue(new Error('offline'));
  await expect(auth.signOutFromNeon()).rejects.toThrow('offline');
  expect(callback).toHaveBeenLastCalledWith('INITIAL_SESSION', { user: { id: 'owner-1' } });
  stop();
});
it('recovers an interrupted cross-window logout by rechecking on focus', async () => {
  let receive!: (event: { data: string }) => void;
  const browser = Object.assign(new EventTarget(), {
    location: { origin: 'https://example.test' },
  });
  vi.stubGlobal('window', browser);
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      set onmessage(value: (event: { data: string }) => void) {
        receive = value;
      }
      postMessage() {}
      close() {}
    },
  );
  const auth = await import('./neonAuth');
  const callback = vi.fn();
  const stop = auth.subscribeToNeonAuth(callback);
  await auth.getNeonOwnerId();
  receive({ data: 'signed-out' });
  session.getSession.mockResolvedValue({ data: { user: { id: 'owner-2' } }, error: null });
  browser.dispatchEvent(new Event('focus'));
  await vi.waitFor(() =>
    expect(callback).toHaveBeenLastCalledWith('SIGNED_IN', { user: { id: 'owner-2' } }),
  );
  stop();
  vi.unstubAllGlobals();
});
