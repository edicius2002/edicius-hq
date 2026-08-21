import { geoContains } from 'd3-geo';

/**
 * Whether a point is inside a country, cheaply enough to ask ten thousand times.
 *
 * **`geoContains` was the whole cost of the settle sweep, and it was not
 * close.** `countriesInView` inverts a grid over the frame and asks which
 * country each sample landed in. On a 1550x460 stage — the widest this layout
 * produced then, at a 2560-pixel viewport; it is 1630x640 since
 * `a-taller-row-is-four-more-routes`, 47% more samples — the sweep at the 32x
 * ceiling cost 50.8
 * ms, of which inverting its 2,457 samples was under a millisecond. Asked
 * directly: 8,804 bare `geoContains` calls against Chile are 122 ms. The grid
 * was never the expensive part.
 *
 * The reason is what `geoContains` has to be: a spherical test. It walks every
 * vertex of the shape through `cartesian`, `atan2` and a running winding angle,
 * because a polygon on a sphere has no outside until you say which side the
 * poles are on. That is the right test for a general geometry, and this module
 * is 177 particular ones.
 *
 * **So the rings are flattened once, at import, into a pair of typed arrays and
 * an even-odd ray cast is run over them in the longitude/latitude plane.** The
 * same 8,804 samples against Chile: 122 ms spherically, 92 ms against the
 * mainland polygon alone, 11 ms as a plain planar ray cast over the same ring,
 * and 1.9 ms once the ring is a `Float64Array` instead of an array of arrays.
 * Sixty times, and almost half of it is the typed arrays rather than the
 * geometry.
 *
 * **What a planar test gets wrong, and what is done about each.**
 *
 * *An edge is a great circle, not a straight line in longitude and latitude.*
 * The two bow apart in the middle, by `(Δλ)²·sin(2φ)/8` to first order — worst
 * in this atlas 0.2799° across one of Canada's 9° Arctic edges. So every edge
 * longer than `STRAIGHT_ENOUGH` is cut into pieces along its own great circle
 * at import, which brings the bow under 0.004°. Swept over a 0.5° grid of the
 * whole world without that cut, the shapes the ordinary sheet holds disagreed
 * with `geoContains` 44 times; with it, the whole atlas disagrees 11.
 *
 * *A polygon can wrap the world.* Longitude is a seam and a plane has none, so
 * a shape crossing ±180° is nonsense flattened, and Fiji, Russia and Antarctica
 * each have one that does. Between them they were 14,903 of the 14,947
 * disagreements before any of this was tuned. Fiji and Russia are answered by
 * moving the seam rather than by approximating them — see `SHIFTED`. Antarctica
 * is not, because it goes round the pole instead of past the date line, and its
 * one 360°-wide ring keeps `geoContains` exactly as before.
 *
 * **What is left is narrower than the atlas's own error.** Over a 0.5° sweep of
 * the whole world — 45,619,200 answers — 11 differ. Over a 0.05° sweep of the
 * five countries this watchlist flies between — 6,635,705 answers — 64 differ,
 * and the furthest is 353 m from an outline. The 1:110m shapes are
 * themselves a median of 1.5 to 5.2 km from the 1:10m ones the map draws over
 * them, so the band where the two tests can disagree is a tenth of the distance
 * between the shape being asked about and the shape the reader is looking at.
 *
 * The whole index is built once at import: 285 polygons, 10,587 vertices
 * becoming 12,159, 191 kB of `Float64Array`, and 9.9 ms — a fifth of one of the
 * sweeps it replaces, paid once.
 */

type Ring = [number, number][];
type Geometry =
  { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] };
type Shape = { type: 'Feature'; geometry: Geometry };

/**
 * The widest a polygon may be in longitude before the plane stops describing it.
 *
 * The same number and the same reason as `HALF_THE_WORLD` in `visible.ts`: past
 * half the world you cannot tell which way round a shape goes without knowing
 * where the poles are, which is exactly what a planar ray cast does not know.
 */
const HALF_THE_WORLD = 180;

