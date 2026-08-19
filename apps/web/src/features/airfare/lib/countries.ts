import { geoArea, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';
import worldAtlas from 'world-atlas/countries-110m.json';

import type { LngLat } from '@/features/airfare/lib/geo';

/**
 * Country names, derived from the outlines the map already draws.
 *
 * mapcn gets its place names from the symbol layers of a vector basemap. With
 * the blank style this repository requires — the browser may not fetch tiles —
 * there is no basemap and there are no symbol layers. But the country
 * *outlines* are already bundled and already drawn, and they carry a name, so
 * the labels can be derived from the same 39 kB rather than fetched.
 *
 * Computed once at import, not per frame: 177 centroids is real work, and the
 * shapes never move.
 */

export type PlaceLabel = {
  name: string;
  at: LngLat;
  /**
   * Solid angle in steradians — the whole country, islands included.
   *
   * This is how a label earns its place: a label is worth drawing once the
   * ground under it is big enough on screen to hold it, and the solid angle is
   * the part of that which does not change when the view does.
   */
  area: number;
};

type Ring = LngLat[];
type Geometry =
  { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] };

/**
 * The biggest single piece of a country, which is where its name belongs.
 *
 * A whole-shape centroid averages the outlying islands in and lands the label
 * off the country: France's comes out in the Atlantic, four degrees west of
 * Brittany, because French Guiana and Réunion pull on it. The largest polygon
 * puts it back on the mainland.
 */
function mainland(geometry: Geometry): Geometry {
  if (geometry.type === 'Polygon') return geometry;
  let best: Geometry = { type: 'Polygon', coordinates: geometry.coordinates[0] };
  let biggest = -1;
  for (const rings of geometry.coordinates) {
    const piece = { type: 'Polygon' as const, coordinates: rings };
    const size = geoArea(piece);
    if (size > biggest) {
      biggest = size;
      best = piece;
    }
  }
  return best;
}

function build(): PlaceLabel[] {
  const world = feature(
    worldAtlas as never,
    (worldAtlas as never as { objects: { countries: never } }).objects.countries,
  ) as unknown as {
    features: { type: 'Feature'; properties: { name?: string }; geometry: Geometry }[];
  };

  const labels: PlaceLabel[] = [];
  for (const country of world.features) {
    const name = country.properties.name;
    if (!name) continue;
    // Antarctica is a band along the bottom of every projection rather than a
    // shape with a middle; its centroid is the pole, and the label lands
    // nowhere useful. The continent layer already names it.
    if (name === 'Antarctica') continue;
    labels.push({
      name,
      at: geoCentroid(mainland(country.geometry)),
      area: geoArea(country),
    });
  }
  // Biggest first, which is also the order labels claim space in when two of
  // them want the same patch of screen.
  return labels.sort((left, right) => right.area - left.area);
}

export const COUNTRIES: PlaceLabel[] = build();
