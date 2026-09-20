import { useQuery } from '@tanstack/react-query';

import { getLatestSentiment } from '@/features/sentiment/data/supabaseSentiment';

export const SENTIMENT_STALE_TIME_MS = 4 * 60 * 60 * 1000;

export function useSentiment() {
  return useQuery({
    queryKey: ['sentiment'],
    queryFn: ({ signal }) => getLatestSentiment(signal),
    staleTime: SENTIMENT_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}
