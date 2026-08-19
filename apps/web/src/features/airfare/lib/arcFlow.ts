/**
 * Making a route's dashes flow from its origin to its destination.
 *
 * The animation itself is three lines of CSS on the arc — `stroke-dashoffset`
 * keyframes, which the browser drives from its own animation timeline without
 * running a line of script or waking React. What CSS cannot work out on its
 * own is *phase*: on the globe an arc is cut at the limb and only the near
 * stretches are drawn (decision 12.41), so one route arrives as several
 * `<path>` elements. Give each of them the same keyframes and each starts its
 * dash pattern at zero, so the pattern restarts at every cut and the route
 * reads as several unrelated lines rather than one.
 *
 * The fix is a per-run **delay**. The animation is linear and periodic, so
 * shifting it in time is the same as shifting the pattern in distance: a run
 * that begins `before` units along the whole arc is one that should already be
 * `before` units into the pattern. Everything here is that arithmetic, kept
 * pure so it can be checked without a browser — the same reason `lib/geo`
 * holds the great circle and `RouteMap` only draws it.
 */

/**
 * The dash pattern's period, in SVG user units.
 *
 * The stylesheet says 10 as well — `5 5` for an arc and `7 3` for the open one
 * — and the keyframes run one whole period per cycle. The two have to agree or
 * the joins drift: a phase computed against 10 laid over a pattern that
 * repeats every 11 slips a unit per cycle, which reads as the flow crawling
 * backwards. Held by these two comments and not by a test: a test would have
 * to read the stylesheet, and `src` is typed as browser code — reaching for
 * `node:fs` builds under Vitest and then fails the app's own `tsc -b`, while
 * `?raw` on a `.css` file is intercepted and handed back as a class-name map.
 */
export const ARC_DASH_PERIOD = 10;

/**
 * How long the pattern takes to travel one whole period, in seconds.
 *
 * Derived from the prototype rather than guessed at, and not by copying its
 * number. It advanced the offset 0.55 units a frame over a `14 10` pattern —
 * 33 units a second at 60 Hz, so one of its dashes covered its own length in
 * 0.424s. This map's dashes are `5 5`, a third the size, and 33 units a second
 * under a dash that small is a shimmer rather than a direction. Holding the
 * *dash's* travel constant instead gives 11.8 units a second, which is one
 * 10-unit period every 0.85s and 0.425s per dash length.
 */
export const ARC_FLOW_SECONDS = 0.85;

/**
 * How long a projected arc run is on screen, in the units the dashes use.
 *
 * Summed segment by segment rather than read back with `getTotalLength`: the
 * projection turns a `LineString` into a polyline of straight segments — the
 * globe's unclipped projection has resampling off, so the points that go in
 * are exactly the vertices that come out — and this is that polyline's length
 * exactly. `getTotalLength` would be the same number by way of a layout read
 * on an element that does not exist yet.
 */
export function polylineLength(points: readonly (readonly [number, number])[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index][0] - points[index - 1][0],
      points[index][1] - points[index - 1][1],
    );
  }
  return total;
}

/**
 * The `animation-delay` that puts a run into the flow at the right phase.
 *
 * `before` is how far along the whole arc this run starts, hidden stretches
 * included — the pattern is laid along the entire great circle, so a run
 * coming back into view at the far limb has to pick up where the one that went
 * behind the globe left off.
 *
 * Always negative, and never further back than one cycle. A positive delay
 * would hold the animation at its first frame for up to a whole cycle before
 * starting, which on a map redrawn every frame of a drag is a stutter; a
 * negative one says "you are already this far in", which is what is meant.
 */
export function flowDelay(before: number): string {
  const phase = ((before % ARC_DASH_PERIOD) + ARC_DASH_PERIOD) % ARC_DASH_PERIOD;
  return `${((phase / ARC_DASH_PERIOD - 1) * ARC_FLOW_SECONDS).toFixed(4)}s`;
}
