import { useQuery } from '@tanstack/react-query';

import { type Subdivisions, readSubdivisions } from '@/features/airfare/lib/subdivisions';
import { fetchSubdivisions } from '@/shared/api/geography';

/**
 * The subdivisions of the one country the reader has zoomed into.
 *
 * **Lazily, and damped three ways**, because a globe being spun must not turn
 * into a burst of requests:
 *
 * 1. **A zoom gate.** `country` is `null` until the view is inside
 *    `SUBDIVISION_REACH`, so the whole default view — a reader arriving,
 *    looking at their routes and spinning the globe — sends nothing at all.
 * 2. **A settle gate**, in the caller: the country under the view is only
 *    named once the map has been still for a moment, and a gesture that starts
 *    again cancels it. A drag that crosses ten countries asks about the one
 *    the reader stopped on.
 * 3. **A cache that never expires.** Natural Earth publishes a few times a
 *    decade, so a country fetched once is never fetched again in the session —
 *    including the ones that came back with nothing, which are remembered as
 *    `null` rather than re-asked every time the reader passes over them.
 *
 * `retry: false` for the same reason `fetchSubdivisions` swallows a 404: this
 * is decoration on a working map, and three retries over eleven seconds for a
 * layer nobody has asked for out loud is spending a reader's connection on
 * scenery.
 */
export function useSubdivisions(country: string | null) {
  return useQuery<Subdivisions | null>({
    queryKey: ['geography', 'subdivisions', country],
    queryFn: ({ signal }) =>
      fetchSubdivisions(country as string, { signal }).then(readSubdivisions),
    enabled: country !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}
