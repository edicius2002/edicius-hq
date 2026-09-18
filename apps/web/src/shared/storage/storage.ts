import { isStorageKey, type StorageKey } from '@/shared/storage/keys';
import { readRemoteDocument, writeRemoteDocument } from '@/shared/storage/supabaseStorage';

function assertStorageKey(key: string): asserts key is StorageKey {
  if (!isStorageKey(key)) {
    throw new Error(`Storage key '${key}' is not allowlisted`);
  }
}

export async function readStorage<T>(key: StorageKey, signal?: AbortSignal): Promise<T | null> {
  assertStorageKey(key);
  const document = await readRemoteDocument<T>(key, signal);
  return document?.payload ?? null;
}

export async function writeStorage<T>(key: StorageKey, value: T, signal?: AbortSignal): Promise<T> {
  assertStorageKey(key);
  const current = await readRemoteDocument(key, signal);
  const document = await writeRemoteDocument(key, value, current?.revision ?? 0);
  return document.payload;
}

export async function removeStorage(key: StorageKey, signal?: AbortSignal): Promise<void> {
  assertStorageKey(key);
  const current = await readRemoteDocument(key, signal);
  if (current) await writeRemoteDocument(key, null, current.revision);
}
