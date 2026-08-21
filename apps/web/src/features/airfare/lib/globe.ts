import { geoDistance, geoPath, type GeoProjection } from 'd3-geo';

import { facesViewer, type LngLat } from '@/features/airfare/lib/geo';

/**
 * Splitting an arc into the part in front of the globe and the part behind it.
 *
 * An orthographic projection maps a point on the far side to its *correct*
 * screen position — the maths drops the depth, it does not mirror. So the far
 * half of an arc can simply be drawn where it falls, dimmed, and the globe
 * reads as translucent: Lima stays on screen when you spin the Pacific towards
 * you, instead of vanishing at the horizon.
 *
 * The alternative was pinning a label to the limb, which says "over there"
 * without showing anything. This shows it.
 */

export type ArcRun = {
  /** `true` when this stretch is on the hemisphere facing the viewer. */
  near: boolean;
  points: LngLat[];
};

/**
 * The arc's samples cut into alternating near and far stretches.
 *
 * Consecutive runs share their boundary point, so the two drawn paths meet at
 * the limb instead of leaving a gap there — a one-pixel hole exactly on the
 * horizon is the kind of thing that reads as a rendering bug.
 */
export function splitByHorizon(points: LngLat[], rotation: [number, number, number]): ArcRun[] {
  if (points.length === 0) return [];

  const runs: ArcRun[] = [];
  let current: ArcRun = { near: facesViewer(points[0], rotation), points: [points[0]] };

  for (const point of points.slice(1)) {
    const near = facesViewer(point, rotation);
    if (near === current.near) {
      current.points.push(point);
      continue;
    }
    // Close the run *through* this point, then start the next one from it.
    current.points.push(point);
    runs.push(current);
    current = { near, points: [point] };
  }
  runs.push(current);
  return runs.filter((run) => run.points.length > 1);
}

/**
 * Where the continents are, for labelling a globe that has no place names.
 *
 * mapcn gets these from its basemap's symbol layers. With a blank style — which
 * this repository requires, since the browser may not fetch tiles — that
 * basemap is gone and so are its labels, for mapcn as much as for us. Seven
 * hand-placed points is the whole of what was lost, and it weighs nothing.
 *
 * Positions are eyeballed centroids of the landmass rather than true
 * geographic centres: a label reads better over the middle of what a person
 * sees than over the average of a coastline that includes the Aleutians.
 */
export const CONTINENTS: { name: string; at: LngLat }[] = [
  { name: 'North America', at: [-100, 45] },
  { name: 'South America', at: [-60, -15] },
  { name: 'Europe', at: [16, 51] },
  { name: 'Africa', at: [20, 4] },
  { name: 'Asia', at: [90, 45] },
  { name: 'Oceania', at: [140, -25] },
  { name: 'Antarctica', at: [10, -78] },
];

/**
 * How far the flat map may be dragged, which is never past its own edges.
 *
 * The rule is one rule on both axes: you may pull the map about, but not so
 * far that empty space appears beside it. At the default zoom that reads as
 * *vertical only*, because the projection is fitted to the width of the frame
 * and there is nothing to reach sideways — the clamp works that out from the
 * map's measured width rather than being told. Zoom in and the map is wider
 * than the frame, so sideways becomes reachable on the same terms.
 *
 * When an axis is shorter than the frame there is nothing to scroll, so the
 * map sits centred on it rather than floating wherever it was let go.
 */
export function clampPan(
  mercator: GeoProjection,
  frame: { width: number; height: number },
  offset: { x: number; y: number },
): { x: number; y: number } {
  const [[left, top], [right, bottom]] = geoPath(mercator).bounds({ type: 'Sphere' });
  return {
    x: clampAxis(left, right, frame.width, offset.x),
    y: clampAxis(top, bottom, frame.height, offset.y),
  };
}

/** `near` and `far` already include the current offset, so corrections are relative to it. */
function clampAxis(near: number, far: number, frame: number, offset: number): number {
  if (far - near <= frame) return offset - (near + far) / 2 + frame / 2;
  if (near > 0) return offset - near;
  if (far < frame) return offset + (frame - far);
  return offset;
}

/* ------------------------------------------------------------------ names -- */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Radians of approach to the limb over which a name fades out. About 16°. */
const LIMB_BAND = 0.28;

/**
 * How solidly a name on the globe is facing the viewer, from 1 to 0.
 *
 * `facesViewer` answers the same question with a yes or a no, which is right
 * for deciding whether to draw an arc at all and wrong for a label: at exactly
 * 90° the name blinks out mid-rotation. Fading it over the last few degrees
 * before the limb is what makes a turning globe read as turning rather than as
 * a list of names being switched on and off.
 */
