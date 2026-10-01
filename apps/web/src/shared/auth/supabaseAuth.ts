import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';

import { supabase } from '@/shared/supabase/client';
import type { Database } from '@/shared/supabase/database.types';

import { DEV_SIGNED_OUT_KEY } from './devSignedOut';

export type PasskeySummary = {
  id: string;
  friendlyName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

type PasskeyMetadata = {
  id: string;
  friendly_name?: string;
  created_at: string;
  last_used_at?: string;
};

function toPasskeySummary(passkey: PasskeyMetadata): PasskeySummary {
  return {
    id: passkey.id,
    friendlyName: passkey.friendly_name ?? null,
    createdAt: passkey.created_at,
    lastUsedAt: passkey.last_used_at ?? null,
  };
}

export async function getAccessToken(
  client: SupabaseClient<Database> = supabase,
): Promise<string | null> {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
}

export async function signInWithPasskey(
  client: SupabaseClient<Database> = supabase,
): Promise<void> {
  const { error } = await client.auth.signInWithPasskey();
  if (error) throw error;
}

/**
 * Development-only sign-in. A passkey is bound to the production origin, so the
 * Vite dev server mints a one-time token (`apps/web/dev/devSession.ts`) and this
 * browser exchanges it for a session of its own.
 */
export async function signInLocally(
  client: SupabaseClient<Database> = supabase,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher('/__dev/session', { method: 'POST' });
  if (response.status === 404) {
    throw new Error('Local sign-in is not configured on this machine.');
  }
  const body = (await response.json().catch(() => ({}))) as {
    token_hash?: string;
    error?: string;
  };
  if (!response.ok || !body.token_hash) {
    throw new Error(body.error ?? 'Local sign-in failed.');
  }
  const { error } = await client.auth.verifyOtp({ token_hash: body.token_hash, type: 'magiclink' });
  if (error) throw error;
}

export async function registerPasskey(
  client: SupabaseClient<Database> = supabase,
): Promise<PasskeySummary> {
  const { data, error } = await client.auth.registerPasskey();
  if (error) throw error;
  return toPasskeySummary(data);
}

export async function listPasskeys(
  client: SupabaseClient<Database> = supabase,
): Promise<PasskeySummary[]> {
  const { data, error } = await client.auth.passkey.list();
  if (error) throw error;
  return data.map(toPasskeySummary);
}

export async function deletePasskey(
  id: string,
  client: SupabaseClient<Database> = supabase,
): Promise<void> {
  const { error } = await client.auth.passkey.delete({ passkeyId: id });
  if (error) throw error;
}

export async function signOut(client: SupabaseClient<Database> = supabase): Promise<void> {
  if (import.meta.env.DEV) {
    // A global sign-out would also end the owner's production sessions.
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw error;
    try {
      sessionStorage.setItem(DEV_SIGNED_OUT_KEY, '1');
    } catch {
      // Storage can be unavailable in a browser that blocks site data.
    }
    return;
  }
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

/** Clears only the local browser session after an API 401 response. */
export async function clearLocalSession(
  client: SupabaseClient<Database> = supabase,
): Promise<void> {
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

export function subscribeToAuth(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
  client: SupabaseClient<Database> = supabase,
): () => void {
  const {
    data: { subscription },
  } = client.auth.onAuthStateChange(callback);

  return () => subscription.unsubscribe();
}
