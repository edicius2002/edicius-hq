import { useQuery } from '@tanstack/react-query';

import { fetchCodexResets } from '@/shared/api/codexResets';

export function useCodexResets() {
  return useQuery({
    queryKey: ['codex-resets'],
    queryFn: ({ signal }) => fetchCodexResets(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
    // The provider is read directly and the browser's HTTP cache revalidates
    // it; `placeholderData` keeps the last good answer on screen. Failing
    // promptly keeps the rest of the page usable, and the minute poll retries.
    retry: false,
  });
}
