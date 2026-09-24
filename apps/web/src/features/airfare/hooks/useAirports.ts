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
export function useAirports(codes: readonly string[] = []) {
  const requested = [...new Set(codes)].sort();
  return useQuery<Map<string, Airport>>({
    queryKey: ['fares', 'airports', requested],
    queryFn: ({ signal }) =>
      fetchAirports(requested, { signal }).then(
        (response) => new Map(response.airports.map((airport) => [airport.code, airport])),
      ),
    staleTime: 5 * 60 * 1000,
    // The codes are the month's stops, so they change once the month arrives —
    // a new key. Every arc is drawn from this map, and a map that went empty
    // while the new key loaded erased every arc for a beat on each page load.
    // The previous answer is still true of every airport it names.
    placeholderData: (previous) => previous,
  });
}
