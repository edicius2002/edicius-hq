export const STORAGE_KEYS = [
  'prefs',
  'watchlist',
  'portfolio',
  'alert-rules',
  'finance',
  'greenlight',
  'drawings',
  'indicators',
  'finance-camera-views',
] as const;

export type StorageKey = (typeof STORAGE_KEYS)[number];

export function isStorageKey(key: string): key is StorageKey {
  return (STORAGE_KEYS as readonly string[]).includes(key);
}
