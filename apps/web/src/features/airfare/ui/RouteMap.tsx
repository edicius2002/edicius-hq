import { geoCircle, geoMercator, geoOrthographic, geoPath, type GeoProjection } from 'd3-geo';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { feature, mesh } from 'topojson-client';
import versor from 'versor';
import worldAtlas from 'world-atlas/countries-110m.json';

import { flowDelay, polylineLength } from '@/features/airfare/lib/arcFlow';
import {
  antisolarPoint,
  greatCircle,
  nextWatch,
  type LngLat,
  type RouteGeometry,
} from '@/features/airfare/lib/geo';
import {
  COUNTRIES,
  countriesInView,
  countryAt,
  outlinesOf,
} from '@/features/airfare/lib/countries';
import { needsSettleWait, planFanOut } from '@/features/airfare/lib/fanOut';
import {
  type Boxed,
  CONTINENTS,
  NAME_TIERS,
  SUBDIVISION_REACH,
  type NameTier,
  type View,
  approach,
  clampPan,
  continentFade,
  countryFade,
  limbFade,
  nameBox,
  nudgeIntoFrame,
  roomFade,
  roomForName,
  screenArea,
  splitByHorizon,
  subdivisionFade,
  withoutOverlaps,
} from '@/features/airfare/lib/globe';
import {
  IDENTITY_MATRIX,
  anyStale,
  forcesDegrade,
  standInFor,
  strokesInnerBorders,
  decideReuse,
  geometryWeight,
  rotateThrottleMs,
  type CachedGeometry,
  type Matrix2D,
  type ProjectionSnapshot,
  type ReuseDecision,
} from '@/features/airfare/lib/reprojectionCache';
import type { Subdivisions } from '@/features/airfare/lib/subdivisions';
import { type Cap, capped, cappedRuns, capsMeet, viewCap } from '@/features/airfare/lib/visible';
import {
  useSettledSubdivisionCountries,
  useSubdivisionCatalogue,
  useSubdivisions,
} from '@/features/airfare/hooks/useSubdivisions';
import { Button } from '@/shared/ui/Button';

import styles from './RouteMap.module.css';

/**
 * Watched routes as arcs, on a globe or flat.
 *
 * **One arc per city pair, not per watch** — `a-pair-draws-one-arc`, and
 * `lib/geo` is where the grouping is done. What arrives here is already
 * collapsed, already pointed the right way and already carrying the watches it
 * stands for, so everything in this file is drawing.
 *
 * **No frame loop runs at rest.** `requestAnimationFrame` is started only
 * while a pointer is down, or while a country's subdivisions are fading in,
 * and stopped the moment neither is true — so an idle map costs no script at
 * all and a drag gets the whole frame budget. That is the half of decision
 * 12.23 that is kept. The arrival is the one addition and it is bounded by
 * construction rather than by a timer: `arrivalFade` is clamped at 1, so the
 * last country to land finishes `ARRIVAL_MS` after it lands and the loop
 * switches itself off on the frame they all have.
 *
 * The half that is not: the globe's dashes flow, from origin towards
 * destination, on the route the reader has open and on whichever route
 * collected most recently — every other arc stays dashed and still. It is a
 * declarative `stroke-dashoffset` animation
 * on the paths — the browser's own animation timeline drives it, no JavaScript
 * runs per frame and no component re-renders per frame, which is why it can be
 * added without taking the idle cost back. The phase that keeps one route's
 * several runs reading as one flow is in `lib/arcFlow`; the animation itself
 * is in the stylesheet, and it stops dead under `prefers-reduced-motion`.
 *
 * **The globe is glass.** An orthographic projection maps a point on the far
 * side to its *correct* screen position — the maths drops the depth, it does
 * not mirror — so the half of an arc that has gone round the back is drawn
 * where it actually falls, dimmed. Spin the Pacific towards you and Lima is
 * still there, faint, rather than having vanished at the horizon. The
 * alternative was pinning a marker to the limb, which says "over there"
 * without showing anything.
 *
 * Two surfaces:
 *
 * - **Canvas** for the sphere, the land and every country boundary.
 *   Reprojecting a world outline every frame is the expensive part, and a 2D
 *   context absorbs it where thousands of DOM nodes would not. There is no
 *   graticule: mapcn has none, and on a globe already carrying arcs and place
 *   names the grid was the busiest thing on screen and the only one carrying
 *   nothing.
 * - **SVG** for the arcs, the airports and the continent names, so each stays
 *   a node a test can query and a screen reader can read — decision 12.12.
 *
 * **The place names are ours.** mapcn gets them from its basemap's symbol
 * layers; with the blank style this repository requires, that basemap is gone
 * and its labels with it — for mapcn as much as for us. Continents are seven
 * hand-placed points. Countries are read off the outlines already bundled and
 * already drawn, so 177 names cost no bytes at all.
 *
 * They arrive and leave by fading, and the fade comes from the geometry rather
 * than from a stylesheet: opacity is recomputed every frame from how far a
 * name is from the limb and how much room there is under it at this zoom. A
 * CSS transition covers only the jumps geometry does not — a zoom button, a
 * change of projection.
 */

// 1:110m Natural Earth, bundled. 39 kB gzip, and it never touches the network.
// 1:50m is four times the coastline detail and 236 kB gzip — as heavy as a
// whole tile engine, which is not a trade this map needs to make.
const WORLD = feature(
  worldAtlas as never,
  (worldAtlas as never as { objects: { countries: never } }).objects.countries,
);
/*
 * Every boundary once, drawn as a mesh rather than as each country's own
 * outline. Two neighbours share a border, and stroking both polygons paints it
 * twice — at half opacity that reads as a heavier line between France and
 * Germany than along the Atlantic coast, which is backwards.
 */
const BOUNDARIES = mesh(
  worldAtlas as never,
  (worldAtlas as never as { objects: { countries: never } }).objects.countries,
);

/*
 * The same two layers, indexed by where they are.
 *
 * Built at import because they never move: 177 country outlines and about a
 * thousand runs of boundary, each with the cap that encloses it, so that a
 * frame can ask what could be on screen instead of projecting the planet to
 * find out. `lib/visible` carries the reasoning and the measurements; the short
 * form is that at the 32x ceiling the reader is looking at 2.9° of sphere, and
 * without this the other 357° are rotated, projected and resampled every frame
 * so that the canvas can discard them.
 */
const WORLD_PARTS = capped(
  (WORLD as unknown as { features: { type: 'Feature'; geometry: never }[] }).features,
);
const BOUNDARY_RUNS = cappedRuns(BOUNDARIES as never);

/**
 * How far in the map goes.
 *
 * 32x, not the 8x it was. The stage was at least 460px on its short side when
 * this was settled and the globe's radius is `0.42 x min(width, height) x
 * zoom`, so at 460 the short side spanned 1,896 km at 8x and 474 km at 32x,
 * and the ground under one pixel went from 4.12 km to 1.03 km. The short side
 * is 606 at the narrowest viewport and 640 above 1552px since
 * `a-taller-row-is-four-more-routes`, so the ground under one pixel at the
 * ceiling is 0.78 km and 0.74 km — 28% finer than the number this ceiling was
 * chosen against. It is still well inside what the served 1:10m outlines
 * carry, whose own vertices are hundreds of metres apart, so the ceiling holds
 * where it is; what it is not is untouched, and 32x is the rung to look at
 * first if the coastlines ever start to read as polygons.
 * Both layers were re-cut to meet it — 12.165 for
 * the served outlines, and 12.164 for what the bundled 1:110m base can no
 * longer be asked to do on its own.
 */
const ZOOM = { min: 1, max: 32 };

/**
 * One empty list, so "nothing is wanted" is always the same nothing.
 *
 * `useQueries` is handed this array on every frame of a spin. A fresh `[]`
 * each time would be a fresh set of query options each time, for a set that
 * has not changed.
 */
const NOTHING_WANTED: readonly string[] = [];

/**
 * How much one notch of wheel changes the scale.
 *
 * Exponential in the wheel delta rather than a fixed step per event, which is
 * what makes it feel continuous: a trackpad reports deltas of a few pixels and
 * a mouse notch reports about a hundred, so a fixed factor per *event* gives
 * the trackpad a crawl and the mouse a jump. The same constant d3-zoom uses.
 */
const WHEEL_RATE = 0.002;

/**
 * How much one press of a zoom control is worth.
 *
 * The one number the wheel and the pinch do not need, because both of those
 * are handed a size by the gesture itself. A key and a button are not, so they
 * are given a rung — and it is a *rung*, not a jump: what a press asks for
 * goes through the same eased glide a notch does, so 1.3 is where the scale
 * ends up rather than what the next frame shows. `log(32) / log(1.3)` is 13.2,
 * so fourteen presses cross the whole 1x–32x range — enough that the ceiling
 * is genuinely reachable by button, and few enough that it is not a chore.
 */
const ZOOM_STEP = 1.3;

/** For a route the watchlist has no colour for, which should not happen. */
const DEFAULT_ARC = 'var(--arc-neutral)';

/** Looking at Lima, which is where every route on this page starts. */
const HOME: [number, number, number] = [77, 6, 0];

/**
 * How long the map must sit still before it asks whose subdivisions to draw.
 *
 * The second of the three things damping this fetch. A reader spinning the
 * globe crosses a dozen countries a second, and asking after each of them
 * would be a dozen requests for geometry nobody looked at. The wheel already
 * holds `moving` true for 320ms past the last notch, so by the time this timer
 * starts the view has genuinely stopped; a quarter of a second past that is
 * about the gap between two deliberate gestures, so a reader reaching for a
 * second drag cancels the first one's question.
 */
const SETTLE_MS = 250;

/**
 * How long a country takes to arrive once its geometry is in hand.
 *
 * `SETTLE_MS`, and the same number on purpose: the map spends a quarter of a
 * second holding still before it asks whose subdivisions to draw, and it gives
 * the answer back over the same quarter of a second. A reader has already
 * accepted that pause as the map deciding, so making the arrival its mirror is
 * what turns a stack of separate events into one movement. It is also
 * comfortably longer than the 160ms the stylesheet uses for the jumps geometry
 * does not cover, which has less distance to travel: one opacity being
 * corrected, rather than a country's name at full strength going out while a
 * whole layer of borders comes in underneath it.
 */
const ARRIVAL_MS = SETTLE_MS;

export type Projection = 'globe' | 'mercator';

/** The three projections `fit` keeps up to date, shared by the canvas and the SVG. */
type Places = { globe: GeoProjection; glass: GeoProjection; mercator: GeoProjection };

/**
 * The three projections a frame is drawn through, made fresh per map.
 *
 * Not module-level constants, even though the arguments never vary: `fit`
 * writes each one's translate, scale and rotate on every frame, so two maps on
 * one page sharing these would each be turning the other's globe.
 */
function makePlaces(): Places {
  return {
    // Clipped, for the land: the near face has to be opaque or there is no
    // globe, only a tangle of outlines.
    globe: geoOrthographic().clipAngle(90).precision(0.5),
    // Unclipped, for everything drawn *through* the glass.
    //
    // `clipAngle(null)` is the whole trick, and it is easy to miss:
    // `geoOrthographic()` ships with `clipAngle(90)` already applied, so a
    // projection that merely *looks* unclipped still throws the far hemisphere
    // away. Projecting a lone point sidesteps the clip — it never enters a
    // stream — which is why the airport codes survived a rotation while the
    // arcs behind the globe silently vanished.
    //
    // `precision(0)` then turns off adaptive resampling, which has nothing to
    // do here: the great circle arrives already sampled into its own points.
    glass: geoOrthographic().clipAngle(null).precision(0),
    mercator: geoMercator().rotate([62, 0]).precision(0.5),
  };
}

/** One frame's worth of view, as `commit` publishes it. See `painted`. */
type Painted = {
  rotation: [number, number, number];
  zoom: number;
  zoomTarget: number;
  pan: { x: number; y: number };
  size: { width: number; height: number };
  places: Places;
  /**
   * How far into its arrival each redrawn country was on this frame.
   *
   * The fade itself rather than the instant to work it out from, so the name a
   * country is handing over and the borders the canvas painted underneath it
   * are two halves of one number instead of two readings of the clock a moment
   * apart. A country not in here has not landed, which is a fade of 0.
   */
  fades: ReadonlyMap<string, number>;
};

