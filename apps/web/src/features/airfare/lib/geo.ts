import { geoDistance, geoInterpolate } from 'd3-geo';

import type { Airport } from '@/shared/api/fares';

/**
 * The geometry a route map needs, kept away from the drawing.
 *
 * Everything here is pure and coordinate-only: no canvas, no projection state,
 * no React. That is what lets the interesting parts — is this arc a great
 * circle, is this endpoint on the far side of the globe — be tested without a
 * WebGL context or a jsdom canvas, which is the same reason the price chart is
 * SVG rather than canvas (decision 12.12).
 */

export type LngLat = [number, number];

/** Where a watched route's two ends are, once the codes have been resolved. */
export type RouteGeometry = {
  id: string;
  origin: string;
  destination: string;
  from: LngLat;
  to: LngLat;
  fromCity: string | null;
  toCity: string | null;
};

export function airportPoint(airport: Airport): LngLat {
  // GeoJSON order, which is longitude first — the opposite of how every
  // airport database and every human writes it. Getting this backwards puts
  // Lima in the Indian Ocean, so it is converted in exactly one place.
  return [airport.longitude, airport.latitude];
}

/**
 * Watched routes that have coordinates for both ends, in watchlist order.
 *
 * A route whose airports are not known yet is dropped rather than guessed at:
 * coordinates arrive with the first collection, so an uncollected route simply
 * has no arc until it has been looked at once.
 */
export function routeGeometries(
  routes: { origin: string; destination: string; id: string }[],
  airports: Map<string, Airport>,
): RouteGeometry[] {
  const found: RouteGeometry[] = [];
  for (const route of routes) {
    const from = airports.get(route.origin);
    const to = airports.get(route.destination);
    if (!from || !to) continue;
    found.push({
      id: route.id,
      origin: route.origin,
      destination: route.destination,
      from: airportPoint(from),
      to: airportPoint(to),
      fromCity: from.city,
      toCity: to.city,
    });
  }
  return found;
}

/**
 * The path an aircraft actually flies, sampled as a line string.
 *
 * A great circle, not a curve drawn in longitude and latitude. On LIM–CUZ the
 * two are indistinguishable; on LIM–MAD, crossing the Atlantic, a lng/lat
 * curve visibly misses the real track — which is the flaw the one mature
 * component in this space still ships (its great-circle fix is an unmerged
 * pull request).
 *
 * The sample count follows the distance so a short hop is not spending sixty
 * points on a straight line and a long haul is not visibly faceted.
 */
export function greatCircle(
  from: LngLat,
  to: LngLat,
): { type: 'LineString'; coordinates: LngLat[] } {
  const along = geoInterpolate(from, to);
  const steps = Math.min(96, Math.max(16, Math.round(geoDistance(from, to) * 110)));
  return {
    type: 'LineString',
    coordinates: Array.from({ length: steps + 1 }, (_, index) => along(index / steps)),
  };
}

/**
 * Whether a point faces the viewer on a globe rotated to `rotation`.
 *
 * `geoOrthographic` clips paths at the limb for us, but a label or a dot is
 * positioned rather than clipped, so without this check every airport on the
 * far side is drawn mirrored onto the near one.
 */
export function facesViewer(point: LngLat, rotation: [number, number, number]): boolean {
  return geoDistance(point, [-rotation[0], -rotation[1]]) <= Math.PI / 2;
}