export function limbFade(point: LngLat, rotation: [number, number, number]): number {
  const away = geoDistance(point, [-rotation[0], -rotation[1]]);
  return clamp01((Math.PI / 2 - away) / LIMB_BAND);
}

export type View = {
  globe: boolean;
  /** The projection's own scale: globe radius, or Mercator's. */
  scale: number;
  rotation: [number, number, number];
};

/**
 * Roughly how many square pixels a region of `area` steradians covers now.
 *
 * Both estimates are the projection's local area scale factor, which is
 * `r²·cos θ` away from the centre of an orthographic and `s²·sec²φ` at
 * latitude φ on a Mercator. Measured against `geoPath.area` on real countries
 * they land within 5%, and they cost one cosine instead of streaming a
 * polygon — which matters, because this runs per label per frame.
 */
export function screenArea(area: number, at: LngLat, view: View): number {
  if (view.globe) {
    const away = geoDistance(at, [-view.rotation[0], -view.rotation[1]]);
    return area * view.scale ** 2 * Math.max(0, Math.cos(away));
  }
  const stretch = 1 / Math.cos((at[1] * Math.PI) / 180);
  return area * view.scale ** 2 * stretch ** 2;
}

/** The room a country name wants under it before it is worth drawing, in px². */
export const LABEL_ROOM = 2400;

/**
 * How far past the point of deserving a label a country is, from 0 to 1.
 *
 * Full strength at twice the room it needs. A zoom step is 1.5× linear and so
 * 2.25× in area, which means a name fades in over a little less than one press
 * of the button rather than appearing all at once.
 */
export function roomFade(area: number, needed: number = LABEL_ROOM): number {
  return clamp01(area / needed - 1);
}

/**
 * How much bigger than a name the ground under it has to be.
 *
 * Read off `LABEL_ROOM` rather than chosen: 2400 px² is 2.64 times the box of
 * the mean country name — 8.09 characters at 10px and 0.08em, so 53.4 by 17 —
 * and 3.06 times the median's seven. So the country rung already embodies a
 * ratio of about 2.7, and this is that ratio said out loud rather than a new
 * number. `LABEL_ROOM` itself is untouched; countries still use it.
 */
export const NAME_ROOM_MARGIN = 2.7;

/**
 * The ground a name of this size needs under it, in px².
 *
 * The subdivision rung's own room rule, and the one thing about it that is not
 * the country rung's. A constant asks the same of every name, which is fair
 * when the names are all about the same size and a lie when they are not:
 * Peru's departments run from `Ica` to `Madre de Dios` and Chile's regions
 * reach `Aisén del General Carlos Ibáñez del Campo`, four times the width of
 * `Antofagasta` on the same rule. Measured at the zoom cap, that name is 229px
 * wide on ground 77px across — three times the region it names, printed at
 * full strength straight over its neighbours, because a flat threshold cannot
 * see how long a word is.
 *
 * The estimate is area against area: a name deserves its ground once the
 * ground is `NAME_ROOM_MARGIN` times the name's own box. It cannot see which
 * way a region is turned — a long thin department lying across the map reads
 * as more room than it can really offer — so it is a floor on what fits, not a
 * proof of it, and `withoutOverlaps` is still what stops two names that both
 * passed from printing over each other.
 */
export function roomForName(width: number, height: number): number {
  return width * height * NAME_ROOM_MARGIN;
}

/**
 * Continents giving way to countries as the view closes in.
 *
 * Both at once is clutter, and they answer different questions: the continent
 * names orient you on a whole globe, the country names only mean anything once
 * you can see a border. They cross over at about 2.2×, each half-lit, so the
 * handover reads as one thing becoming another rather than as a switch.
 *
 * The zoom gate is why `roomFade` alone is not enough. Russia and Brazil have
 * room for their names at the very first frame, and printing them next to
 * SOUTH AMERICA is exactly the clutter this is meant to avoid.
 */
export function continentFade(zoom: number): number {
  return clamp01((3 - zoom) / 1.2);
}

export function countryFade(zoom: number): number {
  return clamp01((zoom - 1.6) / 1.2);
}

/**
 * The zoom at which a country's subdivisions are worth asking the API for.
 *
 * One ramp early, so the geometry is in hand by the time it is worth drawing
 * and the borders do not arrive a beat after the name has gone. Below this
 * nothing is requested at all — a reader who spins the home view and never
 * closes in sends no request, which is the first and cheapest of the three
 * things damping the fetch.
 */
