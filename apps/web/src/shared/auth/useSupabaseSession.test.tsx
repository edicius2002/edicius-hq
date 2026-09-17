import { act, render, screen } from '@testing-library/react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  subscribeToAuth: vi.fn(),
}));

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
