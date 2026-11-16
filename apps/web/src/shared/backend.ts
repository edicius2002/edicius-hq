/** Choose the data destination before any browser client can be initialized. */
const configuredBackend: unknown = import.meta.env.VITE_DATA_BACKEND;
if (configuredBackend !== 'neon' && configuredBackend !== 'supabase') {
  throw new Error("VITE_DATA_BACKEND must be explicitly configured as 'neon' or 'supabase'.");
}

export const isNeonBackend =
  configuredBackend === 'neon' ||
  (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('__neonTrial'));
