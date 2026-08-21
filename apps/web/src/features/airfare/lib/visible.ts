import { geoDistance, type GeoProjection } from 'd3-geo';

import type { LngLat } from '@/features/airfare/lib/geo';

/**
 * What can possibly be on screen, so that everything else is never projected.
 *
 * **Every per-frame cost this map has is one sentence: walk every vertex of a
 * worldwide dataset through the projection.** Measured in Chrome on a
 * production build, on the reader's own 433x460 stage, during a sixteen-notch
 * wheel zoom to the 32x ceiling: a frame spent 9.4 to 12.1 ms filling the
 * bundled 1:110m land and 6.0 to 8.1 ms stroking its boundary mesh, out of a
 * 17.6 to 21.7 ms frame — half the frame on the fill and a third on the lines,
 * with the arcs, the labels, the overlap test and the React commit together
 * making up the rest. On a 165 Hz panel, whose frame budget is 6.1 ms, that is
 * a zoom running at forty frames a second.
 *
 * Almost none of that work could ever be seen. The globe's radius is
 * `0.42 x 460 x zoom`, so at 32x it is 6,182 px while the frame's half-diagonal
 * is 316 px — the reader is looking at a spherical cap 2.9° across, and the
 * other 99.9% of the planet is rotated, projected, resampled and handed to the
 * canvas so that the canvas can throw it away. d3-geo cannot avoid this on our
 * behalf: `clipExtent` runs *after* the projection in its stream, so it saves
 * the rasteriser and not the arithmetic, and `clipAngle` only knows about the
 * hemisphere, not about the frame.
 *
 * With this in place the same gesture holds a 6.1 ms median and never exceeds
 * 24 ms, and the frames it delivers over the same 1.4 s go from 66 to 156.
 *
 * So the geometry is indexed once, by where it is and how far it reaches, and a
 * frame projects only the pieces whose reach touches what the camera can see.
 *
 * **A cap rather than a bounding box**, because a box is a lie on a sphere:
 * Russia's runs from -180° to 180° and Antarctica's says the same about a shape
 * you can walk around, and neither box shrinks when the reader zooms in. A cap
 * — a centre and an angular radius — is the same shape the camera itself has on
 * a globe, so the test is one distance against one sum, and it stays exact when
 * a shape crosses the antimeridian or contains a pole because a great-circle
 * distance does not care where the date line is.
 *
 * **It is conservative in the only direction that matters.** The cap that goes
 * into the index encloses the geometry rather than fitting it, and the cap that
 * comes out of the camera encloses the frame rather than fitting it, so a piece
 * is dropped only when it provably cannot touch a pixel. The failure mode is
 * drawing something that turns out to be off screen, which costs a little time;
 * the failure mode it cannot have is a coastline that is not there.
 */

/** A circle on the sphere: where it is centred, and how far it reaches. */
export type Cap = {
  at: LngLat;
  /** Angular radius in radians. `Math.PI` is the whole sphere. */
  radius: number;
};

/** Everything, for the cases where culling would be wrong rather than merely useless. */
export const EVERYWHERE: Cap = { at: [0, 0], radius: Math.PI };

type Positions = number[] | Positions[];
type Geometry = { type: string; coordinates?: Positions; geometries?: Geometry[] };
type Shape = Geometry | { type: 'Feature'; geometry: Geometry };

/** The extent of a shape in each axis, from one pass over its coordinates. */
type Extent = { west: number; east: number; south: number; north: number; any: boolean };

function spread(coordinates: Positions, into: Extent): void {
  if (coordinates.length === 0) return;
  if (typeof coordinates[0] === 'number') {
    const [longitude, latitude] = coordinates as number[];
    into.any = true;
    if (longitude < into.west) into.west = longitude;
    if (longitude > into.east) into.east = longitude;
    if (latitude < into.south) into.south = latitude;
    if (latitude > into.north) into.north = latitude;
    return;
  }
  for (const nested of coordinates as Positions[]) spread(nested, into);
}

