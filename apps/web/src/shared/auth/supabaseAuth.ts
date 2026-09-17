import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';

import { supabase } from '@/shared/supabase/client';
import type { Database } from '@/shared/supabase/database.types';

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
