import { apiRequest } from '@/shared/api/http';

export type KvResponse<T> = {
  key: string;
  value: T;
};

export function getKv<T>(key: string, signal?: AbortSignal): Promise<KvResponse<T>> {
  return apiRequest<KvResponse<T>>(`/api/kv/${encodeURIComponent(key)}`, { signal });
}

export function putKv<T>(key: string, value: T, signal?: AbortSignal): Promise<KvResponse<T>> {
  return apiRequest<KvResponse<T>>(`/api/kv/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: { value },
    signal,
  });
}

export function deleteKv(key: string, signal?: AbortSignal): Promise<void> {
  return apiRequest<void>(`/api/kv/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    signal,
  });
}
