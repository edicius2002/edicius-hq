import { useQuery } from '@tanstack/react-query';

import { fetchCodexResets } from '@/shared/api/codexResets';

export function useCodexResets() {
  return useQuery({
    queryKey: ['codex-resets'],
    queryFn: ({ signal }) => fetchCodexResets(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
    // The backend already owns conditional retry/fallback semantics. Failing
    // promptly here keeps the existing tweets usable; the minute poll retries.
    retry: false,
  });
}