export const SUBDIVISION_REACH = 4 - 1.2 / 2;

/**
 * Countries giving way to their own subdivisions, one rung further in.
 *
 * The same handover 12.28 built and the same shape: a 1.2-wide ramp, the two
 * layers crossing half-lit, and the fade coming from the geometry rather than
 * from a stylesheet. A country whose subdivisions are on screen has its own
 * name multiplied by `1 - subdivisionFade`, so the name does not so much
 * disappear as become the borders inside it.
 *
 * **Where the crossover sits, and why 4.6.** A country should never lose its
 * name before that name has been at full strength, and the room test decides
 * when that is: `roomFade` saturates at twice `LABEL_ROOM`, which on the
 * stage's 460px minimum of the day landed at 2.0x for Peru, 2.7x for Chile,
 * 3.2x for Spain and 3.7x for Japan — the binding case among the countries
 * this reader's routes touch. So the fall starts at 4.0, clear of Japan, and
 * with 12.28's ramp the crossover is at 4.6. Earlier and Japan's name would
 * begin fading before it had ever been fully lit; much later and there is not
 * enough of the 8x ceiling left for the layer to be worth arriving.
 *
 * **The minimum is 640 now (`a-taller-row-is-four-more-routes`) and 4.0 has
 * more room than it did, not less.** `LABEL_ROOM` is an absolute area in
 * pixels rather than a fraction of the frame, and `screenArea` goes as the
 * square of the scale, so a taller stage buys a country its full name earlier:
 * every zoom above falls by 460/640, to 1.44x for Peru, 1.94x for Chile,
 * 2.30x for Spain and 2.66x for Japan. The binding case has moved a full
 * 1.34x further from the gate. Nothing here has to move, which is the only
 * reason it did not.
 *
 * Only the country the reader has actually zoomed into is affected, because it
 * is the only one whose subdivisions are ever fetched. Every other name on
 * screen keeps burning at whatever `countryFade` gives it — which is also what
 * makes the fallback silent: a country Natural Earth does not divide is
 * indistinguishable from one nobody has zoomed into.
 */
export function subdivisionFade(zoom: number): number {
  return clamp01((zoom - 4) / 1.2);
}

/* ------------------------------------------------------------------- zoom -- */

/**
 * How long the scale takes to catch up with where a gesture asked it to go.
 *
 * A time constant, not a duration: after `ZOOM_TAU` milliseconds roughly 63%
 * of the remaining distance is gone, so a notch settles in about a fifth of a
 * second and a stream of notches never queues up behind itself.
 */
export const ZOOM_TAU = 70;

/**
 * One frame of the scale easing towards its target.
 *
 * Applying a wheel notch in full, the instant it arrives, is what makes zoom
 * feel mechanical however carefully the factor is chosen — a mouse notch is a
 * 22% change and 22% in one frame is a step. A tile renderer does not do that:
 * it sets a target and animates towards it, and so does this.
 *
 * Framed in elapsed time rather than per frame, so the speed is the same on a
 * 60 Hz panel and a 144 Hz one. It snaps at the end because an exponential
 * approach never actually arrives, and a scale that is forever a thousandth
 * away keeps the render loop awake for nothing.
 */
export function approach(current: number, target: number, elapsed: number, tau = ZOOM_TAU): number {
  if (elapsed <= 0 || current === target) return target === current ? target : current;
  const next = current + (target - current) * (1 - Math.exp(-elapsed / tau));
  return Math.abs(target - next) < target * 0.0005 ? target : next;
}

/**
 * The three rungs of the name ladder, each smaller and less tracked out than
 * the one above it — which is also how a reader tells them apart when two of
 * them are half-lit at a handover.
 *
 * These numbers are the stylesheet's, and the stylesheet says so beside each
 * of them. They live here rather than in the component because the room test,
 * the overlap test and the edge test all measure a name's box, and a box that
 * three rules disagree about is three rules that disagree.
 */
export const NAME_TIERS = {
  continent: { key: 'c', font: 11, spacing: 1.98 },
  country: { key: 'n', font: 10, spacing: 0.8 },
  // 8px, and the smallest thing on the map. A name's box is its width times
  // its height and both fall with the face, so a point down from the country
  // rung is 11% narrower and 11% shorter and asks 21% less ground — which at
  // this zoom is the difference between a department carrying its name and
  // carrying nothing.
  subdivision: { key: 's', font: 8, spacing: 0.32 },
} as const;