/**
 * Where the plane is cut, chosen per polygon rather than fixed at ±180°.
 *
 * **A shape that wraps the date line does not wrap Greenwich.** Russia's
 * mainland runs from 19°E to 169°W, so on the usual sheet it is 360° wide and
 * unusable; measured from 0° to 360° it is 19° to 191°, and 172° wide. Fiji is
 * 177° to 181°. Both are perfectly ordinary polygons that were being asked
 * about on the one sheet where they are not.
 *
 * This matters far from the date line, which is why it is worth the branch.
 * Russia's box reaches every longitude and 41°N to 82°N, so it is a candidate
 * for every sample over Europe that no other country claims — and a spherical
 * fallback there is 610 vertices of `geoContains` per sample. Measured on a
 * 1550x460 stage at step 12, over central Europe at 3.4x, where 96 countries
 * are in frame: 36.8 ms with Russia left spherical, 4.0 ms with it flattened
 * on the shifted sheet. The first version of this module fell back for the
 * whole shape and that view was the one that found it.
 *
 * Antarctica is the one shape no sheet can hold — it is 360° wide on both,
 * because it goes round the pole rather than past the seam — and it keeps
 * `geoContains`. Its box is 90°S to 60°S, so it is a candidate nowhere the
 * reader is likely to be and costs nothing where they are.
 */
const SHIFTED = 360;

/**
 * The longest edge left as a straight line in longitude and latitude.
 *
 * One degree. The chord of a great circle departs from it by `(Δλ)²·sin(2φ)/8`,
 * so cutting this atlas's worst edge — 9.06°, across northern Canada, bowing
 * 0.2799° — into 1° pieces leaves under 0.004°, which is 400 m. It is close to
 * free because the atlas is already mostly finer than this: 10,587 vertices
 * become 12,159, so 1,572 points are added in the whole world.
 */
const STRAIGHT_ENOUGH = 1;

/** One polygon: every ring flattened end to end, with a box around the lot. */
type Piece = {
  xs: Float64Array;
  ys: Float64Array;
  /** Where each ring ends in `xs`/`ys`, so the closing edge stays inside it. */
  ends: Int32Array;
  /** `SHIFTED` if this piece lives on the 0°-to-360° sheet, otherwise 0. */
  shift: number;
  west: number;
  east: number;
  south: number;
  north: number;
};

/**
 * A shape prepared for asking: the polygons a plane can hold, and any it cannot.
 *
 * Both by polygon rather than by country, because the two are mixed in
 * practice: Antarctica's coast is one 360°-wide ring and seven ordinary
 * islands, and only the ring needs the expensive answer.
 */
export type Solid = {
  pieces: Piece[];
  spherical: { type: 'Polygon'; coordinates: Ring[] }[];
};

/**
 * A point on the great circle between two others, at fraction `t`.
 *
 * Cartesian interpolation and a normalise rather than the spherical formula
 * with its two sines and a division: for the sub-10° edges this is used on the
 * two paths are the same circle to within a rounding, and the parametrisation
 * along it does not matter when the only thing wanted is a point that lies on
 * the arc.
 */
function along(
  fromLongitude: number,
  fromLatitude: number,
  toLongitude: number,
  toLatitude: number,
  t: number,
): [number, number] {
  const rad = Math.PI / 180;
  const [x1, y1, z1] = [
    Math.cos(fromLatitude * rad) * Math.cos(fromLongitude * rad),
    Math.cos(fromLatitude * rad) * Math.sin(fromLongitude * rad),
    Math.sin(fromLatitude * rad),
  ];
  const [x2, y2, z2] = [
    Math.cos(toLatitude * rad) * Math.cos(toLongitude * rad),
    Math.cos(toLatitude * rad) * Math.sin(toLongitude * rad),
    Math.sin(toLatitude * rad),
  ];
  const x = x1 + (x2 - x1) * t;
  const y = y1 + (y2 - y1) * t;
  const z = z1 + (z2 - z1) * t;
  const length = Math.hypot(x, y, z);
  return [Math.atan2(y / length, x / length) / rad, Math.asin(z / length) / rad];
}

