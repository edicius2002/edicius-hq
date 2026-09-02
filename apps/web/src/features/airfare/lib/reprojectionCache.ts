/**
 * Reusing a projected `Path2D` across frames the camera actually moved in.
 *
 * `RouteMap.tsx` used to key its subdivision cache on the whole camera state —
 * projection, zoom, rotation and pan together — so any change to any one of
 * them missed the cache and paid to reproject a country's geometry from
 * scratch. Measured for the United States (326 KB of 1:10m land and internal
 * borders), that is 18 to 21 ms a frame; see
 * `docs/airfare-map-rendering.md` for the method. The comment the old cache
 * carried was explicit that this was meant to be paid once the camera stood
 * still — true at rest, false for every frame of an actual zoom or drag,
 * which is the gesture a reader described as stuttering.
 *
 * The fix rests on one fact about a `GeoProjection`: for a fixed rotation, it
 * is exactly `screen = translate + scale * u(lng, lat)`, where `u` does not
 * depend on scale or translate at all. So a `Path2D` built under one scale and
 * translate can be turned into what it would look like under another — same
 * rotation — by one affine map, computed once and handed to `Path2D.addPath`,
 * which the browser already applies as it merges. No trigonometry, no
 * resampling, and no approximation: `reprojectionCache.test.ts` checks the
 * result against a real reprojection, point for point.
 *
 * A rotation change is the one case this cannot do exactly — `u` itself moves,
 * differently for every point on the sphere, and no single affine map covers
 * that. `decideReuse` answers it with a bounded, deliberate lie instead: keep
 * drawing the last built shape, unmoved, for up to `throttleMs`, rather than
 * paying the full cost on every frame of a spin. The country's borders lag the
 * globe by at most that long and then snap back exact — a trade this map
 * already makes elsewhere (`SETTLE_MS`, `ARRIVAL_MS`) between showing the
 * latest thing and showing anything smoothly at all.
 *
 * **`throttleMs` used to be one constant everyone paid**, `ROTATE_REBUILD_MS`,
 * measured for the one country expensive enough to need it — the United
 * States. That made every lighter country lag the spin by just as much as the
 * heaviest one on file, for no reason: reprojecting El Salvador (1,031 land
 * and border vertices, decoded) costs a small fraction of reprojecting the
 * United States (41,825), so it can afford to catch up far sooner. Measured
 * live at a state-border zoom with the United States on screen (a 60°/s spin,
 * the method in `docs/airfare-map-rendering.md` §1.4), the flat 120 ms
 * throttle let the frozen shape drift up to ~60 px from where the live
 * projection put the same point before the next rebuild — a mismatch a
 * reader reads as a border in the wrong place. `rotateThrottleMs` scales the
 * throttle by `geometryWeight` instead, calibrated so the heaviest country on
 * file still gets exactly `ROTATE_REBUILD_MS` — no regression for the case
 * the constant was measured for — while Mexico (12,747, ~30% of the United
 * States' weight) catches up more than three times as often, and a country as
 * light as El Salvador rebuilds on nearly every frame instead of lagging a
 * fifth of a second behind the spin.
 */

/** The three numbers of a `GeoProjection` that decide where a point lands. */
export type ProjectionSnapshot = {
  rotation: readonly [number, number, number];
  scale: number;
  translate: readonly [number, number];
};

/** A 2D affine matrix, in the shape both `CanvasRenderingContext2D` and `Path2D.addPath` take. */
export type Matrix2D = { a: number; b: number; c: number; d: number; e: number; f: number };

