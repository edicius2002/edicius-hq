import { createClient } from '@supabase/supabase-js';

import type { Database } from './database.types';

const LEGACY_SESSION_KEY = 'edicius-hq.session-token';

export class SupabaseConfigurationError extends Error {
  constructor(variable: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_PUBLISHABLE_KEY') {
    super(`${variable} must be configured to initialize Supabase.`);
    this.name = 'SupabaseConfigurationError';
  }
}

function requiredPublicConfiguration(
  variable: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_PUBLISHABLE_KEY',
): string {
  const value = import.meta.env[variable]?.trim();
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

const url = requiredPublicConfiguration('VITE_SUPABASE_URL');
const publishableKey = requiredPublicConfiguration('VITE_SUPABASE_PUBLISHABLE_KEY');

clearLegacySessionToken();

export const supabase = createClient<Database>(url, publishableKey, {
  auth: {
    experimental: { passkey: true },
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
