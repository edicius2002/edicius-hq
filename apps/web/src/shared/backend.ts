/** Build-time cutover or an explicit production-origin trial in the same app. */
export const isNeonBackend =
  import.meta.env.VITE_DATA_BACKEND === 'neon' ||
  (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('__neonTrial'));
