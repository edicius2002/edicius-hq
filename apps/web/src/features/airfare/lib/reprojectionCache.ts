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
 * that. `decideReuse` answers it with a bounded, deliberate trade instead:
 * hold the 1:10m shape back for up to `throttleMs` rather than paying the
 * full cost of rebuilding it on every frame of a spin — the same kind of
 * trade this map already makes elsewhere (`SETTLE_MS`, `ARRIVAL_MS`) between
 * showing the latest thing and showing anything smoothly at all. What
 * `RouteMap.tsx` draws in place of the held-back shape is its job, not this
 * module's — see below for why that used to be "the last built shape,
 * unmoved" and no longer is.
 *
 * **`throttleMs` used to be one constant everyone paid**, `ROTATE_REBUILD_MS`,
 * measured for the one country expensive enough to need it — the United
 * States. That made every lighter country lag the spin by just as much as the
 * heaviest one on file, for no reason: reprojecting El Salvador (1,031 land
 * and border vertices, decoded) costs a small fraction of reprojecting the
 * United States (41,825), so it can afford to catch up far sooner.
 * `rotateThrottleMs` scales the throttle by `geometryWeight` instead,
 * calibrated so the heaviest country on file still gets exactly
 * `ROTATE_REBUILD_MS` — no regression for the case the constant was measured
 * for — while Mexico (12,747, ~30% of the United States' weight) catches up
 * more than three times as often, and a country as light as El Salvador
 * rebuilds on nearly every frame.
 *
 * **What "held back" draws changed once this was measured against a moving
 * globe rather than a still one.** Measured live at a state-border zoom with
 * the United States on screen (a 60°/s spin, the method in
 * `docs/airfare-map-rendering.md` §1.4), drawing the frozen 1:10m shape
 * unmoved for up to `throttleMs` let it drift up to ~60 px from where the
 * live projection put the same point — a mismatch a reader reads as a border
 * in the wrong place, and one that scaling the throttle by weight does
 * nothing for, because it is a lie about *position* and every value of
 * `throttleMs` above zero tells it for some span of time. `RouteMap.tsx` no
 * longer tells that lie: while a country's 1:10m shape is held back, it draws
 * that country's bundled 1:110m outline instead, reprojected fresh every
 * frame from the live rotation — coarser for as long as the throttle says,
 * but never anywhere but where the country actually is. The measured
 * mismatch for the United States is now ~0 px at every sampled frame, not
 * because the throttle changed, but because what stands in for the held-back
 * shape moves with the globe instead of sitting still.
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
  /**
   * Rotation changed, but not long enough ago to be worth paying for: the
   * 1:10m shape stays as it was last built, and the caller draws something
   * cheaper in its place for this frame instead of reprojecting it — a
   * coarser but correctly positioned outline in `RouteMap.tsx`, not the stale
   * shape itself.
   */
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
 * How long a country's 1:10m detail may lag a spin before it is worth
 * reprojecting again, in milliseconds — its outline itself never lags, see
 * the header above.
 *
 * About eight updates a second — slow enough that rebuilding the heaviest
 * country on file (the United States, 18 to 21 ms measured) costs a small
 * fraction of any one frame once spread over the gap, fast enough that the
 * coarser stand-in reads as the country's own detail catching up with the
 * spin rather than as a country stuck at the wrong resolution. It only ever
 * applies to a country already on screen and already fine — a reader
 * spinning past new ground still gets it at the zoom gate's own pace, this
 * only decides how often an already-detailed country's own admin borders are
 * asked to catch up.
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

/**
 * What stands in for a country's held-back 1:10m geometry while a rotation is
 * in flight.
 *
 * `decideReuse` answering `stale` says only that the fine shape must not be
 * rebuilt this frame. It does not say what to draw instead, and there are two
 * answers. The country's own 1:110m outline, reprojected fresh under the live
 * rotation, is exactly where it belongs — coarser, but in its place. Without
 * one on hand there is only the fine shape it already holds, drawn unmoved,
 * which is where the visible drift comes from.
 */
export type StandIn = 'coarse-outline' | 'frozen-fine';

export function standInFor(hasCoarseOutline: boolean): StandIn {
  return hasCoarseOutline ? 'coarse-outline' : 'frozen-fine';
}

/**
 * Whether a country's internal borders may be stroked over that stand-in.
 *
 * Never over a coarse outline. The admin borders are 1:10m lines built under
 * an older rotation and the outline beneath them has just moved, so stroking
 * the two together draws state borders crossing the coast rather than
 * following it. The frozen fine shape has the opposite property: it is stale
 * in exactly the way its own borders are, so the two still agree with each
 * other, and holding them back would only remove detail that is no more wrong
 * than the coastline it sits inside.
 */
export function strokesInnerBorders(standIn: StandIn): boolean {
  return standIn === 'frozen-fine';
}

/**
 * Whether every redrawn country on screen must fall back to its coarse
 * stand-in together this frame, rather than let each answer `decideReuse` for
 * itself.
 *
 * A shared frontier tessellates when both sides are surveyed at the same
 * resolution — two neighbouring 1:10m outlines agree to a median of 67-133 m
 * (`docs/airfare-map-rendering.md`), close enough that filling each from its
 * own file still meets its neighbour's edge. A 1:10m outline and its own
 * bundled 1:110m generalisation were never reconciled against each other at
 * all: they part by a median of 1.5 to 5.2 km and up to 31 km at the worst
 * vertex — worse where the coast turns, which is exactly where a country's
 * own land border with the next one tends to sit. `decideReuse` decides
 * `stale` per country, independently of its neighbours, so a spin can hold
 * one country's fine shape back while a country beside it has already
 * rebuilt or reused its own. The two shapes are then filled from different
 * resolutions inside the same clipped region, and the km-scale gap between
 * them is not double-painted, it is unpainted: a strip of whatever sits
 * under the map showing through along the frontier, on the leading edge of
 * the spin — measured live and confirmed by forcing one country `stale`
 * while its neighbours were not.
 *
 * The fix cannot be per-country, because the mismatch is between two
 * countries' answers, not wrong in either one alone. The moment any one of
 * this frame's redrawn countries is held back, every one of them draws its
 * own coarse stand-in for that frame — matching resolution with matching
 * resolution, the same way two fine outlines already agree with each other.
 * The cost is a country that was itself due to catch up sooner sitting
 * coarse for as long as its slowest neighbour does; cheaper than the seam it
 * would otherwise open.
 */
export function anyStale(decisions: readonly ReuseDecision[]): boolean {
  return decisions.some((decision) => decision.kind === 'stale');
}

/**
 * Whether every redrawn country must fall back to its coarse stand-in
 * because the reader is turning the globe by hand, rather than because
 * `decideReuse` ran the throttle and answered `stale`.
 *
 * `anyStale` fixed a *spatial* mismatch — two neighbours filled from two
 * resolutions in the same frame. This fixes a *temporal* one, reported
 * separately once that seam was gone: during one continuous drag, rotation
 * changes on every frame, so a light country's own `rotateThrottleMs` keeps
 * expiring and being renewed every few frames — cheap enough to rebuild
 * almost every time, but each rebuild is a moment where *that* country
 * answers `rebuild` while a heavier neighbour still answers `stale`. Whether
 * `anyStale` reads `true` or `false` at any given instant now depends on
 * which countries happen to have rebuilt in the last few milliseconds, which
 * flips several times over one drag — the fine/coarse swap this document
 * already accepts once per throttle window turns into the admin borders
 * blinking in and out throughout the gesture, not a border seam but a border
 * that will not hold still.
 *
 * A held pointer answers a question `decideReuse` was never asked: not
 * "is this country's own geometry due for a refresh", but "is the reader
 * mid-gesture at all". While they are, the honest answer is coarse for
 * everyone, for the gesture's whole duration — one transition down when it
 * starts, one transition back up when it ends, and nothing in between,
 * because nothing about *why* the map is degraded changes from one frame of
 * the drag to the next. `now < until` extends that same answer for a short
 * grace period after the pointer lifts, so the rebuild `decideReuse` would
 * otherwise ask for on the very next frame — every held-back country at
 * once, since a continuous drag leaves all of their caches equally stale —
 * lands a beat after the drag stops instead of inside the frame that stops
 * it, which is one settle rather than one more flip.
 *
 * `zoomGliding` answers the same question for a wheel or keyboard zoom, which
 * is never a `gestureKind` because no pointer is held down for it. A zoom on
 * the globe still changes rotation on every frame it is in flight: `applyZoom`
 * re-anchors the point under the cursor back to a fixed screen position, and
 * on a sphere the only way to hold a point still under a moving scale is to
 * turn — so a zoom glide hits the exact case `decideReuse` cannot cover
 * exactly, the same as a spin, just measured smaller: simulating a 40-frame
 * zoom-in glide through `decideReuse` directly counted 10 coarse/fine
 * transitions where the old, zoom-blind `forcesDegrade` never answered `true`
 * for any of them, and 14 for a 55-frame zoom-out. `until` already carries a
 * shared grace deadline rather than a per-gesture one, so the caller can set
 * it from wherever a zoom glide ends too — `stepZoom` snapping to target on
 * its own, or `endGlide` forcing it there — and pay for only one more
 * parameter here.
 *
 * `pinch` degrades for the same reason `rotate` does, and it is not covered by
 * `zoomGliding` alone. A two-finger pinch drives the scale through the very
 * same `aimZoom`, so it re-anchors — and therefore turns the globe — on every
 * frame the fingers move; but `zoomGliding` is `zoom.current !==
 * zoomTarget.current`, which the easing closes within a few frames of the
 * fingers pausing. A reader who holds a pinch still for half a second and then
 * carries on would get a full rebuild in the middle of their own gesture, and
 * then a second transition back down when they moved again. A held pointer is
 * the honest signal here, exactly as it is for a drag.
 */
export function forcesDegrade(
  gestureKind: 'rotate' | 'pan' | 'pinch' | undefined,
  zoomGliding: boolean,
  now: number,
  until: number,
): boolean {
  return gestureKind === 'rotate' || gestureKind === 'pinch' || zoomGliding || now < until;
}