function extentOf(shape: Shape, into: Extent): void {
  if (shape.type === 'Feature') {
    extentOf((shape as { geometry: Geometry }).geometry, into);
    return;
  }
  const geometry = shape as Geometry;
  if (geometry.geometries) {
    for (const each of geometry.geometries) extentOf(each, into);
    return;
  }
  if (geometry.coordinates) spread(geometry.coordinates, into);
}

/**
 * The widest a longitude/latitude box may be before its corners stop being its
 * extremes.
 *
 * The corner rule below rests on `cos d = sin φc sin φ + cos φc cos φ cos Δλ`
 * having no interior minimum in `φ`, and it has one exactly when `cos Δλ` turns
 * negative. So a box narrower than half the planet is answered by its corners
 * and a box wider than that is not answered at all.
 *
 * Getting this wrong is not a slower map, it is a missing coastline, and it
 * very nearly shipped: the flat map at its default scale shows all 360° of
 * longitude, and the corner rule put its cap at 95° when a point at the right
 * edge of the frame was 180° away. Everything in that half of the world would
 * have been culled while it was on screen.
 */
const HALF_THE_WORLD = 180;

/**
 * The circle that encloses a shape, computed once and never again.
 *
 * One pass over the coordinates for the extent, then **four** great-circle
 * distances — to the corners of that extent, and not to the vertices. The
 * corners are enough for any box narrower than `HALF_THE_WORLD`, and its
 * comment carries the reason; the shape is inside its box, so a cap that holds
 * the box holds the shape.
 *
 * Measuring every vertex instead would give a slightly tighter cap for a ragged
 * shape and cost a `geoDistance` per point: measured, that was 14.3 ms to index
 * one country's 1:10m geometry against 1.4 ms here, three times over on a
 * fan-out, on the main thread in the moment the reader has just stopped moving.
 * `geoCentroid` for the centre would have been worse again — a full spherical
 * stream per shape — for an answer this does not need to be right about, only
 * conservative about.
 *
 * A shape crossing the antimeridian gets an extent spanning the world and is
 * therefore never culled: Russia, Fiji and Antarctica are drawn every frame,
 * exactly as often as they were before this module existed.
 */
export function capOf(shape: Shape): Cap {
  const found: Extent = {
    west: Infinity,
    east: -Infinity,
    south: Infinity,
    north: -Infinity,
    any: false,
  };
  extentOf(shape, found);
  if (!found.any) return { at: [0, 0], radius: 0 };
  if (found.east - found.west > HALF_THE_WORLD) return EVERYWHERE;
  const at: LngLat = [(found.west + found.east) / 2, (found.south + found.north) / 2];
  let radius = 0;
  for (const longitude of [found.west, found.east]) {
    for (const latitude of [found.south, found.north]) {
      const away = geoDistance(at, [longitude, latitude]);
      if (away > radius) radius = away;
    }
  }
  return { at, radius };
}

/**
 * Whether two caps touch at all, which is the whole of the visibility test.
 *
 * Both are over-estimates of what they stand for, so a `false` here is a proof
 * that the shape cannot reach the frame and a `true` is only a suspicion that
 * it might — which is the right way round.
 */
export function capsMeet(one: Cap, other: Cap): boolean {
  if (one.radius >= Math.PI || other.radius >= Math.PI) return true;
  return geoDistance(one.at, other.at) <= one.radius + other.radius;
}

/**
 * How much a cap is padded before anything is dropped against it.
 *
 * About 0.6°, and it is there for the two things this arithmetic does not
 * model: a stroke has width, so a border a hair outside the frame still puts
 * ink a pixel inside it, and `geoPath` resamples a segment into a curve that
 * can bow further out than either of its ends. At the 32x ceiling 0.01 rad is
 * 64 km, which is twenty times the widest bow the 1:110m mesh produces there;
 * at 1x it is a tenth of a degree of the visible hemisphere and costs nothing.
 */
const MARGIN = 0.01;

