import { useQueries, useQuery } from '@tanstack/react-query';

import { type Subdivisions, readSubdivisions } from '@/features/airfare/lib/subdivisions';
import { fetchSubdivisionCatalogue, fetchSubdivisions } from '@/shared/api/geography';

/**
 * What every country's subdivisions weigh, so a view can be budgeted.
 *
 * One request a session, 2.5 kB, and never invalidated — Natural Earth
 * publishes a few times a decade. It is asked for on the same terms as the
 * geometry it describes: nothing is fetched until the reader has zoomed in far
 * enough for any of this to matter, so a reader who never closes in still
 * sends no request at all.
 *
 * `retry: false` and no error surface, because there is a working map either
 * way. Without the index the map falls back to detailing the one country under
 * the middle of the frame, which is how it behaved before the index existed.
 */
export function useSubdivisionCatalogue(enabled: boolean) {
  return useQuery<Record<string, number>>({
    queryKey: ['geography', 'subdivisions', 'catalogue'],
    queryFn: ({ signal }) =>
      fetchSubdivisionCatalogue({ signal }).then((answer) => answer.countries ?? {}),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}

/**
 * The subdivisions of every country the reader has in front of them.
 *
 * One query per country rather than one query for the set, which is what makes
 * the fan-out affordable at all: two views over the same part of the world
 * share most of their countries, and a per-country key means the second view
 * pays only for what the first one did not already have. A batch key would
 * make every pan a fresh miss for geometry already in memory.
 *
 * **Lazily, and damped four ways**, because a globe being spun must not turn
 * into a burst of requests:
 *
 * 1. **A zoom gate.** The caller passes nothing until the view is inside
 *    `SUBDIVISION_REACH`, so the whole default view — a reader arriving,
 *    looking at their routes and spinning the globe — sends nothing at all.
 * 2. **A settle gate**, in the caller: the countries in view are only worked
 *    out once the map has been still for a moment, and a gesture that starts
 *    again cancels it. A drag that crosses ten countries asks about the ones
 *    the reader stopped on.
 * 3. **A byte budget**, in `planFanOut`: a view is allowed 256 kB of geometry,
 *    spent on the countries holding most of the screen, and what it will not
 *    stretch to is never requested. It is a frame budget as much as a
 *    connection one — that many bytes is 25 ms of `geoPath` a frame.
 * 4. **A cache that never expires.** A country fetched once is never fetched
 *    again in the session — including the ones that came back with nothing,
 *    which are remembered as `null` rather than re-asked every time the reader
 *    passes over them.
 *
 * `retry: false` for the same reason `fetchSubdivisions` swallows a 404: this
 * is decoration on a working map, and three retries over eleven seconds for a
 * layer nobody has asked for out loud is spending a reader's connection on
 * scenery.
 */
export function useSubdivisions(countries: readonly string[]): Subdivisions[] {
  return useQueries({
    queries: countries.map((country) => ({
      queryKey: ['geography', 'subdivisions', country],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchSubdivisions(country, { signal }).then(readSubdivisions),
      staleTime: Infinity,
      gcTime: Infinity,
      retry: false,
    })),
    combine: arrived,
  });
}

/**
 * The countries that have arrived and have something to draw, in the order
 * they were asked for.
 *
 * That order is the order `planFanOut` chose, biggest on screen first, and it
 * is not decoration: it is the order the subdivision names claim ground in, so
 * a bigger place keeps the patch it wants when two of them land on the same
 * one.
 *
 * A country still in flight and a country with nothing to give are the same
 * absence here, and both of them are a country that keeps its own name — which
 * is what makes a fan-out land one country at a time without ever showing a
 * shape that is neither named nor detailed.
 *
 * **Declared once, at module scope, and that is load-bearing.** `useQueries`
 * caches the combined array only while the `combine` function keeps its
 * identity; passed as an inline arrow it is a new function every render, and
 * the cache falls through to a deep equality check over every coordinate of
 * every country on screen — megabytes of comparison, sixty times a second, for
 * an answer that has not changed. The map depends on the array being the same
 * array between frames: `draw` is a `useCallback` keyed on it, and a new
 * identity per render would repaint the canvas twice a frame for the whole of
 * a drag.
 */
function arrived(results: readonly { data?: Subdivisions | null }[]): Subdivisions[] {
  return results
    .map((result) => result.data)
    .filter((found): found is Subdivisions => Boolean(found));
}
