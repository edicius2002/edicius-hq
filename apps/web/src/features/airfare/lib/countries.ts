import { geoArea, geoBounds, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';
import worldAtlas from 'world-atlas/countries-110m.json';

import type { LngLat } from '@/features/airfare/lib/geo';
import { type Solid, solidHolds, solidOf } from '@/features/airfare/lib/inside';

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
 * Bounds first, `solidHolds` second. A point-in-polygon test against every
 * one of the 177 shapes is 10,000 vertices of work, and a longitude and
 * latitude comparison throws all but a handful of them out before any of that
 * runs — the same reason a spatial index exists, at the size where an array
 * and an `if` are the whole index. The box comparison has to allow for a shape
 * whose bounds cross the antimeridian, which `geoBounds` reports by returning
 * a west edge greater than its east one; Russia and Fiji both do.
 *
 * The second test used to be `geoContains`, and swapping it for the flattened
 * rings in `inside.ts` is most of what took the settle sweep from 12.5–77.8 ms
 * to 1.2–4.4 on the widest stage this layout produces — see that module for
 * what a planar test costs and what it gives up. The bucket index below is the
 * rest of it.
 */
const BOXED: {
  shape: CountryShape;
  bounds: [[number, number], [number, number]];
  solid: Solid;
}[] = SHAPES.map((shape) => ({
  shape,
  bounds: geoBounds(shape as never),
  solid: solidOf(shape as never),
}));

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

/**
 * How big a square of the world one bucket of the index stands for.
 *
 * Five degrees: 72 by 36 buckets holding 3,354 entries between them, 758 of
 * them empty, a median non-empty bucket of one shape and a fullest of twelve.
 * A sample therefore walks one box where it used to walk 177, and none at all
 * over most of the open ocean.
 */
const BUCKET = 5;
const COLUMNS = 360 / BUCKET;
const ROWS = 180 / BUCKET;

/**
 * The shapes whose bounds reach each square of the world, in atlas order.
 *
 * **This is what a sample that lands on water costs.** The hint below takes
 * care of a sample that lands in the same country as the one before it, which
 * on a zoomed-in view is most of them — but a sample over the sea matches no
 * hint and fell through to all 177 boxes, and then to a polygon test for every
 * box that happened to contain it. Chile's box alone runs from Easter Island
 * to Cape Horn, so half the South Pacific was paying for Chile.
 *
 * With the containment test already made cheap, this was what was left.
 * Measured on a 1550x460 stage at step 12, toggling only this: the 32x view
 * over Santiago 3.3 times, the 32x view over open Pacific 5.2 times, central
 * Europe at 3.4x 3.4 times, Lima at 8x 3.2 times. A bucket lookup is two
 * multiplications and an array index, and it answers open water with an empty
 * list.
 *
 * Built from the same bounds the fall-through used, so it can only ever hand
 * back a superset of what the fall-through would have tested, and the order
 * inside a bucket is the order the fall-through walked them in — which is what
 * keeps the answer identical for a point two shapes both claim.
 */
const BUCKETS: Boxed[][] = (() => {
  const built: Boxed[][] = Array.from({ length: COLUMNS * ROWS }, () => []);
  for (const boxed of BOXED) {
    const [[west, south], [east, north]] = boxed.bounds;
    const first = Math.max(0, Math.floor((south + 90) / BUCKET));
    const last = Math.min(ROWS - 1, Math.floor((north + 90) / BUCKET));
    // A box reported east-of-west is one crossing the antimeridian, and it
    // covers every column rather than none — the same reading `holds` gives it.
    const columns: number[] = [];
    if (west <= east) {
      const from = Math.max(0, Math.floor((west + 180) / BUCKET));
      const to = Math.min(COLUMNS - 1, Math.floor((east + 180) / BUCKET));
      for (let column = from; column <= to; column += 1) columns.push(column);
    } else {
      for (let column = 0; column < COLUMNS; column += 1) columns.push(column);
    }
    for (let row = first; row <= last; row += 1)
      for (const column of columns) built[row * COLUMNS + column].push(boxed);
  }
  return built;
})();

function bucketAt(longitude: number, latitude: number): Boxed[] {
  const column = Math.min(COLUMNS - 1, Math.max(0, Math.floor((longitude + 180) / BUCKET)));
  const row = Math.min(ROWS - 1, Math.max(0, Math.floor((latitude + 90) / BUCKET)));
  return BUCKETS[row * COLUMNS + column];
}

function boxedAt(point: LngLat, hint: Boxed | null): Boxed | null {
  const [longitude, latitude] = point;
  const holds = ({ bounds, solid }: Boxed) => {
    const [[west, south], [east, north]] = bounds;
    if (latitude < south || latitude > north) return false;
    const inside =
      west <= east
        ? longitude >= west && longitude <= east
        : longitude >= west || longitude <= east;
    return inside && solidHolds(solid, longitude, latitude);
  };
  // The hint is the country the last sample landed in. Neighbouring samples
  // are the same country far more often than not, so trying it first turns a
  // grid sweep into one polygon test — measured over a zoomed-in view, it is
  // most of what makes sampling affordable at all.
  if (hint && holds(hint)) return hint;
  for (const boxed of bucketAt(longitude, latitude)) {
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
 * The grid decides both which countries are in view and how much of the view
 * each holds, so its spacing is the smallest country it can see — and its cost
 * and its blindness are the same number twice, because both go as the square of
 * it. 12 px a cell is 144px² against the 2400px² a country needs before
 * `roomFade` will give it a name at all: the grid can see a country sixteen
 * times smaller than the smallest one the map will name.
 *
 * **This was 17 for one commit, and 17 was bought with a premise that has since
 * moved.** 17 is 12 x sqrt(2), which halves the sample count, and it was worth
 * a little blindness when the samples cost what they did. They do not any more:
 * on a 526x460 stage at the 32x ceiling over Santiago, the sweep that measured
 * 25.7 ms at step 17 measures 0.72 ms at step 17 now, with `inside.ts` under
 * the containment test and the bucket index in front of it. Measured at the
 * widest stage this layout can produce — 1550x460, which is a 2560-pixel
 * viewport — ten views from the 3.4x gate to the ceiling, on both projections,
 * run 1.20 to 4.42 ms at step 12 against 0.60 to 2.38 at step 17, where before
 * this they ran 12.5 to 77.8. Both are one frame. Buying the margin back with
 * two milliseconds nobody can feel is the right side of that trade, and a
 * decision made for a cost that no longer exists should not be left standing
 * because it is already written down.
 *
 * The margin is what 12 buys. `placeNames.test` pins the property — a country
 * holding `LABEL_ROOM` of the frame is always found — and walking the constant
 * up, it holds at every step through 32 and first fails at 36, past which
 * whether a given country is caught depends on where the grid happens to land.
 * That was true of 17 too; the difference is how much of the room between the
 * two is left for a view nobody has tried.
 *
 * The thin-country worry, which is the one a grid deserves, is not real here: a
 * shape narrower than the spacing can hide between samples however long it is,
 * and Chile is the shape that argument exists for. Measured, the widest run of
 * Chile across the frame never falls below 33px anywhere from the 3.4x gate to
 * the ceiling, over Santiago or over Arica.
 *
 * **What made the old numbers look worse than they were: the panel is not the
 * stage.** The cost goes with the area swept, and the last round of this work
 * quoted it at 2100x1200 on the assumption that a maximised window gives the
 * map a maximised stage. It does not. `.stage` carries the row's whole height
 * and the row does not grow, so that one number is the height at every window
 * size — the sweep grows with the width of one panel, not with the area of a
 * screen.
 *
 * **The figures above were taken at `min-height: 460px`, which is now 640, and
 * a narrower watchlist beside it.** `a-taller-row-is-four-more-routes` moved
 * both. The stage is 606 wide at a 1518-pixel viewport where it was 526, 990
 * at 1902 where it was 910, and 1630 at 2542 where it was 1550 — so the widest
 * this layout produces goes from 129x38 samples to 136x53, 4,902 to 7,208, up
 * 47%. The ten views quoted at 1.20 to 4.42 ms are 1.76 to 6.50 ms there, and
 * step 12 is still the right side of the trade the paragraph above argues:
 * what was bought with two milliseconds nobody can feel is now bought with
 * three.
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
