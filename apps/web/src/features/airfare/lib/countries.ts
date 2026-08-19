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

/**
 * The bundled outlines of the countries being redrawn, and of everything that
 * touches them without being one of them.
 *
 * Both halves are what make it possible to draw a country at a finer
 * resolution than the map around it. A finer outline does not coincide with
 * the 1:110m one: measured against the served 1:10m geometry the two sit a
 * median of 1.5 to 5.2 km apart depending on the country, and up to 31 km at
 * the worst vertex — five pixels typically at 32x, and thirty at worst. So the
 * coarse shapes are the region that has to be repainted, and the neighbours
 * are what has to be painted back inside it: without them, every stretch where
 * a neighbour's own 1:110m border was generalised inland shows as a strip of
 * ocean running along an international frontier.
 *
 * **`without being one of them` is the whole of what fan-out changed here.**
 * With one fine country among coarse neighbours, "paint the neighbours back"
 * could not go wrong. With a viewport's worth of fine countries it could go
 * wrong in exactly one way: Bolivia is a neighbour of Peru, and if Bolivia has
 * been drawn fine too then painting its coarse self back inside the clip
 * buries the fine frontier the two of them just agreed on under a 1:110m
 * approximation of it. So a country that is being redrawn is never anybody's
 * neighbour, and the coarse land that goes back is only ever the land no fine
 * shape is claiming.
 *
 * Neighbours by overlapping bounds rather than by shared arcs. It is the same
 * cheap test `countryAt` uses, a bounding box is the only thing this module
 * has already computed, and being generous costs nothing — a shape that is
 * near without touching only paints land that was going to be painted anyway.
 */
export function outlinesOf(ids: readonly string[]): { shapes: object[]; neighbours: object[] } {
  const wanted = new Set(ids);
  const found = BOXED.filter(
    (each) => each.shape.id !== undefined && wanted.has(String(each.shape.id)),
  );
  // `found` is a subset of `BOXED` and the entries are unique objects, so
  // excluding it by identity is the whole of "never a neighbour of itself or of
  // another country being redrawn" — one test rather than a second one keyed on
  // the id, which would say the same thing twice and could come to disagree.
  const neighbours = BOXED.filter(
    (other) => !found.includes(other) && found.some((each) => overlaps(each.bounds, other.bounds)),
  ).map((other) => other.shape as object);
  return { shapes: found.map((each) => each.shape as object), neighbours };
}

function overlaps(
  one: [[number, number], [number, number]],
  other: [[number, number], [number, number]],
): boolean {
  const [[west, south], [east, north]] = one;
  const [[otherWest, otherSouth], [otherEast, otherNorth]] = other;
  if (south > otherNorth || north < otherSouth) return false;
  // Longitude wraps, and either box may be the one crossing the antimeridian,
  // so this asks whether *neither* lies wholly to one side of the other rather
  // than comparing edges directly.
  const spans = (from: number, to: number, at: number) =>
    from <= to ? at >= from && at <= to : at >= from || at <= to;
  return (
    spans(west, east, otherWest) ||
    spans(west, east, otherEast) ||
    spans(otherWest, otherEast, west) ||
    spans(otherWest, otherEast, east)
  );
}

type Boxed = (typeof BOXED)[number];

function boxedAt(point: LngLat, hint: Boxed | null): Boxed | null {
  const [longitude, latitude] = point;
  const holds = ({ shape, bounds }: Boxed) => {
    const [[west, south], [east, north]] = bounds;
    if (latitude < south || latitude > north) return false;
    const inside =
      west <= east
        ? longitude >= west && longitude <= east
        : longitude >= west || longitude <= east;
    return inside && geoContains(shape, point);
  };
  // The hint is the country the last sample landed in. Neighbouring samples
  // are the same country far more often than not, so trying it first turns a
  // grid sweep from 177 bounds tests and a handful of polygon tests per sample
  // into one polygon test — measured over a zoomed-in view, it is most of what
  // makes sampling affordable at all.
  if (hint && holds(hint)) return hint;
  for (const boxed of BOXED) {
    if (boxed !== hint && holds(boxed)) return boxed;
  }
  return null;
}

export function countryAt(point: LngLat): PlaceLabel | null {
  const found = boxedAt(point, null);
  if (!found) return null;
  return COUNTRIES.find((label) => label.name === found.shape.properties.name) ?? null;
}

/** One country the camera can see, and how much of the frame it holds. */
export type CountryInView = {
  id: string;
  name: string;
  /** Sampled grid points that landed inside it — an area, in cells. */
  cells: number;
};

/**
 * How far apart the samples are, in CSS pixels.
 *
 * The grid is what decides both which countries are in view and how much of
 * the view each of them holds, so its spacing is the smallest country it can
 * see. At 12px a country needs about 150px² to be sampled at all, which is a
 * fifteenth of the 2400px² `LABEL_ROOM` asks before a country is even worth
 * naming — so nothing that could carry a name is ever missed, and what is
 * missed is a sliver a reader would need to be told was there.
 *
 * On the reader's own 529x460 stage that is 44 x 38 = 1,672 samples, which
 * runs in a few milliseconds and runs once, when the map settles. Halving it
 * would quadruple that for countries smaller than a name.
 */
export const VIEW_SAMPLE_STEP = 12;

/**
 * Every country the camera has in front of it, biggest on screen first.
 *
 * **A grid of samples rather than a projected bounding box**, because a box is
 * the wrong shape for this question in both directions. Brazil's projected
 * bounds can contain the whole frame while Brazil itself is in one corner of
 * it, so a box test would rank Brazil first over southern Peru; and a box
 * cannot tell a country that has gone round the limb from one that has not.
 * A sample either lands in a country or it does not, so the count *is* the
 * on-screen area, to within a cell, and the same sweep answers both halves of
 * what the caller needs: which countries, and in what order to spend on them.
 *
 * It also costs nothing to be right about the projection. `invert` is the
 * shown projection's own, so the globe's clip, the limb, Mercator's pan and
 * the antimeridian are all already handled by the time a point gets here —
 * there is no second model of the camera to keep in step with the first.
 *
 * Countries the atlas carries without a numeric id are left out: they are the
 * three the subdivision files could never be keyed by anyway.
 */
export function countriesInView(
  invert: (at: [number, number]) => [number, number] | null | undefined,
  frame: { width: number; height: number },
  step: number = VIEW_SAMPLE_STEP,
): CountryInView[] {
  const counts = new Map<string, { name: string; cells: number }>();
  let hint: Boxed | null = null;
  for (let y = step / 2; y < frame.height; y += step) {
    for (let x = step / 2; x < frame.width; x += step) {
      const at = invert([x, y]);
      // Off the globe entirely, or past the edge of a flat map.
      if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) continue;
      const found = boxedAt([at[0], at[1]], hint);
      hint = found;
      if (!found || found.shape.id === undefined) continue;
      const id = String(found.shape.id);
      const seen = counts.get(id);
      if (seen) seen.cells += 1;
      else counts.set(id, { name: found.shape.properties.name ?? id, cells: 1 });
    }
  }
  return [...counts.entries()]
    .map(([id, { name, cells }]) => ({ id, name, cells }))
    .sort((left, right) => right.cells - left.cells);
}
