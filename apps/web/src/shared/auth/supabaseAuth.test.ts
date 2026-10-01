import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/shared/supabase/database.types';

vi.mock('@/shared/supabase/client', () => ({ supabase: {} }));

import {
  clearLocalSession,
  deletePasskey,
  getAccessToken,
  signInLocally,
  listPasskeys,
  registerPasskey,
  signInWithPasskey,
  signOut,
  subscribeToAuth,
} from './supabaseAuth';

const passkey = {
  id: 'pk-1',
  friendly_name: 'Windows Hello',
  created_at: '2026-09-16T00:00:00Z',
  last_used_at: '2026-09-16T01:00:00Z',
};

type SupabaseResult<Data> = {
  data: Data;
  error: Error | null;
};

function authClient(auth: object): SupabaseClient<Database> {
  return { auth } as unknown as SupabaseClient<Database>;
}

function createAuth() {
  const unsubscribe = vi.fn();

  return {
    getSession: vi.fn<() => Promise<SupabaseResult<{ session: { access_token: string } | null }>>>(
      async () => ({
        data: { session: { access_token: 'jwt-one' } },
        error: null,
      }),
    ),
    signInWithPasskey: vi.fn<
      () => Promise<SupabaseResult<{ session: object; user: object } | null>>
    >(async () => ({
      data: { session: {}, user: {} },
      error: null,
    })),
    registerPasskey: vi.fn<
      () => Promise<
        SupabaseResult<{
          id: string;
          friendly_name: string;
          created_at: string;
        } | null>
      >
    >(async () => ({
      data: {
        id: passkey.id,
        friendly_name: passkey.friendly_name,
        created_at: passkey.created_at,
      },
      error: null,
    })),
    passkey: {
      list: vi.fn<() => Promise<SupabaseResult<(typeof passkey)[] | null>>>(async () => ({
        data: [passkey],
        error: null,
      })),
      delete: vi.fn<() => Promise<SupabaseResult<null>>>(async () => ({
        data: null,
        error: null,
      })),
    },
    signOut: vi.fn<() => Promise<{ error: Error | null }>>(async () => ({ error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe } } })),
    unsubscribe,
  };
}