export type NameTier = keyof typeof NAME_TIERS;

/**
 * How much screen a name takes, before anything decides whether to draw it.
 *
 * Asked three times of every name: once to find out whether the ground under
 * it can hold it, once to keep it clear of the edge of the panel, and once to
 * claim its ground against every other name. Letter-spacing is part of the
 * width all three times, and the continent names are tracked out a long way.
 */
export function nameBox(name: string, tier: NameTier): { width: number; height: number } {
  const { font, spacing } = NAME_TIERS[tier];
  return { width: name.length * (font * 0.58 + spacing), height: font * 1.7 };
}

export type Boxed = { x: number; y: number; width: number; height: number };

/**
 * A name pulled far enough in from the edge of the map to be readable whole.
 *
 * The names are centred on the point they belong to, and the map's stage
 * clips: a country whose centroid lands 20px from the right-hand edge had the
 * right half of its name cut off by the panel. Measured at 10x with Peru's
 * departments showing, Bolivia rendered as `Bolivi` — a word that is not a
 * place, in a font small enough that a reader has no way to tell it from one.
 *
 * The subdivision rung looked immune and was not. It was only ever offered the
 * units of the one country under the middle of the frame, which is the one
 * place on the map where nothing is near an edge; fanning the layer out to
 * every country in view puts provincial names against the same edge, so this
 * is a fix the rest of this change would otherwise have needed anyway.
 *
 * **Moved, not dropped**, which is standard cartographic practice and the same
 * answer `withoutOverlaps` already gives a name blocked by an airport code: a
 * label steps aside rather than vanishing. The step is bounded by construction
 * — a name can never move further than half its own width, because that is all
 * the distance there is between "centred on the edge" and "flush inside it" —
 * so it stays over the country it names.
 *
 * `null` when the point itself is off the frame, because then it is not a name
 * that needs moving, it is a place that is not on screen. That is the cull the
 * map did before, said in one place instead of two, and it is what stops a
 * country three frames to the west from parking its name against the edge.
 */
export function nudgeIntoFrame(
  at: readonly [number, number],
  box: { width: number; height: number },
  frame: { width: number; height: number },
): [number, number] | null {
  if (at[0] < 0 || at[0] > frame.width || at[1] < 0 || at[1] > frame.height) return null;
  const along = (value: number, size: number, span: number) =>
    // A name wider than the frame has nowhere to be flush, so it is centred:
    // an equal amount lost at each end reads as a long name on a narrow map,
    // where all of it lost at one end reads as a different word.
    span < size ? span / 2 : Math.min(Math.max(value, size / 2), span - size / 2);
  return [along(at[0], box.width, frame.width), along(at[1], box.height, frame.height)];
}

/**
 * Names that are not sitting on top of each other, in the order they were
 * offered — which is biggest first, so the bigger place keeps the ground.
 *
 * This is the one job a vector basemap's symbol layer does that geometry alone
 * will not: without it, half a dozen European countries pile their names into
 * the same square inch the moment the globe turns that way.
 *
 * `claimed` is ground that is already taken and cannot be won: the airport
 * codes. They are the data this map exists for, so a decorative place name
 * gives way to them rather than printing itself across LIM.
 */
export function withoutOverlaps<T extends Boxed>(
  labels: T[],
  claimed: Boxed[] = [],
  nudges: number[] = NUDGES,
): T[] {
  const kept: T[] = [];
  const taken: Boxed[] = [...claimed];
  for (const label of labels) {
    for (const nudge of nudges) {
      const moved = nudge === 0 ? label : { ...label, y: label.y + nudge };
      if (!taken.every((other) => apart(moved, other))) continue;
      kept.push(moved);
      taken.push(moved);
      break;
    }
  }
  return kept;
}

/**
 * Where a blocked name is allowed to go instead, in order of preference.
 *
 * Dropping it outright is the wrong answer when the thing blocking it is an
 * airport code: LIM sits almost exactly on the middle of South America, so the
 * continent this reader is looking at would be the one continent with no name
 * on it. Standard cartographic practice is that the label steps aside, and a
 * step of one or two line heights is enough.
 */
const NUDGES = [0, -17, 17, -34, 34];

function apart(one: Boxed, other: Boxed): boolean {
  return (
    Math.abs(one.x - other.x) * 2 >= one.width + other.width ||
    Math.abs(one.y - other.y) * 2 >= one.height + other.height
  );
}
