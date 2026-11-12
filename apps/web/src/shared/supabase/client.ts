import { createClient } from '@supabase/supabase-js';

import { getNeonAccessToken } from '@/shared/auth/neonAuth';
import { isNeonBackend } from '@/shared/backend';

import type { Database } from './database.types';

const LEGACY_SESSION_KEY = 'edicius-hq.session-token';

export class SupabaseConfigurationError extends Error {
  constructor(
    variable: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_PUBLISHABLE_KEY' | 'VITE_NEON_DATA_API_URL',
  ) {
    super(`${variable} must be configured to initialize the browser data client.`);
    this.name = 'SupabaseConfigurationError';
  }
}

function requiredPublicConfiguration(
  variable: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_PUBLISHABLE_KEY' | 'VITE_NEON_DATA_API_URL',
): string {
  const configured: unknown =
    variable === 'VITE_SUPABASE_URL'
      ? import.meta.env.VITE_SUPABASE_URL
      : variable === 'VITE_NEON_DATA_API_URL'
        ? import.meta.env.VITE_NEON_DATA_API_URL
        : import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const value = typeof configured === 'string' ? configured.trim() : undefined;
  if (!value) {
    throw new SupabaseConfigurationError(variable);
  }
  return value;
}

function clearLegacySessionToken(): void {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    // Storage can be unavailable in a browser that blocks site data.
  }
}

clearLegacySessionToken();

function createBrowserDataClient() {
  if (isNeonBackend) {
    const endpoint = requiredPublicConfiguration('VITE_NEON_DATA_API_URL').replace(/\/+$/, '');
    if (!endpoint.endsWith('/rest/v1'))
      throw new SupabaseConfigurationError('VITE_NEON_DATA_API_URL');
    return createClient<Database>(endpoint.slice(0, -'/rest/v1'.length), 'neon-data-api', {
      accessToken: getNeonAccessToken,
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  const url = requiredPublicConfiguration('VITE_SUPABASE_URL');
  const publishableKey = requiredPublicConfiguration('VITE_SUPABASE_PUBLISHABLE_KEY');
  return createClient<Database>(url, publishableKey, {
    auth: {
      experimental: { passkey: true },
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

export const supabase = createBrowserDataClient();
