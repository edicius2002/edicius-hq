import { geoArea, geoBounds, geoCentroid, geoContains } from 'd3-geo';
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
  /**
   * ISO 3166-1 numeric, straight off the bundled shape.
   *
   * The only name the API's subdivision files are keyed by, and it is already
   * in the atlas, so knowing which country a reader has zoomed into costs
   * nothing but reading a field that was being thrown away. `null` for the
   * three shapes the atlas carries without one — Kosovo, Northern Cyprus and
   * Somaliland — which is also the honest answer for territories no numeric
   * standard has assigned.
   */
  id: string | null;
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

type CountryShape = {
  type: 'Feature';
  id?: string | number;
  properties: { name?: string };
  geometry: Geometry;
};

const SHAPES: CountryShape[] = (
  feature(
    worldAtlas as never,
    (worldAtlas as never as { objects: { countries: never } }).objects.countries,
  ) as unknown as { features: CountryShape[] }
).features;

function build(): PlaceLabel[] {
  const labels: PlaceLabel[] = [];
  for (const country of SHAPES) {
    const name = country.properties.name;
    if (!name) continue;
    // Antarctica is a band along the bottom of every projection rather than a
    // shape with a middle; its centroid is the pole, and the label lands
    // nowhere useful. The continent layer already names it.
    if (name === 'Antarctica') continue;
    labels.push({
      name,
      id: country.id === undefined ? null : String(country.id),
      at: geoCentroid(mainland(country.geometry)),
      area: geoArea(country),
    });
  }
  // Biggest first, which is also the order labels claim space in when two of
  // them want the same patch of screen.
  return labels.sort((left, right) => right.area - left.area);
}

export const COUNTRIES: PlaceLabel[] = build();

/**
 * Which country a point on the globe falls in, or `null` for open water.
 *
 * This is what decides whose subdivisions to ask the API for: the reader
 * zooms, the map inverts the middle of the frame, and the country under that
 * point is the one worth fetching. Nothing else on this page needs to know
 * where a point is, which is why there is no general geocoder here.
 *
 * Bounds first, `geoContains` second. A point-in-polygon test against every
 * one of the 176 shapes is 10,000 vertices of work, and a longitude and
 * latitude comparison throws all but a handful of them out before any of that
 * runs — the same reason a spatial index exists, at the size where an array
 * and an `if` are the whole index. The box comparison has to allow for a shape
 * whose bounds cross the antimeridian, which `geoBounds` reports by returning
 * a west edge greater than its east one; Russia and Fiji both do.
 */
const BOXED: { shape: CountryShape; bounds: [[number, number], [number, number]] }[] = SHAPES.map(
  (shape) => ({ shape, bounds: geoBounds(shape as never) }),
);

export function countryAt(point: LngLat): PlaceLabel | null {
  const [longitude, latitude] = point;
  for (const { shape, bounds } of BOXED) {
    const [[west, south], [east, north]] = bounds;
    if (latitude < south || latitude > north) continue;
    const inside =
      west <= east
        ? longitude >= west && longitude <= east
        : longitude >= west || longitude <= east;
    if (!inside) continue;
    if (!geoContains(shape, point)) continue;
    return COUNTRIES.find((label) => label.name === shape.properties.name) ?? null;
  }
  return null;
}