type RouteMapProps = {
  routes: RouteGeometry[];
  /** Distinct stop sequences for the selected month, already coordinate-resolved. */
  stopRoutes?: { id: string; points: LngLat[]; viaPoints: string[]; colour: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** A colour per route id, so one arc can be told from the next. */
  colours: Map<string, string>;
  /**
   * The watch whose collection finished most recently, or null.
   *
   * Its arc flows even when it is not the open one — `freshest-arc-flows-too`.
   * A route id rather than a pair, because the page knows which *watch* it
   * watched a pass end on; the arc matches it against its own watches.
   */
  lastCollectedId: string | null;
  projection: Projection;
  onProjectionChange: (projection: Projection) => void;
  /**
   * Something to stand in the toolbar, beside Reset.
   *
   * A slot rather than a prop that names what goes in it. What the page puts
   * here is the watchlist's save state, which is a fact about a stored document
   * and none of a map's business — a `saveState` prop would have this component
   * importing storage types to render a word it cannot interpret. The map owns
   * the strip and nothing else about what stands on it.
   *
   * Why the strip at all: the status used to sit in the page header, in a row
   * with the collect button, and when that button went the row was one control
   * wide and the header was a title with a word floating at the far end of it.
   * The toolbar already carries this panel's chrome.
   */
  status?: ReactNode;
};

function readToken(element: HTMLElement, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

export function RouteMap({
  routes,
  stopRoutes = [],
  selectedId,
  onSelect,
  colours,
  lastCollectedId,
  projection,
  onProjectionChange,
  status,
}: RouteMapProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rotation = useRef<[number, number, number]>([...HOME]);
  const pan = useRef({ x: 0, y: 0 });
  const size = useRef({ width: 0, height: 0 });
  /*
   * Zoom is a ref, not state.
   *
   * A wheel gesture fires dozens of events; as state each one was a React
   * render before anything could be drawn. Held in a ref, the wheel handler
   * only writes a number and the frame loop picks it up — the same path a drag
   * takes, and the reason the two now feel alike.
   */
  const zoom = useRef(1);
  /** Where a gesture has asked the scale to go; `zoom` eases towards it. */
  const zoomTarget = useRef(1);
  /**
   * The screen point a zoom is pinned to, and the place that must stay under
   * it.
   *
   * Captured once when the gesture starts and reapplied on every frame of the
   * easing, rather than recomputed per step: recomputing accumulates each
   * intermediate frame's error, and after a dozen of them the thing you were
   * pointing at has quietly walked away.
   */
  const anchor = useRef<{ at: [number, number]; geo: [number, number] } | null>(null);
  const [moving, setMoving] = useState(false);

  /**
   * Whether the view is anywhere but home, which is the only thing "Reset the
   * view" needs to know.
   *
   * State of its own, written wherever the view is *asked* to move, rather
   * than read off the frame that was last painted. The two agree through a
   * drag, where every frame is a render — but a wheel notch writes the new
   * target and then waits for the loop, and a button that stays greyed out
   * until the next frame is answering a question the reader did not ask. What
   * has moved the view is the request, and this is the request.
   */
  const [moved, setMoved] = useState(false);

  /**
   * Recomputed wherever rotation, pan or the zoom target is written, which is
   * every place the view can move from.
   *
   * A `setState` per pointer move looks like the thing the note on `zoom`
   * warns against and is not: this one is a boolean that spends a whole
   * gesture unchanged, and React drops an update that would set the same
   * value, so a drag costs exactly one render here — the one where the answer
   * turns over.
   */
  const noteMoved = useCallback(() => {
    // Rotation counts as having moved the view. Without it, spinning the globe
    // halfway round the planet left "Reset the view" greyed out.
    const turned = rotation.current.some((angle, axis) => Math.abs(angle - HOME[axis]) > 0.5);
    setMoved(
      Math.abs(zoomTarget.current - 1) > 0.001 ||
        turned ||
        Math.abs(pan.current.x) > 0.5 ||
        Math.abs(pan.current.y) > 0.5,
    );
  }, []);

  /*
   * Which countries the camera has in front of it, and their subdivisions once
   * they arrive.
   *
   * Empty means nobody has zoomed into anything, and nothing is requested. A
   * country that has no subdivisions to give simply never appears in what
   * arrives — see `shared/api/geography`, where the 404 is swallowed, and
   * `planFanOut`, which by then knows from the catalogue not to ask — so a
   * reader never finds out which of the two happened, which is the point.
   */
  const [wanted, setWanted] = useState<readonly string[]>(NOTHING_WANTED);
  /**
   * Whether the reader has ever been close enough for any of this to matter.
   *
   * The catalogue is behind the same zoom gate as the geometry, but not behind
   * the settle gate: it is 2.5 kB, it is asked for once a session, and having
   * it before the first settle rather than after is the difference between the
   * first view the reader stops on fanning out and the second one.
   */
  const [reached, setReached] = useState(false);
  /** Whether the index has ever been in hand, so its arrival is told from a redraw. */
  const indexed = useRef(false);
  const { data: catalogue } = useSubdivisionCatalogue(reached);
  const subdivisions = useSubdivisions(wanted);
  const settled = useSettledSubdivisionCountries(wanted);

  /**
   * Which countries are actually being redrawn, which is not the same as which
   * ones were asked for.
   *
   * A country Natural Earth does not divide, or one still in flight, keeps
   * every bit of its coarse self — its borders in the mesh and its outline in
   * the fill. Keying off what came back rather than off what was wanted is
   * what makes the fallback silent here too, and it is what lets a fan-out
   * land one country at a time without ever showing a shape that is neither
   * named nor detailed.
   */
  const fine = subdivisions.filter((each) => each.land);
  const swapped = fine.map((each) => each.country).join(',');

  /**
   * Which countries are drawn in detail right now, for the next plan to keep.
   *
   * A ref rather than a dependency of the settle effect, because that effect
   * already re-runs on `tick` and a second changing input would only make it
   * re-run for the same reason twice.
   */
  const drawn = useRef<readonly string[]>([]);

  /**
   * Every country this map has ever had an answer for, drawable or not, kept
   * for the life of the component rather than only while it is in `wanted`.
   *
   * Built from `settled` rather than from `subdivisions`: a country with
   * nothing to draw is still a country the settle wait below has nothing left
   * to protect, since `useSettledSubdivisionCountries` shares its cache with
   * `useSubdivisions` and answering it again costs no request either way.
   */
  const resolvedEver = useRef(new Set<string>());

  /*
   * Both of the above brought up to date, in an effect rather than in the
   * render body they used to be written from.
   *
   * Neither is read by the render — `drawn` by the settle plan and by the
   * fades `commit` publishes, `resolvedEver` by the settle wait — so writing
   * them here loses nothing and stops the render having a side effect. It runs
   * before both of those because it is declared before them, which is the
   * ordering the render-body writes gave for free and the one the plan below
   * depends on.
   */
  useEffect(() => {
    drawn.current = subdivisions.map((each) => each.country);
    for (const country of settled) resolvedEver.current.add(country);
  }, [subdivisions, settled]);

  /* ------------------------------------------------------------ arrival -- */

  /**
   * When each country's detail landed, so that it can arrive by fading.
   *
   * The layer used to appear in one frame: the moment a country's geometry
   * was in hand, its borders went to full strength and its own name dropped to
   * whatever the handover left, both between one frame and the next. Measured
   * cold in Chrome, the reader watched nothing at all for about 1.6s and then
   * saw the whole view change at once — which is the reader's report that the
   * appearance is neither fluid nor the same across countries, because a view
   * assembled out of several instantaneous events has no shape a person can
   * follow.
   *
   * Everything else on this map that appears, appears by fading, and the fade
   * comes from the geometry rather than from a stylesheet — 12.27 for the
   * names, 12.28 for the handover, `limbFade` and `roomFade` for both. This is
   * that same rule extended to the one layer that was not using it. It cannot
   * be a CSS transition for the reason 12.27 gives and one more: the borders
   * are on the canvas, where there is no node for a stylesheet to hold.
   */
  const arrivedAt = useRef(new Map<string, number>());
  /**
   * The served geometry as it was last projected, kept across a scale or pan
   * change and, briefly, across a rotation.
   *
   * See `reprojectionCache.ts` for what makes that safe, and the block in
   * `draw` that reads and writes this for how. Each entry also remembers which
   * of its `landParts`/`borderRuns` culling kept — the one thing a later
   * affine map cannot fix, and the reason a piece coming into view still forces
   * a rebuild instead of reusing what is here.
   */
  const served = useRef(
    new Map<string, CachedGeometry<Subdivisions> & { land: Path2D; borders: Path2D }>(),
  );

  /**
   * Motion the reader has asked not to see.
   *
   * Read here rather than in the stylesheet because this fade is computed in
   * JavaScript, so the `prefers-reduced-motion` block that stops the arcs
   * flowing cannot reach it. Read once: a reader does not change this setting
   * mid-drag, and `matchMedia` in the render body would run sixty times a
   * second.
   */
  const [stillness] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  /** How far into its arrival a country is, from 0 to 1. */
  const arrivalFade = useCallback(
    (country: string, at: number) => {
      const since = arrivedAt.current.get(country);
      if (since === undefined) return 0;
      if (stillness) return 1;
      return Math.min(1, (at - since) / ARRIVAL_MS);
    },
    [stillness],
  );

  /*
   * A country that has just landed starts its fade; one that has left the view
   * forgets it had one.
   *
   * Forgetting matters: the geometry is cached forever, so a country the
   * reader pans back onto would otherwise reappear in a single frame — the
   * exact pop this removes — while a country that never left keeps the fade it
   * already finished and does not start again.
   */
  useEffect(() => {
    const at = performance.now();
    const here = new Set(subdivisions.map((each) => each.country));
    for (const country of arrivedAt.current.keys()) {
      if (!here.has(country)) arrivedAt.current.delete(country);
    }
    for (const country of here) {
      if (arrivedAt.current.has(country)) continue;
      arrivedAt.current.set(country, at);
    }
  }, [subdivisions]);

  /**
   * The coarse shapes the finer ones replace, and everything that touches them.
   *
   * All of it comes off the bundled atlas and none of it changes while the
   * same set of countries is drawn, so this is worked out when that set moves
   * and not once a frame — the neighbour search walks all 177 bounding boxes
   * once per country, which is nothing on a settle and real work sixty times a
   * second.
   *
   * `byId` is the same `shapes` array again, keyed by country so `draw` can
   * find one country's own 1:110m outline in constant time — the shape it
   * substitutes for a country's frozen 1:10m one while that one is `stale`,
   * see the reprojection block below.
   */
  const coarse = useMemo(() => {
    const found = outlinesOf(swapped ? swapped.split(',') : []);
    const byId = new Map<string, object>();
    for (const shape of found.shapes) {
      const id = (shape as { id?: string | number }).id;
      if (id !== undefined) byId.set(String(id), shape);
    }
    // Indexed on the same terms as everything else the map draws. The clipped
    // shapes are the countries the reader zoomed into and are on screen by
    // construction; the neighbours are whatever the bounding-box sweep swept
    // up, which over Europe is most of the continent.
    return { shapes: found.shapes, neighbours: capped(found.neighbours as never[]), byId };
  }, [swapped]);

  /**
   * Every national border except those of the countries being redrawn.
   *
   * A mesh again, for 12.50's reason, but built without the edges that touch
   * any swapped country — those are stroked from the finer outlines instead.
   * Dropping them is what keeps a shared border from being painted twice at
   * two resolutions, which would read as a doubled line wherever the two
   * generalizations part company, and they part company by a median of 1.5 to
   * 5.2 km.
   *
   * The filter takes *either* side, which matters now that neighbours can both
   * be fine: the frontier between two redrawn countries has to leave the
   * coarse mesh exactly once, and it is the only edge in the topology where
   * both tests would have fired.
   *
   * Recomputed only when the drawn set moves, and indexed by where each run of
   * it falls at the same time. Measured, the mesh costs 3.4 ms to rebuild and
   * the index over it 4.6 ms — both a few milliseconds once, on a settle, and
   * both unaffordable per frame, which is why they sit together here.
   */
  const boundaries = useMemo(() => {
    if (!swapped) return BOUNDARY_RUNS;
    const redrawn = new Set(swapped.split(','));
    return cappedRuns(
      mesh(
        worldAtlas as never,
        (worldAtlas as never as { objects: { countries: never } }).objects.countries,
        (left: { id?: string | number }, right: { id?: string | number }) =>
          !redrawn.has(String(left.id)) && !redrawn.has(String(right.id)),
      ) as never,
    );
  }, [swapped]);

  const arcs = useMemo(
    () => routes.map((route) => ({ route, line: greatCircle(route.from, route.to) })),
    [routes],
  );
  const stops = useMemo(
    () =>
      stopRoutes.flatMap((stop) => {
        const segments = [];
        for (let index = 1; index < stop.points.length; index += 1) {
          segments.push({
            id: `${stop.id}:${index}`,
            colour: stop.colour,
            line: greatCircle(stop.points[index - 1], stop.points[index]),
          });
        }
        return segments;
      }),
    [stopRoutes],
  );
  const stopNodes = useMemo(
    () =>
      stopRoutes.flatMap(({ id, points, viaPoints, colour }) =>
        viaPoints.flatMap((code, index) => {
          const point = points[index + 1];
          return point ? [{ id: `${id}:${code}:${index}`, point, code, colour }] : [];
        }),
      ),
    [stopRoutes],
  );

  /**
   * The three projections, made once and then written in place by `fit`.
   *
   * A value rather than a ref, and that is not bookkeeping: the SVG overlay
   * projects its arcs, its airport dots and its place names through these, so
   * they are an input to the render, and reaching for them through a ref was
   * the render reading state React had never been told about. `useState`'s
   * initialiser rather than `useMemo` because this has to happen exactly once
   * — `useMemo` is allowed to throw its result away and recompute, which for
   * three objects `fit` has been writing into all along would silently reset
   * the view.
   */
  const [places] = useState<Places>(makePlaces);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return null;
    const rect = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (rect.width !== size.current.width || rect.height !== size.current.height) {
      size.current = { width: rect.width, height: rect.height };
      // Assigning width reallocates the backing store and clears the canvas,
      // so it happens when the box changes and not once per frame.
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    }

    const fitted = Math.min(rect.width, rect.height) * 0.42;
    const radius = fitted * zoom.current;

    // The globe is turned, not dragged, so panning never applies to it.
    const middle: [number, number] = [rect.width / 2, rect.height / 2];
    for (const globe of [places.globe, places.glass]) {
      globe.translate(middle).scale(radius).rotate(rotation.current);
    }

    // Zoom multiplies the *unzoomed* fit rather than being capped by it. The
    // old form took `min(width / 2π, radius * 0.6)` with the zoom already
    // inside `radius`, so the cap — which is exactly the scale that fits 360°
    // of longitude across the frame — bit at about 1.1× and the flat map
    // stopped zooming there while the globe went on to 8×.
    const mercator = places.mercator;
    mercator
      .translate([middle[0] + pan.current.x, middle[1] + pan.current.y])
      .scale(Math.min(rect.width / (2 * Math.PI), fitted * 0.6) * zoom.current);
    // Clamped after the fact rather than predicted: `geoMercator` runs to
    // infinity at the poles and d3 cuts it off at a latitude of its own
    // choosing, so the only honest source for how big the map is right now is
    // the projected sphere itself.
    pan.current = clampPan(mercator, rect, pan.current);
    mercator.translate([middle[0] + pan.current.x, middle[1] + pan.current.y]);

    return { rect, dpr };
  }, [places]);

  /**
   * The view the canvas was last painted at, as a value rather than as a set
   * of refs the render reaches into behind React's back.
   *
   * Every field here lives in a ref as well, and the refs stay the working
   * copy — the note on `zoom` above is about exactly that and it still holds:
   * a wheel gesture writes `zoom.current` dozens of times and a drag writes
   * `rotation.current` on every pointer move, and not one of those should be a
   * render. Nothing about that changes. What changes is that the *render* no
   * longer reads them mid-flight. `commit` publishes them once, in the same
   * breath as the `draw` that used them, so the SVG overlay is laid out from
   * exactly the numbers the canvas underneath it was painted with.
   *
   * That is the same guarantee `flushSync` gives the frame loop, and this is
   * its other half: `flushSync` fixes *when* the overlay commits, this fixes
   * *what it commits from*. A render caused by anything else — a prop
   * arriving, a query landing, `setMoving` at the top of a wheel gesture —
   * used to lay the overlay out from whatever the refs held at that instant,
   * which is a view no `draw` had painted and the canvas was not showing.
   *
   * `places` is handed over by reference on purpose. `fit` mutates the three
   * d3 projections in place, because rebuilding them sixty times a second is
   * the cost this map does not pay; what a snapshot can pin is therefore
   * *when* they are read rather than a copy of them, and every caller of
   * `commit` has just finished writing them.
   */
  const [painted, setPainted] = useState<Painted>(() => ({
    rotation: [...HOME],
    zoom: 1,
    zoomTarget: 1,
    pan: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
    places,
    fades: new Map(),
  }));

  /**
   * Publish what `draw` just painted. Always called with it, never instead of
   * it — the pair is one frame.
   */
  const commit = useCallback(() => {
    const at = performance.now();
    setPainted({
      rotation: rotation.current,
      zoom: zoom.current,
      zoomTarget: zoomTarget.current,
      pan: pan.current,
      size: size.current,
      places,
      fades: new Map(drawn.current.map((country) => [country, arrivalFade(country, at)])),
    });
  }, [places, arrivalFade]);

  /*
   * What a gesture is doing, and how long its aftermath lasts.
   *
   * Up here rather than down with the handlers that write them because `draw`
   * reads both on every frame — `forcesDegrade` is handed `gesture.current
   * ?.kind` and `coarseUntil.current` — and a ref a hook closes over before it
   * has been declared is a ref nothing downstream can be shown to be allowed
   * to write.
   */
  type Gesture =
    | {
        kind: 'rotate';
        v0: [number, number, number];
        q0: [number, number, number, number];
        r0: [number, number, number];
      }
    | { kind: 'pan'; x: number; y: number; from: { x: number; y: number } }
    /**
     * Two fingers scaling the map, holding the span between them when it was
     * last measured.
     *
     * A span rather than the two points: what the scale follows is the ratio
     * between one measurement and the next, so re-measuring on every change —
     * a finger moving, a third landing, one of three lifting — is what keeps
     * the gesture continuous through all of them. There is nowhere for a jump
     * to come from if the baseline is never older than the last event.
     */
    | { kind: 'pinch'; span: number };

  const gesture = useRef<Gesture | null>(null);

  /**
   * Every finger currently down on the stage, in the stage's own coordinates.
   *
   * The stage used to keep one gesture and let a second `pointerdown`
   * overwrite it, so a second finger did not make a pinch — it restarted the
   * rotate somewhere else, and the map lurched. Keyed by `pointerId` because
   * that is the only thing that tells two fingers apart, and an insertion-
   * ordered `Map` because a pinch is about the *first two* down: a third
   * finger landing must not silently re-measure the gesture against a
   * different pair.
   *
   * Not restricted to `pointerType === 'touch'`. Two mice cannot both be down
   * at once, so gating on the type would only ever exclude a pen or a
   * touchscreen reporting itself oddly, and buy nothing.
   */
  const touches = useRef(new Map<number, { x: number; y: number }>());

  /**
   * How long past the end of a rotate drag, or a zoom glide, `forcesDegrade`
   * still answers `true` on its own — a `performance.now()` timestamp, `0`
   * until the first one ends. `draw` reads it every frame; only
   * `scheduleSettle` writes it.
   */
  const coarseUntil = useRef(0);

  const draw = useCallback(() => {
    const fitted = fit();
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!fitted || !canvas || !stage) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const { rect, dpr } = fitted;
    const shown: GeoProjection = projection === 'globe' ? places.globe : places.mercator;
    const path = geoPath(shown, context);

    /*
     * What the camera can see, and the one question every layer below asks
     * before it projects anything.
     *
     * Computed once a frame rather than once a shape: it is the same cap for
     * all of them, it costs one `asin` on the globe and four inversions on the
     * flat map, and `lib/visible` explains why the frame that does not ask it
     * spends half of itself on ground the reader cannot see.
     */
    const seen = viewCap(shown, rect, projection === 'globe', rotation.current);
    const onScreen = (cap: Cap) => capsMeet(cap, seen);

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    /**
     * The water, painted the same way wherever it is asked for.
     *
     * Its own function because it is needed twice: once as the ground
     * everything sits on, and again inside the clip that lifts a country's
     * coarse outline off the map before its finer one goes down. Both calls
     * build the gradient from the same projection coordinates, so the second
     * one lands exactly on top of the first and the seam is invisible.
     */
    const paintWater = () => {
      if (projection === 'globe') {
        const [cx, cy] = places.globe.translate();
        const radius = places.globe.scale();
        const face = context.createRadialGradient(
          cx - radius * 0.35,
          cy - radius * 0.4,
          radius * 0.1,
          cx,
          cy,
          radius,
        );
        face.addColorStop(0, readToken(stage, '--map-ocean-lit'));
        face.addColorStop(1, readToken(stage, '--map-ocean'));
        context.fillStyle = face;
        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.fill();
        return;
      }
      context.beginPath();
      path({ type: 'Sphere' });
      context.fillStyle = readToken(stage, '--map-ocean');
      context.fill();
    };

    if (projection === 'globe') {
      const [cx, cy] = places.globe.translate();
      const radius = places.globe.scale();
      // The halo just outside the limb is most of what makes a flat disc read
      // as a sphere, and it costs one gradient. Outside the globe, so it is
      // not part of `paintWater` and never repainted inside a country.
      const halo = context.createRadialGradient(cx, cy, radius * 0.96, cx, cy, radius * 1.16);
      halo.addColorStop(0, readToken(stage, '--map-halo'));
      halo.addColorStop(1, 'transparent');
      context.fillStyle = halo;
      context.beginPath();
      context.arc(cx, cy, radius * 1.16, 0, Math.PI * 2);
      context.fill();
    }
    paintWater();

    /*
     * Land as one flat mass, then every boundary once on top — mapcn's own
     * arrangement, read from its source: a monochrome fill with a separate
     * near-background line, and no graticule anywhere. The grid of meridians
     * and parallels went with it; on a globe carrying seven arcs and a dozen
     * place names it was the busiest thing on screen and the only one carrying
     * nothing.
     */
    const land = readToken(stage, '--map-land');
    context.beginPath();
    // One country at a time rather than the whole collection in one call, so
    // that the ones the camera cannot see are never streamed. Identical ink:
    // the subpaths land in the same path, in the same order, and one `fill`
    // still closes the lot — verified against the collection in the browser,
    // pixel for pixel, at eleven views on both projections.
    for (const part of WORLD_PARTS) if (onScreen(part.cap)) path(part.shape as never);
    context.fillStyle = land;
    context.fill();

    /*
     * Every country in front of the reader, redrawn from the finer outlines
     * the API served for them.
     *
     * The bundled 1:110m base has a median segment of 63 km. That is fifteen
     * pixels at 8x, where it read as a coastline; at 32x it is sixty-one, and
     * a coast becomes a run of long straight lines. So the countries the
     * reader has closed in on are redrawn at 1:10m — the same resolution as
     * the subdivision borders inside them, from the same files, which is what
     * stops the two disagreeing at the shore.
     *
     * Two resolutions cannot simply be laid over one another. Measured, the
     * coarse and fine outlines of these countries sit a median of 1.5 to 5.2
     * km apart and up to 31 km at the worst vertex, so painting the fine shape
     * on top would leave the coarse one showing past it into the sea, and
     * painting it *instead* would open a strip of ocean along every frontier
     * where the neighbour's own coarse border had been generalised inland.
     * Hence the three steps, inside a clip of the coarse shapes: put the water
     * back, lay the fine countries down, then paint the coarse land of
     * everything that touches them back over whatever they do not claim.
     * Nothing outside those coarse outlines is touched, so the rest of the map
     * is exactly as it was.
     *
     * **What fan-out changed is the third step, and only the third.** The clip
     * is a union now and the fine shapes are a list, both of which are the
     * same operation more times. The neighbours are not: `outlinesOf` excludes
     * any country that is itself being redrawn, because Bolivia is a neighbour
     * of Peru and painting Bolivia's coarse self back inside the clip would
     * bury the fine Peru-Bolivia frontier under a 1:110m approximation of
     * itself — the one shared border in the view that both fine files already
     * agree on to within 133 m.
     */
    const fine = subdivisions.filter(
      (each): each is Subdivisions & { land: NonNullable<Subdivisions['land']> } =>
        each.land !== null,
    );

    /*
     * The served geometry, projected once and reused for as long as the
     * reprojection would land in the same place — which, for a fixed rotation,
     * is any scale or pan at all. See `reprojectionCache.ts` for the maths and
     * the proof.
     *
     * This is the layer the cull cannot help with, and the reason is worth
     * stating: culling drops shapes that are somewhere else, and the shapes
     * here are the countries the reader has deliberately closed in on. Peru's
     * 1:10m outline is a single ring eighteen degrees across; at 32x the frame
     * holds three degrees of it and the other fifteen are in the same ring, so
     * there is nothing to skip. Measured, projecting the fine land and the fine
     * internal borders of Peru, Bolivia and Chile from scratch is 16 to 20 ms a
     * frame with everything else in the frame down to three — the United
     * States alone, at 326 KB, is 18 to 21 ms; see
     * `docs/airfare-map-rendering.md` for the method.
     *
     * **That cost used to be paid on every frame the camera moved at all**,
     * because the old cache was keyed on the whole camera state — scale,
     * rotation and pan together — so a zoom or a drag missed it exactly as
     * often as it hit, which is most frames of the gesture a reader described
     * as stuttering. It is real work only when the rotation itself changes:
     * `reprojectionCache.decideReuse` reuses the existing `Path2D` through an
     * exact affine map whenever it has not, which on the flat map — whose
     * rotation never changes — is always. A spin still moves every point on
     * the sphere by a different amount, which no single map can stand in for;
     * there, a country's borders are allowed to lag the turn by up to
     * `rotateThrottleMs`'s throttle before the 1:10m shape is worth
     * reprojecting again, scaled by `geometryWeight` rather than flat so a
     * country cheap enough to reproject every frame is not held back as long
     * as the heaviest one on file just because they share a constant.
     *
     * **What a country looks like while it is held back changed once this was
     * measured against a moving globe rather than a still one.** The first
     * version of this throttle drew the held `Path2D` exactly where it was
     * built — a deliberate lie about *position*, bounded in time — and
     * measured live at a state-border zoom with the United States on screen
     * (60°/s, `docs/airfare-map-rendering.md` §1.4), that lie cost up to ~60 px
     * of drift between the frozen shape and where the same lon/lat point
     * actually sits, visible as a seam on the spin's leading edge. A country
     * held back now instead swaps in its own bundled 1:110m outline — the same
     * shape `coarse.shapes` already re-clips every frame for the resolution
     * step below, so drawing it again here costs one more cheap `geoPath` call
     * per held-back country, not another expensive one — and that shape is
     * projected fresh, this frame, from the live rotation, so it carries none
     * of the lag the fine geometry would have. The lie is now about
     * *resolution* instead of position: coarser for as long as the throttle
     * says, but never anywhere but where the country actually is. Its internal
     * admin borders are skipped for the same frames, rather than stroked from
     * a shape whose outline has just moved out from under them — see `inside`
     * further down.
     *
     * **Per country, not per view's worth of countries**, and that is the half
     * that makes the fade a fade. A fan-out lands one country at a time, a few
     * tens of milliseconds apart, and a single cache over the set would be
     * thrown away by each of them — so the reader would pay to reproject Peru
     * and Bolivia again in order to draw Chile for the first time, three times
     * over, in the three frames where the fade is meant to be happening.
     *
     * That is also why it is a `Path2D` and not a list of points. It is the
     * interface `geoPath` already writes into — `moveTo`, `lineTo`,
     * `closePath` — so nothing about the drawing changes; it can be filled
     * inside the clip below *and* stroked with the national borders further
     * down from one projection instead of two; and `addPath` puts the several
     * countries back into the one path a single fill and a single stroke need,
     * carrying each one's own affine map along with it, without going near the
     * sphere again.
     *
     * Polygon by polygon and run by run, so an outlying piece is skipped on the
     * same terms a whole country is: Chile's file carries Easter Island
     * 3,500 km off its coast, and a reader looking at Santiago should not be
     * paying to project it. `decideReuse` is told which pieces this frame's
     * culling kept, and rebuilds rather than reusing the moment that set
     * changes — an affine map repositions the vertices a `Path2D` already
     * holds, it cannot add the ones culling had left out.
     */
    const snapshot: ProjectionSnapshot = {
      rotation: shown.rotate(),
      scale: shown.scale(),
      translate: shown.translate(),
    };
    const now = performance.now();
    const held = served.current;
    const matrices = new Map<string, Matrix2D>();
    /**
     * A country's 1:110m outline, reprojected fresh this frame, standing in
     * for its held-back 1:10m one — see the comment above. Keyed apart from
     * `matrices` because it is a finished `Path2D` under the live projection
     * already, not something a matrix still has to be applied to.
     */
    const degradedLand = new Map<string, Path2D>();
    for (const country of held.keys()) {
      if (!subdivisions.some((each) => each.country === country)) held.delete(country);
    }

    /**
     * Draws `country`'s coarse stand-in for this frame, whichever of the two
     * reasons below asked for it — the coarse atlas does not know which one
     * drew it, and neither should the reader.
     */
    const degradeCountry = (country: string) => {
      const outline = coarse.byId.get(country);
      if (standInFor(outline !== undefined) === 'coarse-outline') {
        const outlinePath = new Path2D();
        const intoOutline = geoPath(shown, outlinePath as unknown as CanvasRenderingContext2D);
        intoOutline(outline as never);
        degradedLand.set(country, outlinePath);
      } else {
        matrices.set(country, IDENTITY_MATRIX);
      }
    };

    /**
     * Whether the reader's pointer is turning the globe right now, whether a
     * wheel/keyboard zoom on the globe is still gliding, or either one let go
     * within the last `SETTLE_MS` — see `forcesDegrade` for why a held
     * gesture decides this on its own, without asking `decideReuse` anything.
     *
     * Rotation changes on every frame of a drag, so a light country's own
     * `rotateThrottleMs` keeps expiring and being renewed a few frames apart
     * — cheap enough to rebuild almost every time, which is exactly the
     * problem: each of those rebuilds is a moment where `anyStale` reads
     * `false` again, so the fine/coarse swap this file already accepts once
     * per throttle window instead flips several times over one continuous
     * drag, and a reader watching one gesture sees the admin borders blink
     * rather than a border that held still. `decideReuse` is not wrong on
     * any of those frames — it is answering a question about one country's
     * own geometry, and no single country's answer was ever the thing that
     * needed to hold still. This is a coarser question, asked once for the
     * whole gesture instead of once per country per frame: while the pointer
     * is down, and for one settle beat after, the map shows one thing.
     *
     * A wheel/keyboard zoom on the globe answers the same coarser question,
     * for the same reason: `applyZoom` re-anchors the pointed-at place back
     * under the cursor every frame the glide runs, and on a sphere that is a
     * rotation change like any other. `zoomGliding` is `zoom.current !==
     * zoomTarget.current` — true for exactly as long as `stepZoom` still has
     * somewhere to ease towards — rather than anything read off `gesture`,
     * because a zoom never captures the pointer the way a drag does.
     */
    const zoomGliding = projection === 'globe' && zoom.current !== zoomTarget.current;
    const forcedCoarse = forcesDegrade(
      gesture.current?.kind,
      zoomGliding,
      now,
      coarseUntil.current,
    );

    if (forcedCoarse) {
      // Every redrawn country takes the coarse branch together, and none of
      // them pays to rebuild: a rebuild mid-gesture would answer for a
      // rotation that has already moved on by the time the next frame asks
      // again, so it is thrown away undrawn either way. `held` is left
      // exactly as stale as it was; the first frame once the gesture ends
      // rebuilds it from whatever rotation is live then, not one already
      // behind it.
      for (const each of subdivisions) degradeCountry(each.country);
    } else {
      /**
       * Every country's own answer, decided before any of them draws
       * anything.
       *
       * `decideReuse` only compares one country's cache against the current
       * frame — it has no way to know what its neighbours just decided, and
       * it is not supposed to: the throttle it applies is genuinely
       * per-country, scaled by that one country's own `geometryWeight`.
       * Collecting every answer first, and only then choosing what to draw,
       * is what lets `anyStale` see all of them at once before the expensive
       * half of this loop — the actual reprojection below — commits to doing
       * anything.
       */
      const decisions = new Map<
        string,
        { decision: ReuseDecision; includedLand: boolean[]; includedBorders: boolean[] }
      >();
      for (const each of subdivisions) {
        const had = held.get(each.country);
        const includedLand = each.landParts.map((part) => onScreen(part.cap));
        const includedBorders = each.borderRuns.map((run) => onScreen(run.cap));
        const decision = decideReuse(
          had,
          each,
          snapshot,
          now,
          rotateThrottleMs(geometryWeight(each.landParts, each.borderRuns)),
          includedLand,
          includedBorders,
        );
        decisions.set(each.country, { decision, includedLand, includedBorders });
      }

      /**
       * Whether this frame draws every redrawn country's coarse stand-in
       * together — see `anyStale` for why a mismatch between two countries'
       * own answers, not either answer alone, is the thing that opens a seam.
       */
      const degradeGroup = anyStale([...decisions.values()].map((each) => each.decision));

      for (const each of subdivisions) {
        const found = decisions.get(each.country);
        if (!found) continue;
        const { decision, includedLand, includedBorders } = found;

        if (degradeGroup) {
          degradeCountry(each.country);
          continue;
        }

        if (decision.kind === 'reuse') {
          matrices.set(each.country, decision.matrix);
          continue;
        }

        // `decision.kind` is `rebuild` here, never `stale`: `degradeGroup` is
        // false only when no country's own answer was `stale` to begin with.
        const landPath = new Path2D();
        const intoLand = geoPath(shown, landPath as unknown as CanvasRenderingContext2D);
        for (const [index, part] of each.landParts.entries())
          if (includedLand[index]) intoLand(part.shape);
        const bordersPath = new Path2D();
        const intoBorders = geoPath(shown, bordersPath as unknown as CanvasRenderingContext2D);
        for (const [index, run] of each.borderRuns.entries())
          if (includedBorders[index]) intoBorders(run.shape);
        held.set(each.country, {
          of: each,
          land: landPath,
          borders: bordersPath,
          snapshot,
          builtAt: now,
          includedLand,
          includedBorders,
        });
        matrices.set(each.country, IDENTITY_MATRIX);
      }
    }

    /*
     * The several countries as the one shape the fill and the stroke both want.
     *
     * One path rather than one per country, because two shapes stroked
     * separately are not the picture one shape stroked once is: wherever two of
     * them share a frontier the edge is antialiased twice and comes out darker
     * than the same line anywhere else. `addPath`'s own transform argument is
     * what lets a country cached under an older scale or pan join this one
     * path without first being redrawn into it.
     */
    let fineLand: Path2D | null = null;
    if (fine.length > 0) {
      fineLand = new Path2D();
      for (const each of fine) {
        const degradedPath = degradedLand.get(each.country);
        if (degradedPath) {
          fineLand.addPath(degradedPath);
          continue;
        }
        const ready = held.get(each.country);
        if (ready) fineLand.addPath(ready.land, matrices.get(each.country) ?? IDENTITY_MATRIX);
      }
    }

    if (fineLand && coarse.shapes.length > 0) {
      context.save();
      context.beginPath();
      for (const shape of coarse.shapes) path(shape as never);
      context.clip();

      paintWater();

      context.fillStyle = land;
      context.fill(fineLand);

      context.beginPath();
      for (const neighbour of coarse.neighbours) if (onScreen(neighbour.cap)) path(neighbour.shape);
      context.fillStyle = land;
      context.fill();
      context.restore();
    }

    /*
     * The subdivisions of every country in front of the reader, under the
     * national borders rather than over them.
     *
     * A mesh, for 12.50's reason and one more: a boundary between two
     * provinces belongs to both, and stroking each province's own outline
     * would paint it twice — which at this opacity is the difference between a
     * quiet line and a visible one, and would make an interior border heavier
     * than the coast. The mesh is computed when the file is built rather than
     * here, so what arrives is already a `MultiLineString` and the browser
     * never walks the topology.
     *
     * One `stroke` for every country that has finished arriving, rather than
     * one each: at rest the opacity is a property of the layer and not of a
     * country, and stroking country by country under a `globalAlpha` would
     * darken every place two of them overlapped on screen. A country still
     * fading in gets its own pass because for those few frames the opacity
     * *is* a property of that country — so the steady state is still the one
     * stroke the frame budget was measured against, and the extra passes last
     * as long as the fade and no longer.
     *
     * Opacity comes from the geometry, per frame, the same way a place name's
     * does — 12.27 — so the borders arrive as the countries' names leave
     * rather than switching on at a threshold.
     *
     * A country drawn from its `degradedLand` outline this frame keeps its own
     * name's worth of admin borders out of this stroke: they are 1:10m lines
     * held back from an older rotation, and stroking them against an outline
     * that just moved out from under them would show state borders crossing
     * the coast rather than following it.
     */
    const inner = subdivisionFade(zoom.current);
    const inside =
      inner > 0
        ? subdivisions.filter(
            (each): each is Subdivisions & { borders: NonNullable<Subdivisions['borders']> } =>
              each.borders !== null &&
              strokesInnerBorders(standInFor(degradedLand.has(each.country))),
          )
        : [];
    if (inside.length > 0) {
      const at = now;
      const settled = inside.filter((each) => arrivalFade(each.country, at) >= 1);
      const landing = inside.filter((each) => arrivalFade(each.country, at) < 1);
      context.save();
      context.strokeStyle = readToken(stage, '--map-border-inner');
      // Just over half the national border's width, on top of a colour with
      // just over half its separation from the land. A subdivision line has to
      // read as *inside* something, and matching either one of those alone was
      // not enough to stop the two reading as the same line.
      context.lineWidth = Math.min(1.7, 0.85 + zoom.current * 0.18) * 0.55;
      context.lineJoin = 'round';
      if (settled.length > 0) {
        context.globalAlpha = inner;
        // Gathered into one path and stroked once, from what this view already
        // projected: at rest the opacity is a property of the layer and not of
        // a country, and stroking country by country under a `globalAlpha`
        // would darken every place two of them overlapped on screen. Each
        // country's own affine map — identity for one just built or drawn
        // stale — travels with it into the merge.
        const all = new Path2D();
        for (const each of settled) {
          const runs = held.get(each.country);
          if (runs) all.addPath(runs.borders, matrices.get(each.country) ?? IDENTITY_MATRIX);
        }
        context.stroke(all);
      }
      for (const each of landing) {
        const coming = arrivalFade(each.country, at);
        if (coming <= 0) continue;
        context.globalAlpha = inner * coming;
        const runs = held.get(each.country);
        if (runs) {
          const path = new Path2D();
          path.addPath(runs.borders, matrices.get(each.country) ?? IDENTITY_MATRIX);
          context.stroke(path);
        }
      }
      context.restore();
    }

    /*
     * Every national border once — minus those of the countries being redrawn,
     * which are stroked from their finer outlines instead. `boundaries` is the
     * coarse mesh with every edge touching any of them filtered out, so the
     * line is drawn exactly once either way and never twice at two different
     * resolutions.
     *
     * The one place that is not exactly once is a frontier between two redrawn
     * countries: both files carry it, so it is stroked from each. Measured,
     * the two agree to a median of 67-133 m and a p90 of 0.32 km — a third of
     * a pixel at the 32x ceiling, against the 7.3 km median a fine perimeter
     * and a coarse neighbour's border sat apart before — and an opaque colour
     * stroked twice at the same width is the same line. This is the tripoint
     * seam closing rather than moving.
     */
    context.strokeStyle = readToken(stage, '--map-border');
    /*
     * Borders hold their weight as the globe grows, up to a point: a hairline
     * disappears when zoomed out and a fixed width turns into a ribbon when
     * zoomed in. The colour relationship is already mapcn's — 1.70 against its
     * 1.73, measured — so what has to carry the line at globe scale is width.
     */
    context.lineWidth = Math.min(1.7, 0.85 + zoom.current * 0.18);
    context.lineJoin = 'round';
    /*
     * Still exactly one stroke, and that is not a detail.
     *
     * The coarse runs and the redrawn countries' own perimeters go into one
     * `Path2D` — the fine half by `addPath`, since it was already built for the
     * fill above — and the whole lot is stroked in a single call. Two strokes
     * would put down the same lines in the same places and still not be the
     * same picture: where a coarse border ends at a redrawn country's frontier
     * the two runs share their last pixel, and an antialiased edge composited
     * twice is darker than one composited once. Compared in the browser against
     * the drawing this replaces, one stroke was identical at every view tested
     * and two strokes were not.
     */
    const ink = new Path2D();
    const into = geoPath(shown, ink as unknown as CanvasRenderingContext2D);
    for (const run of boundaries) if (onScreen(run.cap)) into(run.shape);
    if (fineLand) ink.addPath(fineLand);
    context.stroke(ink);

    /*
     * Night, over everything the frame just painted. Only the globe has a
     * night side to show — a flat map has no "away from the sun", it has
     * every longitude in the same picture at once.
     *
     * The circle itself is cheap: `geoCircle` samples a great-circle boundary
     * into a few dozen points, nothing next to the thousands a coastline
     * carries, so recomputing and reprojecting it fresh every frame costs
     * nothing worth caching — unlike the subdivisions above, there is no
     * reprojectionCache entry for it.
     */
    if (projection === 'globe') {
      const night = geoCircle().center(antisolarPoint(new Date())).radius(90)();
      const shadow = new Path2D();
      const intoShadow = geoPath(shown, shadow as unknown as CanvasRenderingContext2D);
      intoShadow(night);
      context.fillStyle = readToken(stage, '--map-night');
      context.fill(shadow);
    }
  }, [fit, places, projection, subdivisions, coarse, boundaries, arrivalFade]);

  useEffect(() => {
    draw();
    commit();
  }, [draw, commit]);

  /*
   * Which countries the camera has in front of it, and which of those the
   * budget will stretch to.
   *
   * It used to be the one country under the middle of the frame, on the
   * argument that the middle is where a reader puts the thing they are looking
   * at. That is still true and the middle is still first — `planFanOut` pins
   * it — but it was the wrong *set*: what a reader looks at is a viewport, and
   * a viewport with one detailed country in it and blank neighbours reads as a
   * map that is broken. So the middle names the country that must be detailed
   * and `countriesInView` names the rest, in the order they fill the screen.
   *
   * Both projections answer it the same way, which is why the flat map needs
   * no separate rule: the sweep is done through the shown projection's own
   * `invert`, so the globe's clip and Mercator's pan are already in it.
   *
   * `painted` is in the dependencies as the map's own "something was drawn"
   * signal, so a view that changed without a gesture — a reset, a resize — is
   * noticed too. It changes every frame during a drag, and every one of those
   * runs stops at the `moving` check without setting a timer.
   */
  useEffect(() => {
    if (moving) return;
    // Nothing at all until the view is close enough for the layer to be worth
    // having. This is the first and cheapest of the four: a reader who never
    // zooms in never sends a request, the catalogue included.
    if (zoom.current < SUBDIVISION_REACH) {
      setWanted((was) => (was.length === 0 ? was : NOTHING_WANTED));
      return;
    }
    setReached(true);

    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    const shown = projection === 'globe' ? places.globe : places.mercator;
    const invert = (at: [number, number]) => shown.invert?.(at) ?? null;
    const middle = invert([rect.width / 2, rect.height / 2]);
    // Open water, or a shape the atlas carries without a numeric code, both
    // mean the middle has nothing to ask for — the rest of the view still
    // does.
    const centre =
      middle && Number.isFinite(middle[0]) && Number.isFinite(middle[1])
        ? (countryAt([middle[0], middle[1]])?.id ?? null)
        : null;
    const plan = planFanOut(countriesInView(invert, rect), centre, catalogue, drawn.current);

    const apply = () => {
      // Same set, same array: `useQueries` builds one query per entry and the
      // map keys its canvas work off what comes back, so handing back a new
      // array of the same ids would restart both for nothing.
      setWanted((was) =>
        was.length === plan.countries.length && was.every((id, at) => id === plan.countries[at])
          ? was
          : plan.countries,
      );
    };

    /*
     * The wait below exists to keep a reader spinning past a dozen countries
     * a second from sending a dozen requests a second — see `SETTLE_MS`. A
     * plan whose every country has already answered once this session asks
     * the network for nothing at all, so there is nothing left for the wait
     * to protect, and it becomes a reader looking at a country they have
     * already looked at, made to wait to see it again. Applied straight away
     * instead.
     *
     * The borders still fade in — `ARRIVAL_MS` is not this wait and is not
     * skipped here. It stops a country's geometry snapping to full strength
     * in one frame, which is exactly as true of a country already in memory
     * as of one just fetched, and a reader panning back onto the United
     * States is not asking for the "pop" `arrivedAt`'s own comment removed.
     */
    if (!needsSettleWait(plan.countries, resolvedEver.current)) {
      apply();
      return;
    }

    /*
     * The index landing is not the view moving, so it does not cost a settle.
     *
     * Measured cold in Chrome on the reader's own stage: the catalogue was
     * asked for one settle after the zoom gate opened and answered in 4ms, and
     * the first country was not asked for until 1,041ms after that — a whole
     * second settle, waited out because this effect re-runs when `catalogue`
     * changes and then starts the timer again from the top. The view had been
     * still the entire time. A quarter of a second is a quarter of a second,
     * and it is spent on the one gesture that has nothing cached.
     */
    const first = catalogue !== undefined && !indexed.current;
    indexed.current = catalogue !== undefined;
    const handle = setTimeout(apply, first ? 0 : SETTLE_MS);
    return () => clearTimeout(handle);
  }, [moving, painted, places, projection, catalogue]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      draw();
      commit();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [draw, commit]);

  /**
   * Whether any country is still fading in, which is the only thing besides a
   * gesture that keeps the frame loop awake.
   *
   * Read off the last frame rather than kept as its own flag. The two are the
   * same fact — a fade under 1 is a country still arriving — and holding it
   * twice meant an effect that noticed geometry landing and set a boolean,
   * which is a render cascading out of a render. This way the sequence has one
   * driver: a country's geometry lands, `subdivisions` changes, `draw` is
   * rebuilt, the effect that watches `draw` paints and commits a frame whose
   * fades start at 0 — and the loop starts because the frame says so. It stops
   * the same way, on the first frame whose fades are all 1, which is the frame
   * that finished the fade; there is nothing left to draw after it.
   *
   * `prefers-reduced-motion` never gets here: `arrivalFade` answers 1 the
   * moment a country is known, so the frame it lands on is already finished.
   */
  const arriving = [...painted.fades.values()].some((fade) => fade < 1);

  /**
   * The three functions the frame loop and the wheel listener reach for, each
   * through a ref.
   *
   * Both of those are set up once — the loop is started when something begins
   * moving, the listener is attached on mount — while all three functions are
   * rebuilt on every render. Called directly, the loop would freeze on
   * whichever copy of `stepZoom` existed when the gesture started, and the
   * listener would have to detach and reattach sixty times a second during a
   * drag, on the one component whose whole point is that a drag stays smooth.
   * All three are hoisted declarations, so the initial value here is already
   * the real function; the layout effect below keeps them current after that.
   *
   * Declared above the two effects that read them, which is what lets those
   * writes be seen for what they are — see `gesture` and `coarseUntil` for the
   * same reason in the other direction.
   */
  const latestStep = useRef(stepZoom);
  const latestEnd = useRef(endGlide);
  const latestWheel = useRef(onWheel);

  /*
   * A frame loop only while something is actually moving, or arriving.
   *
   * `flushSync` is what keeps the two surfaces together. `draw` paints the
   * canvas inside the frame callback, but a plain `repaint` only *schedules* a
   * React render, and React's scheduler runs on a task that the browser gets
   * to after it has already painted — so the land moved this frame and the
   * arcs, the airport codes and the place names moved on the next one. One
   * frame of slip at 60 Hz is small and completely visible: the map slides out
   * from under its own labels for as long as the drag lasts.
   *
   * Committing synchronously costs the same work, just not deferred.
   *
   * **`arriving` does not take back "no frame loop at rest".** The loop it
   * wakes is bounded by construction: `arrivalFade` is clamped at 1, the last
   * country to land finishes `ARRIVAL_MS` after it lands, and the tick below
   * switches the flag off the moment they all have. A quarter of a second of
   * frames, once per fan-out, against a fade that has to come from the
   * geometry — the borders are on the canvas, where there is no node for a
   * stylesheet to transition. An idle map is still an idle map.
   */
  useEffect(() => {
    if (!moving && !arriving) return;
    let running = true;
    let last = 0;
    const tick = (now: number) => {
      if (!running) return;
      // Elapsed time, not a fixed step per frame, so the glide takes the same
      // wall-clock time on a 60 Hz panel and on a 144 Hz one.
      if (last) latestStep.current(Math.min(now - last, 50));
      last = now;
      draw();
      flushSync(() => {
        commit();
      });
      requestAnimationFrame(tick);
    };
    const handle = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(handle);
    };
  }, [moving, arriving, draw, commit]);

  /* --------------------------------------------------------------- input -- */

  /**
   * The one redraw that lands once `coarseUntil` passes, so degrading has an
   * end a reader can see rather than a frame nobody asked to repaint. Reset
   * by every call to `scheduleSettle`, the same way `wheelStop` replaces its
   * own pending timeout — a gesture that ends inside a previous one's grace
   * window replaces the pending settle with its own rather than racing it.
   */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Holds the coarse stand-in for one more `SETTLE_MS` past a rotate drag or
   * a zoom glide ending, then asks for the one redraw that rebuilds whatever
   * was held back — the same beat the map already waits before asking whose
   * subdivisions to draw. Rebuilding the instant the gesture ends would land
   * that cost, and the jump to full detail, inside the very frame that stops
   * it: one more flip rather than the gesture settling. See `forcesDegrade`.
   * Called from `endGesture` for a rotate drag and from `stepZoom`/`endGlide`
   * for a zoom glide — the two places that ever notice one just ended.
   */
  function scheduleSettle() {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    coarseUntil.current = performance.now() + SETTLE_MS;
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      draw();
      commit();
    }, SETTLE_MS);
  }

  useEffect(() => {
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
  }, []);

  /**
   * What was under the pointer when it went down, and where.
   *
   * Selection is decided on the way *up*, not with an `onClick` on the arc.
   * The stage captures the pointer as soon as a drag starts, and a captured
   * pointer sends its click to the capturing element rather than to the path
   * it began on — so the arc's own click handler is unreliable exactly when
   * the map is being used. Comparing where the press started and ended also
   * gives the distinction that actually matters: a press that stayed put is a
   * choice, a press that travelled is a drag.
   */
  const pressed = useRef<{ route: string | null; x: number; y: number } | null>(null);

  /**
   * Seat a one-finger drag at a point, whichever projection is showing.
   *
   * Its own function because a drag now begins in two places rather than one:
   * a finger going down on a still map, and a pinch dropping back to a single
   * finger. The second is the reason it takes a point rather than reading the
   * event — what has to be re-seated there is where the surviving finger *is*,
   * which is nowhere near where it first landed.
   *
   * Answers `false` when the globe cannot say what is under the point, which
   * is a press outside the disc: there is nothing to turn, and the caller must
   * not capture the pointer or claim the map is moving.
   */
  function beginDrag(at: [number, number]): boolean {
    if (projection === 'globe') {
      const inverted = places.globe.invert?.(at);
      if (!inverted) return false;
      gesture.current = {
        kind: 'rotate',
        v0: versor.cartesian(inverted),
        q0: versor(rotation.current),
        r0: [...rotation.current] as [number, number, number],
      };
      return true;
    }
    // A flat map has no rotation to speak of, so dragging moves it instead.
    gesture.current = { kind: 'pan', x: at[0], y: at[1], from: { ...pan.current } };
    return true;
  }

  /** The first two fingers down, in the order they landed, or nothing. */
  function firstTwo(): [{ x: number; y: number }, { x: number; y: number }] | null {
    const [a, b] = [...touches.current.values()];
    return a && b ? [a, b] : null;
  }

  /**
   * Measure the span between the first two fingers and make that the baseline.
   *
   * Called whenever the set of fingers changes rather than only when the
   * second one lands, which is what makes the count changing under a live
   * gesture free: a third finger arriving and one of three lifting both leave
   * the ratio at exactly 1 for the frame they happen in, so neither is a jump.
   */
  function measurePinch(): boolean {
    const two = firstTwo();
    if (!two) return false;
    const span = Math.hypot(two[1].x - two[0].x, two[1].y - two[0].y);
    if (!(span > 0)) return false;
    gesture.current = { kind: 'pinch', span };
    return true;
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const { offsetX, offsetY } = event.nativeEvent;
    touches.current.set(event.pointerId, { x: offsetX, y: offsetY });
    // A new drag starting inside a previous gesture's settle window replaces
    // it outright: `gesture.current` being set again is already enough for
    // `forcesDegrade` to answer `true`, so the pending redraw at the old
    // `coarseUntil` would only repaint a frame nothing changed for.
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }

    if (touches.current.size > 1) {
      // A second finger is never a press. Whatever the first one landed on,
      // the reader is scaling the map now rather than choosing a route, and
      // clearing this is what stops the pinch ending in an opened route.
      pressed.current = null;
      if (!measurePinch()) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setMoving(true);
      return;
    }

    const target = event.target as Element | null;
    pressed.current = {
      route: target?.getAttribute?.('data-route') ?? null,
      x: offsetX,
      y: offsetY,
    };
    if (!beginDrag([offsetX, offsetY])) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setMoving(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const held = gesture.current;
    if (!held) return;
    const { offsetX, offsetY } = event.nativeEvent;

    const finger = touches.current.get(event.pointerId);
    if (finger) {
      finger.x = offsetX;
      finger.y = offsetY;
    }

    if (held.kind === 'pinch') {
      const two = firstTwo();
      if (!two) return;
      const span = Math.hypot(two[1].x - two[0].x, two[1].y - two[0].y);
      if (!(span > 0)) return;
      /*
       * The baseline moves whether or not the scale did. `aimZoom` refuses a
       * factor that would leave the target where it already is — at either end
       * of the 1x–32x range, that is every event — and a baseline left behind
       * at the ceiling would make the whole of the reader's spread have to be
       * un-spread before the map answered again.
       */
      gesture.current = { kind: 'pinch', span };
      /*
       * The same door the wheel goes through, aimed at the midpoint between
       * the fingers. That is the one point on the screen a pinch genuinely
       * holds still, and it is what makes two fingers on a country keep that
       * country between them instead of sliding it off the frame.
       */
      aimZoom(span / held.span, [(two[0].x + two[1].x) / 2, (two[0].y + two[1].y) / 2]);
      return;
    }

    if (held.kind === 'pan') {
      // Free in both directions; `fit` clamps it to the map's own edges, which
      // at the default zoom leaves only up and down reachable.
      pan.current = { x: held.from.x + (offsetX - held.x), y: held.from.y + (offsetY - held.y) };
      noteMoved();
      return;
    }

    const inverted = places.globe.rotate(held.r0).invert?.([offsetX, offsetY]);
    if (!inverted) return;
    const next = versor.rotation(
      versor.multiply(held.q0, versor.delta(held.v0, versor.cartesian(inverted))),
    );
    // The third angle is dropped so the horizon stays level. Letting it drift
    // makes the globe feel like it is tumbling rather than turning.
    rotation.current = [next[0], next[1], 0];
    noteMoved();
  }

  /** A press that has not travelled far enough to be a drag. */
  const STILL = 4;

  function endGesture(event: React.PointerEvent<HTMLDivElement>) {
    touches.current.delete(event.pointerId);
    const press = pressed.current;
    pressed.current = null;
    if (press?.route) {
      const { offsetX, offsetY } = event.nativeEvent;
      if (Math.hypot(offsetX - press.x, offsetY - press.y) <= STILL) onSelect(press.route);
    }
    const held = gesture.current;
    if (!held) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    /*
     * A finger leaving a pinch is not the gesture ending — it is the gesture
     * becoming a different one, and the map has to carry on from where it is.
     * Three fingers down to two re-measures the span; two down to one seats a
     * drag on where the surviving finger is *now*, which is the whole of what
     * keeps the globe from lurching: a rotate seated on where that finger
     * first landed would turn the map by everything it travelled during the
     * pinch, in the frame after the lift.
     */
    if (held.kind === 'pinch') {
      if (touches.current.size > 1 && measurePinch()) return;
      const [surviving] = touches.current.values();
      if (surviving && beginDrag([surviving.x, surviving.y])) return;
    }

    gesture.current = null;
    setMoving(false);
    // The fingers stop where they stop, so the scale goes where they asked
    // rather than a hair short of it — the same debt `endGlide` settles for a
    // wheel gesture that has run out of notches.
    if (held.kind === 'pinch') endGlide();
    // A pinch turned the globe as well as scaling it: `applyZoom` re-anchors
    // the midpoint on every frame, and on a sphere that is a rotation. So it
    // settles for the same reason a drag does, and it settles even when
    // `endGlide` found the scale already arrived and had nothing to snap.
    if (held.kind === 'rotate' || held.kind === 'pinch') scheduleSettle();
    draw();
    commit();
  }

  /**
   * Put the scale at `next` and bring the anchored place back under its point.
   *
   * Scaling about the middle of the frame slides the thing you are pointing at
   * away exactly when you are trying to get closer to it. The two projections
   * hold it still by different means: the flat map shifts its pan by however
   * far the place moved, and the globe *turns*, because an orthographic has no
   * pan and rotating is the only way to bring a place back to a fixed screen
   * position.
   */
  function applyZoom(next: number) {
    zoom.current = next;
    fit();
    noteMoved();

    const pinned = anchor.current;
    if (!pinned) return;

    if (projection === 'globe') {
      const nowThere = places.globe.invert?.(pinned.at);
      if (!nowThere || !Number.isFinite(nowThere[0])) return;
      const turned = versor.rotation(
        versor.multiply(
          versor(rotation.current),
          // `delta(from, to)` turns the globe so `from` lands where `to` is.
          // The pinned place has to end up where the cursor is, and what sits
          // under the cursor right now is `nowThere`.
          versor.delta(versor.cartesian(pinned.geo), versor.cartesian(nowThere)),
        ),
      );
      // The third angle is dropped for the same reason as in a drag: letting
      // it drift makes the globe tumble rather than turn.
      rotation.current = [turned[0], turned[1], 0];
    } else {
      const where = places.mercator(pinned.geo);
      if (!where) return;
      pan.current = {
        x: pan.current.x + (pinned.at[0] - where[0]),
        y: pan.current.y + (pinned.at[1] - where[1]),
      };
    }

    /*
     * Fit again, because the correction just moved the thing the projections
     * were built from. Leaving it to the next frame was the bug that made
     * anchoring look broken: the scale had changed but the rotation had not
     * been applied, so every notch drew one frame of un-anchored zoom.
     */
    fit();
  }

  /**
   * One frame of the scale easing towards its target.
   *
   * Reached through a ref from the frame loop: the loop is started once, when
   * something begins moving, and this function is rebuilt on every render — so
   * a direct call there would freeze on whichever copy existed when the
   * gesture started.
   */
  function stepZoom(elapsed: number) {
    if (zoom.current === zoomTarget.current) return false;
    applyZoom(approach(zoom.current, zoomTarget.current, elapsed));
    if (zoom.current === zoomTarget.current) {
      anchor.current = null;
      // The glide just reached its target on its own — the same "a gesture
      // that changed rotation just stopped" moment `endGesture` notices for a
      // drag. See `forcesDegrade` for why the rebuild this unblocks has to
      // wait one settle beat rather than land in this frame.
      scheduleSettle();
    }
    return true;
  }

  /**
   * The end of a glide, put where the gesture asked for rather than a hair
   * short of it.
   *
   * `approach` is an exponential and an exponential never arrives, so it snaps
   * once the remainder is under a twentieth of a percent of the target. That is
   * small and it is not nothing: measured after a sixteen-notch wheel zoom, the
   * loop shut down with the scale 0.022 short of 24.51, which on the globe of
   * the day — a radius of `0.42 x 460 x zoom` — was 1.3 px of the reader's
   * frame, and is more on the larger one this row carries now. The map then
   * sat there — until a country's subdivisions landed a second later, woke the
   * frame loop for the fade, and the loop picked the abandoned glide back up.
   * So the reader's whole view crept a pixel at a time *while* the detail was
   * fading in, which is two movements where the map means to show one, and it
   * also made every frame of that fade a different view.
   *
   * Snapping here rather than lengthening the 320 ms: the loop is switched off
   * because the gesture is over, and the honest thing for a gesture that is over
   * is to be where it was aimed.
   *
   * It draws before it lets go, and it has to. This runs in the same tick that
   * stops the frame loop, so nothing else is going to paint: `draw` is a
   * `useCallback` over inputs that a wheel gesture does not change, so the
   * effect that watches it will not fire, and the loop's own cleanup cancels the
   * frame that would otherwise have caught up. Without this the canvas would
   * keep the scale the loop abandoned while the arcs and the place names took
   * the corrected one — the map sliding a pixel out from under its own labels,
   * which is the exact fault `flushSync` is in the frame loop to prevent.
   */
  function endGlide() {
    if (zoom.current === zoomTarget.current) return;
    applyZoom(zoomTarget.current);
    anchor.current = null;
    // Forcing the snap here is itself the glide ending — `stepZoom` never got
    // to notice it on its own, so this is the only place that will.
    scheduleSettle();
    draw();
    commit();
  }

  /** Ask for a new scale, pinned to a point, and let the easing take it there. */
  function aimZoom(factor: number, at: [number, number]) {
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, zoomTarget.current * factor));
    if (next === zoomTarget.current) return false;

    const shown = projection === 'globe' ? places.globe : places.mercator;
    const geo = shown.invert?.(at);
    if (geo && Number.isFinite(geo[0]) && Number.isFinite(geo[1])) {
      anchor.current = { at, geo: [geo[0], geo[1]] };
    }
    zoomTarget.current = next;
    // One step straight away, so the map answers a notch in the frame it
    // arrived in rather than only once the loop wakes.
    stepZoom(16);
    noteMoved();
    return true;
  }

  /*
   * The loop is kept alive for a moment after the last notch, so the frames
   * during a wheel gesture come from the same place a drag's do — one draw and
   * one synchronous commit per frame — instead of one render per event.
   */
  const wheelStop = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * The handler goes through a ref so the listener itself can be attached
   * once. It closes over `zoomAbout`, which is rebuilt on every render — an
   * effect with no dependency array would therefore detach and reattach a
   * listener sixty times a second during a drag, on the one component whose
   * whole point is that a drag stays smooth.
   */
  function onWheel(event: WheelEvent) {
    event.preventDefault();
    // Exponential in the delta, so a trackpad's few pixels and a mouse notch's
    // hundred read as the same gesture at different speeds.
    const factor = Math.exp(-event.deltaY * WHEEL_RATE);
    if (!aimZoom(factor, [event.offsetX, event.offsetY])) return;
    setMoving(true);
    if (wheelStop.current) clearTimeout(wheelStop.current);
    // Four and a half time constants past the last notch, which is 99% of the
    // way — and `endGlide` puts the last 1% where it was going rather than
    // leaving it to whatever wakes the loop next.
    wheelStop.current = setTimeout(() => {
      latestEnd.current();
      setMoving(false);
    }, 320);
  }

  /*
   * The three above brought up to date once the render they belong to has
   * committed, rather than partway through it.
   *
   * Same reason as `drawn` and `resolvedEver`: a render that writes to a ref
   * is a render with a side effect. Nothing can read a stale one in between —
   * a layout effect runs before the browser paints, and the only readers are a
   * `requestAnimationFrame` callback and a `setTimeout`, neither of which can
   * be reached without the browser getting a turn first.
   */
  useLayoutEffect(() => {
    latestStep.current = stepZoom;
    latestEnd.current = endGlide;
    latestWheel.current = onWheel;
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Attached by hand rather than through `onWheel`: React registers wheel
    // listeners passively, and a passive listener cannot stop the page
    // scrolling underneath the map.
    const listener = (event: WheelEvent) => latestWheel.current(event);
    stage.addEventListener('wheel', listener, { passive: false });
    return () => {
      stage.removeEventListener('wheel', listener);
      if (wheelStop.current) clearTimeout(wheelStop.current);
    };
  }, []);

  /**
   * One rung of zoom about the middle of the frame, eased like a wheel notch.
   *
   * The middle is not a compromise, it is the only honest anchor a control
   * that is not a pointer has: a key press and a button press say how far, not
   * where, and picking any other point would be inventing a place the reader
   * did not indicate. It is also what makes these two the same gesture as the
   * wheel rather than a second mechanism: the 320ms grace and the `endGlide`
   * that closes it are `onWheel`'s own ending, borrowed whole rather than
   * reimplemented at a second size.
   */
  function stepFromCentre(factor: number) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (!aimZoom(factor, [rect.width / 2, rect.height / 2])) return;
    setMoving(true);
    if (wheelStop.current) clearTimeout(wheelStop.current);
    wheelStop.current = setTimeout(() => {
      latestEnd.current();
      setMoving(false);
    }, 320);
    draw();
    commit();
  }

  /*
   * The wheel is not the only pointer, and it is no pointer at all for someone
   * on a keyboard. `+` and `-` on the focused map are what keeps zoom
   * reachable without one, and they reach it by exactly the route the two
   * on-screen controls do.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === '+' || event.key === '=' ? ZOOM_STEP : event.key === '-' ? 1 / ZOOM_STEP : null;
    if (step === null) return;
    event.preventDefault();
    stepFromCentre(step);
  }

  function reset() {
    rotation.current = [...HOME];
    pan.current = { x: 0, y: 0 };
    zoom.current = 1;
    zoomTarget.current = 1;
    anchor.current = null;
    noteMoved();
    draw();
    commit();
  }

  /* ----------------------------------------------------------------- svg -- */

  const isGlobe = projection === 'globe';
  // Through the glass on a globe; a flat map has no far side to see through.
  const place: GeoProjection = isGlobe ? painted.places.glass : painted.places.mercator;
  const svgPath = geoPath(place);
  const centre = painted.rotation;
  const surfaceOpacity = (point: LngLat) => (isGlobe ? limbFade(point, centre) : 1);

  /**
   * The stretches of an arc that are actually drawn, and how far along the
   * whole arc each one starts.
   *
   * On the globe, the near ones only. The split still happens — it is what
   * makes the line stop cleanly at the limb instead of at whichever sample
   * happened to fall there — but the far half is dropped rather than dimmed.
   * A faint line crossing the back of the globe reads as a line on the front,
   * and it crosses everything genuinely in front of it on the way. The
   * airports stay: a dot is a place, and knowing an endpoint is round the back
   * is worth something. A curve through it is not.
   *
   * `before` is what turns those several paths back into one flowing line.
   * The stretches that were dropped still count towards it: the dash pattern
   * is laid along the whole great circle, so a run that comes back into view
   * at the far limb picks up the phase the hidden one carried round the back,
   * and the pattern is continuous through a gap the reader cannot see. Without
   * it every fragment starts its dashes at zero and a cut route reads as two
   * unrelated lines that happen to touch the horizon.
   *
   * Lengths are measured on screen rather than on the sphere, because that is
   * where the dashes are: the projection foreshortens an arc hard as it nears
   * the limb, and a phase in radians would bunch the pattern up exactly there.
   * Only the globe needs any of this — the flat map's arcs are solid.
   */
  function runsFor(coordinates: LngLat[]) {
    if (!isGlobe) return [{ points: coordinates, before: 0, opacity: 1 }];
    const drawn: { points: LngLat[]; before: number; opacity: number }[] = [];
    let before = 0;
    for (const run of splitByHorizon(coordinates, centre)) {
      if (run.near) {
        const middle = run.points[Math.floor(run.points.length / 2)];
        drawn.push({ points: run.points, before, opacity: surfaceOpacity(middle) });
      }
      before += polylineLength(
        run.points.flatMap((point) => {
          const xy = place(point);
          return xy ? [xy] : [];
        }),
      );
    }
    return drawn;
  }

  /* --------------------------------------------------------------- names -- */

  /*
   * Continents when you are looking at the world, countries once you have
   * closed in far enough for a border to mean anything — and each name fading
   * rather than blinking, whether it is leaving round the back of the globe or
   * arriving because there is finally room for it.
   *
   * Recomputed every frame on purpose. That is what makes the fade come from
   * the geometry itself: at 60 frames a second the opacity is a continuous
   * function of where the globe is pointing, which no amount of CSS on a
   * mounting and unmounting node can imitate.
   */
  const frame = painted.size;
  const view: View = { globe: isGlobe, scale: place.scale(), rotation: centre };

  type MapName = Boxed & { key: string; text: string; opacity: number; tier: NameTier };
  const names: MapName[] = [];

  /**
   * One name offered to the map, under an identity that is its own.
   *
   * `id` rather than the text, and the two are only the same thing at the top
   * two rungs. Seven continents and 177 countries are each named once; a
   * viewport's worth of subdivisions is not — Misiones is a province of
   * Argentina and a department of Paraguay, and at 20x both are on screen with
   * 67px between them. Two React children under one key is unsupported, and
   * what React 19 actually does with it is leave one of the two `<text>` nodes
   * behind on every commit that drops it: measured in the browser, one drag
   * across the Argentine-Paraguayan border left **eight** `Misiones` labels
   * scattered over Brazil and the South Atlantic, none of them anywhere near
   * the province, none of them ever moving again. That is the bug the reader
   * reported as names getting stuck on the globe.
   */
  function offer(id: string, name: MapName['text'], at: LngLat, strength: number, tier: NameTier) {
    let opacity = strength;
    if (isGlobe) opacity *= limbFade(at, centre);
    if (opacity <= 0.01) return;
    const xy = place(at);
    if (!xy) return;
    const box = nameBox(name, tier);
    // Off the frame, or too close to its edge to be read whole. Worth doing:
    // zoomed in, most of the world is off the frame, and the map's stage clips
    // — which is how Bolivia came to render as `Bolivi`.
    const inside = nudgeIntoFrame(xy, box, frame);
    if (!inside) return;
    names.push({
      key: `${NAME_TIERS[tier].key}:${id}`,
      text: name,
      x: inside[0],
      y: inside[1],
      width: box.width,
      height: box.height,
      opacity,
      tier,
    });
  }

  /*
   * The airport codes claim their ground first and never lose it. They are the
   * data the map exists for; a continent name printed across LIM is decoration
   * covering the thing being decorated.
   */
  const claimed: Boxed[] = [];
  for (const { route } of arcs) {
    for (const [point, code] of [
      [route.from, route.origin],
      [route.to, route.destination],
    ] as const) {
      const xy = place(point);
      if (!xy) continue;
      // Matching the dot and the code drawn below: left-anchored at `x + 9`.
      const width = 12 + code.length * 6.4;
      claimed.push({ x: xy[0] + 3 + width / 2, y: xy[1] + 3.5, width, height: 17 });
    }
  }
  for (const { point, code } of stopNodes) {
    const xy = place(point);
    if (!xy) continue;
    const width = 12 + code.length * 6.4;
    claimed.push({ x: xy[0] + 3 + width / 2, y: xy[1] + 3.5, width, height: 17 });
  }

  const continents = continentFade(painted.zoom) * 0.55;
  for (const continent of CONTINENTS)
    offer(continent.name, continent.name, continent.at, continents, 'continent');

  /*
   * A country whose subdivisions are on screen gives its name up to them, and
   * only those countries do.
   *
   * Every other country on screen keeps whatever `countryFade` gives it,
   * because its subdivisions have not been fetched and drawing none while
   * withdrawing the name would leave a blank shape. **That is also the whole
   * of how this map stays honest at the edge of its budget.** A country the
   * fan-out would not stretch to is in exactly the same position as one
   * Natural Earth does not divide and one that has not landed yet: it keeps
   * its name. So every country on screen is either showing its subdivisions
   * and has given up its name to them, or is showing its name — there is no
   * third state, and a reader can read off the map which countries it drew in
   * detail without being told a number to trust.
   */
  const handover = subdivisionFade(painted.zoom);
  const naming = new Map(
    subdivisions
      .filter((each) => each.labels.length > 0)
      .map((each) => [each.country, painted.fades.get(each.country) ?? 0] as const),
  );
  const countries = countryFade(painted.zoom) * 0.72;
  for (const country of COUNTRIES) {
    if (countries <= 0.01) break;
    const room = roomFade(screenArea(country.area, country.at, view));
    if (room <= 0) continue;
    // `handover * arrival`, so a country lets go of its name at exactly the
    // rate its own borders are coming up underneath it. The two are one
    // gesture rather than two: at any instant of the arrival the name has
    // `1 - handover x arrival` and the borders have `inner x arrival`.
    const arriving = (country.id !== null && naming.get(country.id)) || 0;
    offer(
      country.name,
      country.name,
      country.at,
      room * countries * (1 - handover * arriving),
      'country',
    );
  }

  /*
   * And the rung below, on the same terms as the one above it — the same
   * `screenArea`, the same `roomFade`, the same claimed ground — except for
   * what "enough room" means, which is `roomForName` rather than the flat
   * `LABEL_ROOM` the country rung uses.
   *
   * The reason is that at this rung the reader has already asked to see inside
   * one country, and a border with no name on it is the thing they zoomed in
   * to read. A flat threshold asks the same of `Ica` as of `Madre de Dios`,
   * which is fair when every name is about the same size and false here: it
   * refuses seventeen of Peru's twenty-six departments that could carry their
   * names, and it prints `Aisén del General Carlos Ibáñez del Campo` — 229px
   * of it — across ground 77px wide. Sizing the threshold from the name fixes
   * both ends at once.
   *
   * Offered last, so a country name still half-lit at the crossover keeps its
   * ground and the incoming names arrange themselves around it.
   *
   * Across countries as well as within one, and sorted so it is one rung
   * rather than several: the served files each order their own units biggest
   * first, but a fan-out hands over several of them, and offering Peru's
   * smallest department before Bolivia's largest would let the smaller place
   * take ground from the bigger one purely because its country was fetched
   * first.
   */
  if (handover > 0.01 && subdivisions.length > 0) {
    const units = subdivisions.flatMap((each) =>
      // The country's own arrival carried on each of its units, so a fan-out
      // that lands one country at a time reads as a wave rather than as a run
      // of separate pops.
      each.labels.map((label) => ({ label, arriving: painted.fades.get(each.country) ?? 0 })),
    );
    if (subdivisions.length > 1) units.sort((left, right) => right.label.area - left.label.area);
    for (const { label: unit, arriving } of units) {
      const box = nameBox(unit.name, 'subdivision');
      const room = roomFade(
        screenArea(unit.area, unit.at, view),
        roomForName(box.width, box.height),
      );
      if (room <= 0) continue;
      offer(unit.key, unit.name, unit.at, room * handover * 0.72 * arriving, 'subdivision');
    }
  }
  // Offered biggest first, so a bigger place keeps the ground it stands on.
  const shown = withoutOverlaps(names, claimed);

  return (
    <div className={styles.map}>
      <div className={styles.toolbar}>
        <div className={styles.switch} role="group" aria-label="Map projection">
          {(['globe', 'mercator'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={projection === option}
              onClick={() => onProjectionChange(option)}
            >
              {option === 'globe' ? 'Globe' : 'Mercator'}
            </button>
          ))}
        </div>

        {/*
          Plus and minus are back, and they are in the stage rather than here —
          see `styles.controls` below for what they are and this for why.

          They were taken off on two grounds. The first was feel: two buttons
          that step the scale by a fixed factor are the mechanical map this one
          was built away from. That ground still holds and is kept — a press
          goes through `stepFromCentre` into the same eased glide a wheel notch
          takes, so 1.3 is where the scale arrives, not what the next frame
          shows. The second was that the wheel does it continuously and about
          the cursor, and `+` and `-` on the focused map do it for anyone
          without one. That one assumed every reader has a wheel or a keyboard,
          and a phone has neither: since `the-five-pages-on-a-phone` the stage
          is 260px on a narrow viewport, on a widget whose range runs to 32x,
          and `touch-action: none` means even the browser's own pinch is gone.
          A reader on a phone was hard-locked at 1x.

          Two fingers are the answer to the gesture and these are the answer to
          the rest of it. They are shown at every width, not only the narrow
          ones. A pinch needs two working fingers and a screen that reports
          them; the reader on a tablet in landscape, and the reader who can
          bring one finger to the glass at a time, are both past 640px and
          neither has a wheel. Hiding a control behind a viewport width is
          guessing at what the reader's hands can do from how wide their window
          is, and this is the one route on the map that asks nothing of them.
        */}
        {/*
          The right end of the strip: whatever the page handed over, then Reset.
          Grouped rather than left to `space-between`, which with three children
          would put the status in the middle of the toolbar — a status is not a
          control and does not belong between two of them.
        */}
        <div className={styles.tools}>
          {status}
          <Button
            variant="ghost"
            size="small"
            onClick={reset}
            disabled={!moved}
            aria-label="Reset the view"
          >
            Reset
          </Button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={`${styles.stage} ${styles.grabbable}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="application"
        /*
         * What is actually here, on whatever the reader is holding. The old
         * label promised a scroll wheel and two keys to a phone, which has
         * neither — and named nothing a finger could do.
         */
        aria-label="Route map. Drag to move. Pinch, scroll, use the zoom buttons, or press plus and minus to zoom."
      >
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
        <svg
          className={`${styles.overlay} ${moving ? '' : styles.settled}`}
          viewBox={`0 0 ${painted.size.width || 1} ${painted.size.height || 1}`}
          role="list"
          aria-label="Watched routes"
        >
          {/* Place names first, so one never sits on top of the data. */}
          {shown.map((name) => (
            <text
              key={name.key}
              x={name.x}
              y={name.y}
              className={styles[name.tier]}
              style={{ opacity: name.opacity }}
              aria-hidden="true"
            >
              {name.text}
            </text>
          ))}

          {arcs.map(({ route, line }) => {
            /*
             * `wearing`, not `leading` — the first watch in watchlist order,
             * and the one thing about this arc that nothing moves.
             * `colour-holds-the-first-watch`: the owner asked for the dashes
             * to run the way of the route they have selected and said in the
             * same breath that the colour must not change, so an arc now
             * points at one watch and is coloured for another, which
             * `arc-wears-its-leading-watch` was written to forbid and which
             * supersedes it.
             *
             * Colouring by `leading` is what that leaves behind, and it is
             * what the owner rejected: the line would change colour when they
             * clicked between the two legs of a pair, and again on its own
             * whenever a collection finished on an arc they had not opened.
             * Blending the two watches' colours stays rejected on its original
             * ground — the blend is a colour no row carries, so the swatch
             * stops being an index into the map at all rather than only for
             * one row of a both-ways pair.
             *
             * Nothing here decides any of it. The geometry arrives already
             * pointed and already assigned, and this file reads the field.
             */
            const stroke = colours.get(route.wearing) ?? DEFAULT_ARC;
            // Open if *any* of this arc's watches is the open one. One line
            // stands for both, so it thickens for either — the alternative is
            // an arc that is plainly the reader's route and does not look it.
            const open = route.watches.some((watch) => watch.id === selectedId);
            /*
             * The open route's dashes move, and so do the ones on whichever
             * arc collected most recently. Only on the globe.
             *
             * The flat map's arcs are solid and have nothing to flow; the
             * others are dashed and still. This used to be the open route
             * alone, and the second case is what makes a collection landing
             * visible without the reader having opened anything —
             * `freshest-arc-flows-too`. It is bounded at two arcs by
             * construction, one open and one fresh, and usually they are the
             * same arc; 12.70's objection was to nine at once.
             *
             * Selecting the collected route instead was rejected: a pass
             * finishing in the background would have pulled the chart out from
             * under whatever the reader was reading.
             */
            const flowing =
              isGlobe && (open || route.watches.some((watch) => watch.id === lastCollectedId));
            return (
              <g key={route.id} role="listitem">
                {runsFor(line.coordinates).map((run, index) => {
                  const d = svgPath({ type: 'LineString', coordinates: run.points } as never);
                  if (!d) return null;
                  return (
                    <g key={index}>
                      {/*
                        A wide invisible twin, so a 1.6px arc is something a
                        pointer can hit. Every run reaching here is a near one
                        — the far side is not drawn at all, and picking a line
                        you are looking at the back of would mean picking it
                        over whatever is genuinely in front of it.
                      */}
                      {/*
                        `nextWatch` rather than a fixed id, so the whole of
                        `arc-click-cycles-its-watches` is decided here, at
                        render, where `selectedId` is already known. The
                        pointer code below reads this attribute and passes it
                        on untouched, which is what keeps a rule about
                        watchlists out of a gesture handler.
                      */}
                      <path
                        d={d}
                        className={styles.hit}
                        data-route={nextWatch(route, selectedId)}
                        aria-hidden="true"
                      />
                      <path
                        d={d}
                        // The delay is the phase, and the phase is what makes
                        // a route the limb has cut in two flow as one line
                        // rather than as two clocks. Inline because it is
                        // geometry, recomputed with the geometry: a stylesheet
                        // cannot know how far along its own arc a run begins.
                        // `color` rides along with `stroke` only so `.flow`'s
                        // glow can pick it up as `currentColor` — it paints
                        // nothing of its own, the arc has no text or border to
                        // inherit it.
                        style={
                          flowing
                            ? {
                                stroke,
                                color: stroke,
                                opacity: run.opacity,
                                animationDelay: flowDelay(run.before),
                              }
                            : { stroke, opacity: run.opacity }
                        }
                        className={[
                          styles.arc,
                          // Dashed on the globe, where the surface is curved
                          // and busy; solid on the flat map, where a dash only
                          // fragments a line that already reads. Only a dash
                          // can show flow, so only the globe's arcs do.
                          isGlobe ? styles.dashed : '',
                          // And only the open one of those. Nine arcs all
                          // flowing at once is a page of moving parts with no
                          // one of them pointed at; one is a direction.
                          flowing ? styles.flow : '',
                          open ? styles.active : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        /*
                         * The name follows the **direction**, not the colour,
                         * and that is a choice rather than a leftover.
                         *
                         * A name is a description of what is on screen, and
                         * what is on screen is a line drawn from one airport
                         * to another. "Lima to Santiago" over a line running
                         * Santiago to Lima would be false about the only thing
                         * this element is — and a reader who cannot see the
                         * dashes move has no other way to learn which way it
                         * runs, which is precisely why the direction is worth
                         * saying out loud.
                         *
                         * What it costs, now that `colour-holds-the-first-
                         * watch` has pinned the colour elsewhere: on a
                         * both-ways pair the name and the swatch can point at
                         * different rows of the watchlist, so the two readings
                         * of the same arc do not meet. `, watched both ways`
                         * is what keeps that honest rather than merely
                         * inconsistent — it says the line stands for two
                         * watches, so neither reading is claiming to be the
                         * whole of it. The name also changes when the reader
                         * selects the other leg, which the colour no longer
                         * does; a name pinned to `wearing` would have been
                         * steady and wrong.
                         */
                        aria-label={
                          index === 0
                            ? `${route.fromCity ?? route.origin} to ${route.toCity ?? route.destination}${
                                route.bothWays ? ', watched both ways' : ''
                              }`
                            : undefined
                        }
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}

          {stops.map(({ id, colour, line }) =>
            runsFor(line.coordinates).map((run, index) => {
              const d = svgPath({ type: 'LineString', coordinates: run.points } as never);
              return d ? (
                <path
                  key={`${id}:${index}`}
                  d={d}
                  style={{
                    stroke: colour,
                    color: colour,
                    opacity: run.opacity,
                    animationDelay: flowDelay(run.before),
                  }}
                  className={[
                    styles.arc,
                    styles.stop,
                    // Stops are the exception to the flat-map rule: their
                    // breaks name an itinerary, not depth, so they stay
                    // dashed in either projection.
                    styles.dashed,
                    isGlobe ? styles.flow : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-hidden="true"
                />
              ) : null;
            }),
          )}

          {stopNodes.map(({ id, point, code, colour }) => {
            const xy = place(point);
            if (!xy) return null;
            return (
              <g key={id} style={{ opacity: surfaceOpacity(point) }}>
                <circle
                  cx={xy[0]}
                  cy={xy[1]}
                  r={4}
                  style={{ fill: colour }}
                  className={styles.node}
                />
                <text x={xy[0] + 9} y={xy[1] + 3.5} className={styles.label}>
                  {code}
                </text>
              </g>
            );
          })}

          {arcs.flatMap(({ route }) =>
            (
              [
                [route.from, route.origin, true],
                [route.to, route.destination, false],
              ] as const
            ).map(([point, code, isOrigin]) => {
              const xy = place(point);
              if (!xy) return null;
              /*
               * A departure, and on a pair watched both ways both ends are one
               * — `a-both-ways-pair-has-two-homes`.
               *
               * Letting the marker follow the flow instead was tried on paper
               * and is worse than it sounds. Lima carries every other arc on
               * this page, each drawing its own neutral dot there; one arc
               * flipping to point *at* Lima would drop a smaller coloured dot
               * on top of that stack, and which of them ended up on top would
               * come down to where the return leg happened to sit in the
               * watchlist. Both ends neutral is also simply true: both are
               * places this reader is watching a flight leave from.
               */
              const departure = isOrigin || route.bothWays;
              return (
                <g key={`${route.id}-${code}`} style={{ opacity: surfaceOpacity(point) }}>
                  <circle
                    cx={xy[0]}
                    cy={xy[1]}
                    r={departure ? 4.6 : 4}
                    // A departure stays neutral: every route on this page
                    // leaves from one, so colouring it would claim it belongs
                    // to a single arc.
                    // `wearing` again, and for the same reason the line uses
                    // it: an arrival dot that changed colour when the reader
                    // clicked would be the stroke's fault repeated at 4px.
                    style={
                      departure ? undefined : { fill: colours.get(route.wearing) ?? DEFAULT_ARC }
                    }
                    className={departure ? styles.home : styles.node}
                  />
                  {/*
                    Nine, not the seven it was. The ring is now painted outside
                    the fill rather than half over it, so the marker's outer
                    radius went from 5.4 to 6.2 at the origin — at `x + 7` the
                    code would have been sitting 0.8 units off the ring, closer
                    than it has ever been. Nine keeps the gap it had.
                  */}
                  <text x={xy[0] + 9} y={xy[1] + 3.5} className={styles.label}>
                    {code}
                  </text>
                </g>
              );
            }),
          )}
        </svg>

        {/*
          Chrome, not map. It sits inside the stage — the same place the
          Finance canvas keeps its own pair — so it stays in the corner of the
          picture the reader is zooming rather than a toolbar's width away
          from it, and so a phone can reach it with the thumb already on the
          globe.

          It stops its own presses. Every pointer that goes down in the stage
          turns the globe or opens a route, and a press on a control is
          neither; without this, tapping `+` would start a rotate under the
          button and the map would drift while the scale changed.
        */}
        <div className={styles.controls} onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className={styles.control}
            aria-label="Zoom out"
            onClick={() => stepFromCentre(1 / ZOOM_STEP)}
          >
            −
          </button>
          <button
            type="button"
            className={styles.control}
            aria-label="Zoom in"
            onClick={() => stepFromCentre(ZOOM_STEP)}
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}
