import { useQuery } from '@tanstack/react-query';

import { fetchAirports, type Airport } from '@/shared/api/fares';

/**
 * Where every watched airport is.
 *
 * Coordinates only change when a route is watched for the first time, so this
 * is fetched once and left alone — no `refetchInterval` for a set of facts
 * that do not move. The page invalidates it after a collection, which is the
 * only moment a new airport can appear.
 */
export function useAirports() {
  return useQuery<Map<string, Airport>>({
    queryKey: ['fares', 'airports'],
    queryFn: ({ signal }) =>
      fetchAirports({ signal }).then(
        (response) => new Map(response.airports.map((airport) => [airport.code, airport])),
      ),
    staleTime: 5 * 60 * 1000,
  });
}
