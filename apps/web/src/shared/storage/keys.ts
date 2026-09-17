export const STORAGE_KEYS = [
  'prefs',
  'watchlist',
  'portfolio',
  'alert-rules',
  'greenlight',
  'drawings',
  'indicators',
  'airfare-routes',
  'greenlight-projector',
] as const;

export type StorageKey = (typeof STORAGE_KEYS)[number];

export function isStorageKey(key: string): key is StorageKey {
  return (STORAGE_KEYS as readonly string[]).includes(key);
}