/**
 * The cap the camera can see, or `EVERYWHERE` when it can see enough that
 * asking is a waste.
 *
 * The globe is answered analytically. An orthographic maps a point `θ` away
 * from the centre of the disc to `R·sin θ` pixels from the middle of the frame,
 * so the furthest corner of the frame is `asin(d / R)` away and there is
 * nothing on screen beyond it. Once the frame's half-diagonal reaches the
 * radius the whole near hemisphere is in view and the answer is the hemisphere,
 * which is still worth having: half a planet is half the vertices.
 *
 * The flat map is answered by asking it. Mercator is not a projection this
 * module wants a second model of — it has a rotation, a pan, a clamp at the
 * poles and a scale of its own — so the frame's own corners are inverted
 * through it and the cap is the furthest of them from the middle. A corner that
 * inverts to nothing means there is nothing to cull, and the answer says so.
 *
 * The one thing it does take on trust is that the flat map is cylindrical, so
 * that `2π · scale` is the whole world across and the frame's share of it is
 * the longitude on screen. That is used for one test and one only: a frame
 * showing more than `HALF_THE_WORLD` is a frame no cap can describe, and at the
 * default scale this map is fitted to exactly 360° of it.
 */
export function viewCap(
  shown: GeoProjection,
  frame: { width: number; height: number },
  globe: boolean,
  rotation: readonly [number, number, number],
): Cap {
  if (!frame.width || !frame.height) return EVERYWHERE;
  const reach = Math.hypot(frame.width / 2, frame.height / 2);

  if (globe) {
    const radius = shown.scale();
    if (!(radius > 0)) return EVERYWHERE;
    return {
      at: [-rotation[0], -rotation[1]],
      radius: (reach >= radius ? Math.PI / 2 : Math.asin(reach / radius)) + MARGIN,
    };
  }

  // 360° of longitude is `2π · scale` across, so the frame holds
  // `360 · width / (2π · scale)` of it; more than half the world and the corner
  // rule stops holding — see `HALF_THE_WORLD`.
  const across = shown.scale() > 0 ? (360 * frame.width) / (2 * Math.PI * shown.scale()) : Infinity;
  if (across > HALF_THE_WORLD) return EVERYWHERE;

  const middle = shown.invert?.([frame.width / 2, frame.height / 2]);
  if (!middle || !Number.isFinite(middle[0]) || !Number.isFinite(middle[1])) return EVERYWHERE;
  const at: LngLat = [middle[0], middle[1]];
  let radius = 0;
  for (const corner of [
    [0, 0],
    [frame.width, 0],
    [0, frame.height],
    [frame.width, frame.height],
  ] as [number, number][]) {
    const there = shown.invert?.(corner);
    // A corner off the edge of the map is a frame wider than the world, which
    // is a view with nothing to cull rather than a view of nothing.
    if (!there || !Number.isFinite(there[0]) || !Number.isFinite(there[1])) return EVERYWHERE;
    const away = geoDistance(at, [there[0], there[1]]);
    if (away > radius) radius = away;
  }
  return { at, radius: radius + MARGIN };
}

/**
 * A shape kept beside the cap that encloses it, which is the form the map draws
 * from.
 *
 * The index is built where the geometry is: once at import for the bundled
 * atlas, and when the drawn set moves for the boundary mesh — never in a frame.
 */
export type Capped<T> = { shape: T; cap: Cap };

export function capped<T extends Shape>(shapes: readonly T[]): Capped<T>[] {
  return shapes.map((shape) => ({ shape, cap: capOf(shape) }));
}

/**
 * A `MultiLineString` taken apart into its own runs, each with its own cap.
 *
 * The boundary mesh is one geometry holding every national border in the world,
 * and drawn as one geometry it is all-or-nothing: at the 32x ceiling the map
 * strokes 10,000 km of frontier to show 30 km of it. The runs are independent
 * lines that happen to be stored together, so taking them apart drops nothing
 * and changes nothing about what is painted — the same lines, stroked in the
 * same pass, minus the ones that are somewhere else.
 */
export function cappedRuns(mesh: {
  type: 'MultiLineString';
  coordinates: LngLat[][];
}): Capped<{ type: 'LineString'; coordinates: LngLat[] }>[] {
  return mesh.coordinates.map((coordinates) => {
    const shape = { type: 'LineString' as const, coordinates };
    return { shape, cap: capOf(shape) };
  });
}
