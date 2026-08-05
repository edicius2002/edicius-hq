import { ApiError } from '@/shared/api/http';
import { deleteKv, getKv, putKv } from '@/shared/api/kv';
import { isStorageKey, type StorageKey } from '@/shared/storage/keys';

function assertStorageKey(key: string): asserts key is StorageKey {
  if (!isStorageKey(key)) {
    throw new Error(`Storage key '${key}' is not allowlisted`);
  }
}

export async function readStorage<T>(key: StorageKey, signal?: AbortSignal): Promise<T | null> {
  assertStorageKey(key);
  try {
    const result = await getKv<T>(key, signal);
    return result.value;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function writeStorage<T>(key: StorageKey, value: T, signal?: AbortSignal): Promise<T> {
  assertStorageKey(key);
  const result = await putKv<T>(key, value, signal);
  return result.value;
}

export async function removeStorage(key: StorageKey, signal?: AbortSignal): Promise<void> {
  assertStorageKey(key);
  try {
    await deleteKv(key, signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return;
    }
    throw error;
  }
}