describe('the Supabase auth adapter', () => {
  it('returns the active access token', async () => {
    const auth = createAuth();

    await expect(getAccessToken(authClient(auth))).resolves.toBe('jwt-one');
  });

  it('returns null when the active session is absent', async () => {
    const auth = createAuth();
    auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });

    await expect(getAccessToken(authClient(auth))).resolves.toBeNull();
  });

  it('maps registered passkey metadata into the public summary', async () => {
    const auth = createAuth();

    await expect(registerPasskey(authClient(auth))).resolves.toEqual({
      id: 'pk-1',
      friendlyName: 'Windows Hello',
      createdAt: '2026-09-16T00:00:00Z',
      lastUsedAt: null,
    });
  });

  it('maps listed passkey metadata into public summaries', async () => {
    const auth = createAuth();

    await expect(listPasskeys(authClient(auth))).resolves.toEqual([
      {
        id: 'pk-1',
        friendlyName: 'Windows Hello',
        createdAt: '2026-09-16T00:00:00Z',
        lastUsedAt: '2026-09-16T01:00:00Z',
      },
    ]);
  });

  it('deletes the selected passkey through the current-user passkey API', async () => {
    const auth = createAuth();

    await expect(deletePasskey('pk-1', authClient(auth))).resolves.toBeUndefined();
    expect(auth.passkey.delete).toHaveBeenCalledExactlyOnceWith({ passkeyId: 'pk-1' });
  });

  it('uses the default sign-out scope for a user-requested logout in production', async () => {
    vi.stubEnv('DEV', false);
    const auth = createAuth();

    await expect(signOut(authClient(auth))).resolves.toBeUndefined();
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith();
    vi.unstubAllEnvs();
  });

  it('uses the local sign-out scope only for recovery cleanup', async () => {
    const auth = createAuth();

    await expect(clearLocalSession(authClient(auth))).resolves.toBeUndefined();
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
  });

  it('returns only the auth-state unsubscribe function', () => {
    const auth = createAuth();
    const callback = vi.fn();

    const unsubscribe = subscribeToAuth(callback, authClient(auth));
    unsubscribe();

    expect(auth.unsubscribe).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    ['getAccessToken', (client: SupabaseClient<Database>) => getAccessToken(client), 'getSession'],
    [
      'signInWithPasskey',
      (client: SupabaseClient<Database>) => signInWithPasskey(client),
      'signInWithPasskey',
    ],
    [
      'registerPasskey',
      (client: SupabaseClient<Database>) => registerPasskey(client),
      'registerPasskey',
    ],
    ['listPasskeys', (client: SupabaseClient<Database>) => listPasskeys(client), 'list'],
    [
      'deletePasskey',
      (client: SupabaseClient<Database>) => deletePasskey('pk-1', client),
      'delete',
    ],
    ['signOut', (client: SupabaseClient<Database>) => signOut(client), 'signOut'],
    [
      'clearLocalSession',
      (client: SupabaseClient<Database>) => clearLocalSession(client),
      'signOut',
    ],
  ])('%s rejects the error returned by Supabase', async (_method, operation, failurePoint) => {
    const auth = createAuth();
    const error = new Error('Supabase rejected this request');

    if (failurePoint === 'getSession') {
      auth.getSession.mockResolvedValueOnce({ data: { session: null }, error });
    } else if (failurePoint === 'signInWithPasskey') {
      auth.signInWithPasskey.mockResolvedValueOnce({ data: null, error });
    } else if (failurePoint === 'registerPasskey') {
      auth.registerPasskey.mockResolvedValueOnce({ data: null, error });
    } else if (failurePoint === 'list') {
      auth.passkey.list.mockResolvedValueOnce({ data: null, error });
    } else if (failurePoint === 'delete') {
      auth.passkey.delete.mockResolvedValueOnce({ data: null, error });
    } else {
      auth.signOut.mockResolvedValueOnce({ error });
    }

    await expect(operation(authClient(auth))).rejects.toBe(error);
  });
});

describe('signInLocally', () => {
  it('exchanges the dev server token for a session of its own', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ token_hash: 'hash-1' }), { status: 200 }),
    );
    const verifyOtp = vi.fn(async () => ({ data: {}, error: null }));

    await signInLocally(authClient({ verifyOtp }), fetcher);

    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/__dev/session', { method: 'POST' });
    expect(verifyOtp).toHaveBeenCalledExactlyOnceWith({ token_hash: 'hash-1', type: 'magiclink' });
  });

  it('explains how to configure a machine that has no local sign-in', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
    const verifyOtp = vi.fn();

    await expect(signInLocally(authClient({ verifyOtp }), fetcher)).rejects.toThrow(
      'Local sign-in is not configured on this machine.',
    );
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('surfaces the dev server reason for a refused token', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: 'Supabase refused it.' }), { status: 502 }),
    );

    await expect(signInLocally(authClient({ verifyOtp: vi.fn() }), fetcher)).rejects.toThrow(
      'Supabase refused it.',
    );
  });

  it('surfaces a rejected token', async () => {
    const error = new Error('Token has expired');
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ token_hash: 'hash-1' }), { status: 200 }),
    );
    const verifyOtp = vi.fn(async () => ({ data: {}, error }));

    await expect(signInLocally(authClient({ verifyOtp }), fetcher)).rejects.toBe(error);
  });
});

describe('signOut in development', () => {
  it('ends only this browser session and remembers the choice for the tab', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    const signOutCall = vi.fn(async () => ({ error: null }));

    await signOut(authClient({ signOut: signOutCall }));

    expect(signOutCall).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(stored.get('edicius-hq.dev-signed-out')).toBe('1');
    vi.unstubAllGlobals();
  });
});