function flatten(rings: Ring[], shift: number): Piece {
  const xs: number[] = [];
  const ys: number[] = [];
  const ends: number[] = [];
  const sheet = (at: number) => (shift && at < 0 ? at + shift : at);
  for (const ring of rings) {
    for (let at = 0; at < ring.length; at += 1) {
      const longitude = sheet(ring[at][0]);
      const latitude = ring[at][1];
      xs.push(longitude);
      ys.push(latitude);
      const next = ring[at + 1];
      if (!next) continue;
      const to = sheet(next[0]);
      // Cut on longitude alone: the bow is `(Δλ)²·sin(2φ)/8`, so an edge with
      // no run in longitude is a meridian, which is already a straight line in
      // this plane however long it is.
      const pieces = Math.ceil(Math.abs(to - longitude) / STRAIGHT_ENOUGH);
      for (let piece = 1; piece < pieces; piece += 1) {
        const [atLongitude, atLatitude] = along(longitude, latitude, to, next[1], piece / pieces);
        // `along` answers on the ordinary sheet, so a point past the date line
        // comes back negative and has to be put back where this piece lives.
        xs.push(sheet(atLongitude));
        ys.push(atLatitude);
      }
    }
    ends.push(xs.length);
  }
  /*
   * The box comes off the flattened points, not off the ones the atlas
   * supplied — and that distinction was a bug before it was a comment.
   *
   * A great circle bows outside the chord between its ends, so a densified
   * edge puts points beyond every vertex it was built from. Taking the box
   * from the originals made it a hair too small in exactly the direction the
   * bow goes, and the box is a rejection: a point in the sliver between the
   * chord and the arc was thrown out before the ray cast could say it was
   * inside. On this atlas the sliver is 0.004° and it went unnoticed through
   * 45.1 million samples; on a 20° edge it is 0.375°, and the test built out
   * of one caught it at once.
   */
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let at = 0; at < xs.length; at += 1) {
    if (xs[at] < west) west = xs[at];
    if (xs[at] > east) east = xs[at];
    if (ys[at] < south) south = ys[at];
    if (ys[at] > north) north = ys[at];
  }
  return {
    xs: Float64Array.from(xs),
    ys: Float64Array.from(ys),
    ends: Int32Array.from(ends),
    shift,
    west,
    east,
    south,
    north,
  };
}

/** How wide a ring is in longitude, on the ordinary sheet and on the shifted one. */
function spans(ring: Ring): { plain: number; shifted: number } {
  let west = Infinity;
  let east = -Infinity;
  let shiftedWest = Infinity;
  let shiftedEast = -Infinity;
  for (const [longitude] of ring) {
    if (longitude < west) west = longitude;
    if (longitude > east) east = longitude;
    const moved = longitude < 0 ? longitude + SHIFTED : longitude;
    if (moved < shiftedWest) shiftedWest = moved;
    if (moved > shiftedEast) shiftedEast = moved;
  }
  return { plain: east - west, shifted: shiftedEast - shiftedWest };
}

/**
 * Prepare a shape, one polygon at a time and on whichever sheet suits it.
 *
 * The choice is made on the outer ring alone, which is enough: a hole is inside
 * its outer ring, so a ring that fits on a sheet takes its holes with it.
 */
export function solidOf(shape: Shape): Solid {
  const polygons =
    shape.geometry.type === 'Polygon' ? [shape.geometry.coordinates] : shape.geometry.coordinates;
  const solid: Solid = { pieces: [], spherical: [] };
  for (const rings of polygons) {
    const width = spans(rings[0]);
    if (width.plain < HALF_THE_WORLD) solid.pieces.push(flatten(rings, 0));
    else if (width.shifted < HALF_THE_WORLD) solid.pieces.push(flatten(rings, SHIFTED));
    else solid.spherical.push({ type: 'Polygon', coordinates: rings });
  }
  return solid;
}

/**
 * Whether the point is inside, by an even-odd crossing count over every ring.
 *
 * One count across the outer ring and its holes together, rather than "inside
 * the outer and outside each hole": a hole adds an odd crossing to any ray from
 * a point within it, so the parity says the same thing in one pass and without
 * knowing which ring is which — which the atlas does not state anyway.
 */
export function solidHolds(solid: Solid, longitude: number, latitude: number): boolean {
  for (const piece of solid.pieces) {
    const across = piece.shift && longitude < 0 ? longitude + piece.shift : longitude;
    if (
      across < piece.west ||
      across > piece.east ||
      latitude < piece.south ||
      latitude > piece.north
    )
      continue;
    const { xs, ys, ends } = piece;
    let inside = false;
    let from = 0;
    for (let ring = 0; ring < ends.length; ring += 1) {
      const to = ends[ring];
      for (let at = from, before = to - 1; at < to; before = at, at += 1) {
        const here = ys[at];
        const there = ys[before];
        if (here > latitude !== there > latitude) {
          const edge = xs[at];
          if (across < ((xs[before] - edge) * (latitude - here)) / (there - here) + edge)
            inside = !inside;
        }
      }
      from = to;
    }
    if (inside) return true;
  }
  for (const polygon of solid.spherical)
    if (geoContains(polygon, [longitude, latitude])) return true;
  return false;
}
