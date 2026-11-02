import { useQuery } from '@tanstack/react-query';

import { fetchLatestAirfareMonthRequest } from '@/features/airfare/data/airfareRequests';

export function useLatestAirfareMonthRequest(
  origin: string | null,
  destination: string | null,
  month: string | null,
) {
  return useQuery({
    queryKey: ['fares', 'latestRequest', origin, destination, month],
    queryFn: () => fetchLatestAirfareMonthRequest(origin!, destination!, month!),
    enabled: origin !== null && destination !== null && month !== null,
    retry: false,
  });
}
