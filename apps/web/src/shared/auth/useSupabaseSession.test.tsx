import { act, render, screen } from '@testing-library/react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getOwnerId: vi.fn(),
  subscribeToAuth: vi.fn(),
}));

const backend = vi.hoisted(() => ({ isNeonBackend: false }));
vi.mock('@/shared/backend', () => backend);
vi.mock('@/shared/auth/supabaseAuth', () => auth);

import { useSupabaseSession } from '@/shared/auth/useSupabaseSession';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function SessionStatus() {
  const { status } = useSupabaseSession();
  return <output>{status}</output>;
}

let emitAuth: (event: AuthChangeEvent, session: Session | null) => void;

beforeEach(() => {
  backend.isNeonBackend = false;
  auth.getOwnerId.mockReset();
  auth.getAccessToken.mockReset();
  auth.subscribeToAuth.mockReset();
  auth.subscribeToAuth.mockImplementation(
    (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
      emitAuth = callback;
      return vi.fn();
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSupabaseSession', () => {
  it('subscribes before awaiting the initial session and keeps the gate closed meanwhile', async () => {
    const session = deferred<string | null>();
    auth.getAccessToken.mockReturnValue(session.promise);

    render(<SessionStatus />);

    expect(screen.getByText('checking')).toBeInTheDocument();
    expect(auth.subscribeToAuth).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    expect(auth.getAccessToken).toHaveBeenCalledExactlyOnceWith();
    expect(auth.subscribeToAuth.mock.invocationCallOrder[0]).toBeLessThan(
      auth.getAccessToken.mock.invocationCallOrder[0],
    );

    session.resolve(null);
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
  });

  it('does not let a late initial read overwrite a newer auth event', async () => {
    const session = deferred<string | null>();
    auth.getAccessToken.mockReturnValue(session.promise);
    render(<SessionStatus />);

    emitAuth('SIGNED_IN', { access_token: 'jwt-one' } as Session);
    expect(await screen.findByText('authenticated')).toBeInTheDocument();

    session.resolve(null);
    await act(async () => {
      await session.promise;
    });
    expect(screen.getByText('authenticated')).toBeInTheDocument();
  });

  it('unsubscribes and ignores a late initial read after unmount', async () => {
    const session = deferred<string | null>();
    const unsubscribe = vi.fn();
    auth.getAccessToken.mockReturnValue(session.promise);
    auth.subscribeToAuth.mockReturnValue(unsubscribe);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<SessionStatus />);

    unmount();
    session.resolve('jwt-one');
    await act(async () => {
      await session.promise;
    });

    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

it('exposes owner identity when an authenticated session changes without signing out', async () => {
  auth.getAccessToken.mockReturnValue(new Promise(() => {}));
  function Owner() {
    const session = useSupabaseSession();
    return (
      <output>
        {session.status}:{session.ownerId ?? 'none'}
      </output>
    );
  }
  render(<Owner />);
  act(() => emitAuth('SIGNED_IN', { user: { id: 'owner-a' } } as Session));
  expect(screen.getByText('authenticated:owner-a')).toBeInTheDocument();
  act(() => emitAuth('SIGNED_IN', { user: { id: 'owner-b' } } as Session));
  expect(screen.getByText('authenticated:owner-b')).toBeInTheDocument();
  act(() => emitAuth('SIGNED_OUT', null));
  expect(screen.getByText('anonymous:none')).toBeInTheDocument();
});

it('waits for the Neon owner without requesting a token or mounting an unidentified owner', async () => {
  backend.isNeonBackend = true;
  const owner = deferred<string | null>();
  auth.getOwnerId.mockReturnValue(owner.promise);
  auth.getAccessToken.mockResolvedValue('fast-token');
  render(<SessionStatus />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText('checking')).toBeInTheDocument();
  expect(auth.getAccessToken).not.toHaveBeenCalled();
  owner.resolve('owner-a');
  expect(await screen.findByText('authenticated')).toBeInTheDocument();
});
it('reports a transient initial Neon session failure as recoverable', async () => {
  backend.isNeonBackend = true;
  auth.getOwnerId.mockRejectedValue(new Error('offline'));
  render(<SessionStatus />);
  expect(await screen.findByText('error')).toBeInTheDocument();
});
