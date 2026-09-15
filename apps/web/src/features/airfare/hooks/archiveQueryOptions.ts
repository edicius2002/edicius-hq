import { ApiError } from '@/shared/api/http';

/** Read stored fares only; this never starts an upstream collection. */
export const archiveQueryOptions = {
  staleTime: 60_000,
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  // Collections from the scheduler or another tab do not invalidate this
  // client's cache. Refresh visible queries, retaining their previous data.
  refetchInterval: ({ state }: { state: { status: string; error: Error | null } }) => {
    if (
      state.error instanceof ApiError &&
      state.error.status >= 400 &&
      state.error.status < 500 &&
      state.error.status !== 408 &&
      state.error.status !== 429
    ) {
      return false;
    }
    return state.status === 'error' ? 15_000 : 60_000;
  },
};
