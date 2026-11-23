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

// All credentials stay in memory and belong to one authentication generation.
let generation = 0;
let signingOut = false;
let identityPending = false;
let cachedToken: { value: string; until: number } | undefined;
let tokenFlight: Promise<string | null> | undefined;
let sessionFlight: Promise<NeonAuthSession | null> | undefined;
let snapshot: NeonAuthSession | null | undefined;
let freshUntil = 0;
type AuthCallback = (
  event: 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT',
  session: NeonAuthSession | null,
) => void;
const listeners = new Map<AuthCallback, boolean>();
let stopSignal: (() => void) | undefined;
let channel: BroadcastChannel | undefined;

function invalidateAuth(): void {
  generation++;
  cachedToken = undefined;
  tokenFlight = undefined;
  sessionFlight = undefined;
  freshUntil = 0;
}

function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000 - 30_000
      : 0;
  } catch {
    return 0;
  }
}

export function getNeonAccessToken(): Promise<string | null> {
  if (signingOut || identityPending) return Promise.resolve(null);
  if (cachedToken && Date.now() < cachedToken.until) return Promise.resolve(cachedToken.value);
  if (tokenFlight) return tokenFlight;
  const current = generation;
  const request = (async () => {
    const result = await neonAuth.token();
    if (current !== generation) return null;
    if (result.error?.status === 401) {
      invalidateAuth();
      publishSession(null);
      return null;
    }
    requireSuccess(result.error);
    const token = result.data?.token ?? null;
    if (token) cachedToken = { value: token, until: tokenExpiry(token) };
    return token;
  })();
  tokenFlight = request;
  void request
    .finally(() => {
      if (tokenFlight === request) tokenFlight = undefined;
    })
    .catch(() => {});
  return request;
}

function publishSession(next: NeonAuthSession | null): void {
  if (snapshot !== undefined && snapshot?.user.id !== next?.user.id) invalidateAuth();
  identityPending = false;
  snapshot = next;
  freshUntil = Date.now() + 30_000;
  for (const [callback, initialized] of listeners) {
    listeners.set(callback, true);
    callback(initialized ? (next ? 'SIGNED_IN' : 'SIGNED_OUT') : 'INITIAL_SESSION', next);
  }
}

function readSession(): Promise<NeonAuthSession | null> {
  if (signingOut) return Promise.resolve(null);
  if (snapshot !== undefined && Date.now() < freshUntil) return Promise.resolve(snapshot);
  if (sessionFlight) return sessionFlight;
  const current = generation;
  const request = (async () => {
    const result = await neonAuth.getSession();
    if (current !== generation) return null;
    if (result.error?.status !== 401) requireSuccess(result.error);
    const next = result.error || !result.data ? null : { user: { id: result.data.user.id } };
    publishSession(next);
    return next;
  })();
  sessionFlight = request;
  void request
    .finally(() => {
      if (sessionFlight === request) sessionFlight = undefined;
    })
    .catch(() => {});
  return request;
}

function refreshSession(): void {
  invalidateAuth();
  // Transient failures preserve the last confirmed identity. Focus or the next
  // auth event retries; a 401 is the only error that explicitly signs out.
  void readSession().catch(() => {});
}

function revalidateOnFocus(): void {
  freshUntil = 0;
  // Focus is not an identity boundary. Preserve valid requests while checking.
  void readSession().catch(() => {});
}

export async function getNeonOwnerId(): Promise<string | null> {
  return (await readSession())?.user.id ?? null;
}

export async function signInWithNeonPasskey(): Promise<void> {
  signingOut = false;
  invalidateAuth();
  const result = await neonAuth.signIn.passkey();
  requireSuccess(result.error);
  broadcastAuth('changed');
  refreshSession();
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

function broadcastAuth(message: 'signed-out' | 'changed'): void {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  // A one-shot sender survives React unmounting every authenticated consumer.
  const sender = new BroadcastChannel('edicius-auth');
  sender.postMessage(message);
  sender.close();
}

export async function signOutFromNeon(): Promise<void> {
  signingOut = true;
  invalidateAuth();
  try {
    const result = await neonAuth.signOut();
    requireSuccess(result.error);
    invalidateAuth();
    publishSession(null);
    broadcastAuth('signed-out');
    broadcastAuth('changed');
  } finally {
    signingOut = false;
  }
}

export function subscribeToNeonAuth(callback: AuthCallback): () => void {
  listeners.set(callback, false);
  if (!stopSignal) {
    stopSignal = neonAuth.$store.atoms.$sessionSignal.subscribe(refreshSession);
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', revalidateOnFocus);
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel('edicius-auth');
        channel.onmessage = (event: MessageEvent<unknown>) => {
          if (event.data === 'signed-out') {
            invalidateAuth();
            publishSession(null);
            identityPending = true;
          } else if (event.data === 'changed') {
            publishSession(null);
            identityPending = true;
            refreshSession();
          }
        };
      }
    }
  }
  if (snapshot !== undefined && Date.now() < freshUntil) {
    listeners.set(callback, true);
    callback('INITIAL_SESSION', snapshot);
  } else {
    void readSession().catch(() => {});
  }
  return () => {
    listeners.delete(callback);
    if (!listeners.size) {
      stopSignal?.();
      stopSignal = undefined;
      if (typeof window !== 'undefined') window.removeEventListener('focus', revalidateOnFocus);
      channel?.close();
      channel = undefined;
      freshUntil = 0;
    }
  };
}