export const IDENTITY_MATRIX: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Whether two rotations are the same projection state, not merely close. */
export function sameRotation(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * The affine map from geometry built under `from` to how it looks under `to`.
 *
 * Only correct when `from.rotation` and `to.rotation` are the same — the
 * caller's job to check, via `sameRotation`, before trusting this. Given that,
 * it is not an approximation: `reprojectionCache.test.ts` proves it lands on
 * the exact pixel a full reprojection would.
 */
export function affineMatrix(from: ProjectionSnapshot, to: ProjectionSnapshot): Matrix2D {
  const k = to.scale / from.scale;
  return {
    a: k,
    b: 0,
    c: 0,
    d: k,
    e: to.translate[0] - k * from.translate[0],
    f: to.translate[1] - k * from.translate[1],
  };
}

/** Applies a matrix to a point, the same way `Path2D.addPath` would to every point in a path. */
export function applyMatrix(matrix: Matrix2D, point: readonly [number, number]): [number, number] {
  return [
    matrix.a * point[0] + matrix.c * point[1] + matrix.e,
    matrix.b * point[0] + matrix.d * point[1] + matrix.f,
  ];
}

/**
 * Whether the same pieces of a country's geometry were kept in or out.
 *
 * The affine map only repositions the vertices a `Path2D` already holds — it
 * cannot add a piece that culling left out. Most countries are one contiguous
 * shape, so this is always true for them once they are on screen at all; it
 * exists for the ones that are not, the same reason `lib/visible.ts` culls
 * piece by piece rather than country by country — Chile's mainland and its
 * Easter Island are each their own `landParts` entry, and a reader who pans
 * from one onto the other must not find the island missing because the
 * `Path2D` that would have drawn it was built before it came into reach.
 */
export function sameSelection(a: readonly boolean[], b: readonly boolean[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export type CachedGeometry<T> = {
  of: T;
  snapshot: ProjectionSnapshot;
  builtAt: number;
  /** Which `landParts`/`borderRuns` (by index) went into the cached `Path2D`s. */
  includedLand: readonly boolean[];
  includedBorders: readonly boolean[];
};

export type ReuseDecision =
  /** Not cached, or the data itself changed: nothing to reuse. */
  | { kind: 'rebuild' }
  /** Cached under the same rotation: draw it through this exact affine map. */
  | { kind: 'reuse'; matrix: Matrix2D }
  /** Rotation changed, but not long enough ago to be worth paying for: draw it unmoved. */
  | { kind: 'stale' };

/**
 * What to do with a country's cached geometry this frame.
 *
 * `throttleMs` bounds only the *rotation-changed* case — a rebuild triggered
 * by new data, or one the affine map cannot cover, is never deferred by it.
 * `includedLand`/`includedBorders` are this frame's own culling result —
 * computed by the caller either way, since a rebuild needs them too — so a
 * piece that just crossed into or out of view forces a rebuild instead of an
 * affine map that could not add or drop it.
 */
export function decideReuse<T>(
  cached: CachedGeometry<T> | undefined,
  of: T,
  snapshot: ProjectionSnapshot,
  now: number,
  throttleMs: number,
  includedLand: readonly boolean[],
  includedBorders: readonly boolean[],
): ReuseDecision {
  if (!cached || cached.of !== of) return { kind: 'rebuild' };
  if (sameRotation(cached.snapshot.rotation, snapshot.rotation)) {
    if (
      sameSelection(cached.includedLand, includedLand) &&
      sameSelection(cached.includedBorders, includedBorders)
    ) {
      return { kind: 'reuse', matrix: affineMatrix(cached.snapshot, snapshot) };
    }
    return { kind: 'rebuild' };
  }
  return now - cached.builtAt < throttleMs ? { kind: 'stale' } : { kind: 'rebuild' };
}

/**
 * How long a country's borders may lag a spin before they are worth
 * reprojecting again, in milliseconds.
 *
 * About eight updates a second — slow enough that rebuilding the heaviest
 * country on file (the United States, 18 to 21 ms measured) costs a small
 * fraction of any one frame once spread over the gap, fast enough that the
 * lag reads as the country keeping up with the spin rather than as it being
 * wrong. It only ever applies to a country already on screen and already
 * fine — a reader spinning past new ground still gets it at the zoom gate's
 * own pace, this only decides how often an already-detailed country's own
 * shape is asked to catch up.
 */
export const ROTATE_REBUILD_MS = 120;

/**
 * A country's land and internal-border vertex count, decoded — the same unit
 * `geoPath` pays to project one at a time, and so a fair stand-in for how
 * expensive rebuilding this country's `Path2D` is.
 *
 * Only ring and run *lengths* are read, never a coordinate itself, so this
 * costs nothing close to what it is standing in for: an array's `.length` is
 * one property read regardless of how many points are behind it. Safe to call
 * every frame for every country on screen, which is what lets `throttleMs`
 * be recalculated live rather than baked in once.
 */
export function geometryWeight(
  landParts: readonly { shape: { coordinates: readonly (readonly number[])[][] } }[],
  borderRuns: readonly { shape: { coordinates: readonly (readonly number[])[] } }[],
): number {
  let total = 0;
  for (const part of landParts) for (const ring of part.shape.coordinates) total += ring.length;
  for (const run of borderRuns) total += run.shape.coordinates.length;
  return total;
}

/**
 * The heaviest country on file, weighed by `geometryWeight` — the United
 * States' decoded 1:10m land and internal borders (41,825 points; measured
 * live in the running app, not from the served file — TopoJSON's arc sharing
 * and the many small disjoint pieces of a real coastline mean decoded point
 * count is not a simple multiple of the 326 KB `docs/airfare-map-rendering.md`
 * §1.2 measures on the wire). The calibration point for `rotateThrottleMs`:
 * this weight is the one that still gets the full `ROTATE_REBUILD_MS`, so the
 * country the constant was measured for sees no regression from this change.
 */
export const REFERENCE_GEOMETRY_WEIGHT = 41_825;

/**
 * How long a country of this weight may lag a spin before it is worth
 * reprojecting again, in milliseconds — `decideReuse`'s `throttleMs`, scaled
 * instead of flat.
 *
 * Linear in weight, capped at `ROTATE_REBUILD_MS`: a country as heavy as
 * `REFERENCE_GEOMETRY_WEIGHT` gets the full throttle, unchanged from before
 * this scaling existed; a country a fifth as heavy gets a fifth of it, and
 * catches up roughly five times as often. Nothing exceeds the historical cap
 * — a country heavier than any on file today would still be bounded at
 * `ROTATE_REBUILD_MS`, not thrown further.
 */
export function rotateThrottleMs(weight: number): number {
  return Math.min(ROTATE_REBUILD_MS, (weight / REFERENCE_GEOMETRY_WEIGHT) * ROTATE_REBUILD_MS);
}
