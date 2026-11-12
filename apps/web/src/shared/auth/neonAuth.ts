import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/client';
import { jwtClient } from 'better-auth/client/plugins';

export const neonAuth = createAuthClient({
  baseURL: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  plugins: [passkeyClient(), jwtClient()],
});

export type NeonAuthSession = { user: { id: string } };
export type NeonPasskeySummary = {
  id: string;
  friendlyName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

function requireSuccess(error: { message?: string } | null): void {
  if (error) throw new Error(error.message ?? 'Neon authentication failed');
}

export async function getNeonAccessToken(): Promise<string | null> {
  const result = await neonAuth.token();
  if (result.error?.status === 401) return null;
  requireSuccess(result.error);
  return result.data?.token ?? null;
}

export async function getNeonOwnerId(): Promise<string | null> {
  const result = await neonAuth.getSession();
  if (result.error?.status === 401) return null;
  requireSuccess(result.error);
  return result.data?.user.id ?? null;
}

export async function signInWithNeonPasskey(): Promise<void> {
  const result = await neonAuth.signIn.passkey();
  requireSuccess(result.error);
}

export async function registerNeonPasskey(): Promise<NeonPasskeySummary> {
  const result = await neonAuth.passkey.addPasskey();
  requireSuccess(result.error);
  if (!result.data) throw new Error('Neon passkey registration returned no credential');
  return {
    id: result.data.id,
    friendlyName: result.data.name ?? null,
    createdAt: new Date(result.data.createdAt).toISOString(),
    lastUsedAt: null,
  };
}

export async function listNeonPasskeys(): Promise<NeonPasskeySummary[]> {
  const result = await neonAuth.passkey.listUserPasskeys();
  requireSuccess(result.error);
  return (result.data ?? []).map((passkey) => ({
    id: passkey.id,
    friendlyName: passkey.name ?? null,
    createdAt: new Date(passkey.createdAt).toISOString(),
    lastUsedAt: null,
  }));
}

export async function deleteNeonPasskey(id: string): Promise<void> {
  const result = await neonAuth.passkey.deletePasskey({ id });
  requireSuccess(result.error);
}

export async function signOutFromNeon(): Promise<void> {
  const result = await neonAuth.signOut();
  requireSuccess(result.error);
}

export function subscribeToNeonAuth(
  callback: (
    event: 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT',
    session: NeonAuthSession | null,
  ) => void,
): () => void {
  let active = true;
  let request = 0;
  let initialized = false;
  const refresh = async () => {
    const current = ++request;
    const result = await neonAuth.getSession();
    if (!active || current !== request) return;
    const session = result.error ? null : result.data;
    callback(
      initialized ? (session ? 'SIGNED_IN' : 'SIGNED_OUT') : 'INITIAL_SESSION',
      session ? { user: { id: session.user.id } } : null,
    );
    initialized = true;
  };
  const unsubscribe = neonAuth.$store.atoms.$sessionSignal.subscribe(() => {
    void refresh();
  });
  void refresh();
  return () => {
    active = false;
    unsubscribe();
  };
}
