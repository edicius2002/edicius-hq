import { apiRequest } from '@/shared/api/http';

export type HealthResponse = {
  status: string;
};

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiRequest<HealthResponse>('/api/health', { signal });
}
