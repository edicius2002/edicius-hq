import { geoMercator, geoOrthographic, geoPath, type GeoProjection } from 'd3-geo';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { feature, mesh } from 'topojson-client';
import versor from 'versor';
import worldAtlas from 'world-atlas/countries-110m.json';

import { flowDelay, polylineLength } from '@/features/airfare/lib/arcFlow';
import {
  facesViewer,
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
import { planFanOut } from '@/features/airfare/lib/fanOut';
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
  ROTATE_REBUILD_MS,
  decideReuse,
  type CachedGeometry,
  type Matrix2D,
  type ProjectionSnapshot,
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
  const [tick, repaint] = useState(0);

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
  drawn.current = subdivisions.map((each) => each.country);

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
  const served = useRef(new Map<string, CachedGeometry<Subdivisions> & { land: Path2D; borders: Path2D }>());
  /** Whether any country is still fading in, which is the only thing that keeps the loop awake. */
  const [arriving, setArriving] = useState(false);

  /**
   * Motion the reader has asked not to see.
   *
   * Read here rather than in the stylesheet because this fade is computed in
   * JavaScript, so the `prefers-reduced-motion` block that stops the arcs
   * flowing cannot reach it. Read once: a reader does not change this setting
   * mid-drag, and `matchMedia` in the render body would run sixty times a
   * second.
   */
  const stillness = useRef<boolean | null>(null);
  if (stillness.current === null) {
    stillness.current =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;
  }

  /** How far into its arrival a country is, from 0 to 1. */
  const arrivalFade = useCallback((country: string, at: number) => {
    const since = arrivedAt.current.get(country);
    if (since === undefined) return 0;
    if (stillness.current) return 1;
    return Math.min(1, (at - since) / ARRIVAL_MS);
  }, []);

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
    let fresh = false;
    for (const country of here) {
      if (arrivedAt.current.has(country)) continue;
      arrivedAt.current.set(country, at);
      fresh = true;
    }
    if (fresh && !stillness.current) setArriving(true);
  }, [subdivisions]);

  /**
   * The coarse shapes the finer ones replace, and everything that touches them.
   *
   * All of it comes off the bundled atlas and none of it changes while the
   * same set of countries is drawn, so this is worked out when that set moves
   * and not once a frame — the neighbour search walks all 177 bounding boxes
   * once per country, which is nothing on a settle and real work sixty times a
   * second.
   */
  const coarse = useMemo(() => {
    const found = outlinesOf(swapped ? swapped.split(',') : []);
    // Indexed on the same terms as everything else the map draws. The clipped
    // shapes are the countries the reader zoomed into and are on screen by
    // construction; the neighbours are whatever the bounding-box sweep swept
    // up, which over Europe is most of the continent.
    return { shapes: found.shapes, neighbours: capped(found.neighbours as never[]) };
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

  const projections = useRef({
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
  });

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
    for (const globe of [projections.current.globe, projections.current.glass]) {
      globe.translate(middle).scale(radius).rotate(rotation.current);
    }

    // Zoom multiplies the *unzoomed* fit rather than being capped by it. The
    // old form took `min(width / 2π, radius * 0.6)` with the zoom already
    // inside `radius`, so the cap — which is exactly the scale that fits 360°
    // of longitude across the frame — bit at about 1.1× and the flat map
    // stopped zooming there while the globe went on to 8×.
    const mercator = projections.current.mercator;
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
  }, []);

  const draw = useCallback(() => {
    const fitted = fit();
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!fitted || !canvas || !stage) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const { rect, dpr } = fitted;
    const shown: GeoProjection =
      projection === 'globe' ? projections.current.globe : projections.current.mercator;
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
        const [cx, cy] = projections.current.globe.translate();
        const radius = projections.current.globe.scale();
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
      const [cx, cy] = projections.current.globe.translate();
      const radius = projections.current.globe.scale();
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
     * `ROTATE_REBUILD_MS` before they are worth reprojecting again, the same
     * kind of bounded trade `SETTLE_MS` and `ARRIVAL_MS` already make between
     * showing the latest thing and showing anything smoothly at all.
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
      rotation: shown.rotate() as [number, number, number],
      scale: shown.scale(),
      translate: shown.translate() as [number, number],
    };
    const now = performance.now();
    const held = served.current;
    const matrices = new Map<string, Matrix2D>();
    for (const country of held.keys()) {
      if (!subdivisions.some((each) => each.country === country)) held.delete(country);
    }
    for (const each of subdivisions) {
      const had = held.get(each.country);
      const includedLand = each.landParts.map((part) => onScreen(part.cap));
      const includedBorders = each.borderRuns.map((run) => onScreen(run.cap));
      const decision = decideReuse(had, each, snapshot, now, ROTATE_REBUILD_MS, includedLand, includedBorders);

      if (decision.kind === 'reuse') {
        matrices.set(each.country, decision.matrix);
        continue;
      }
      if (decision.kind === 'stale') {
        // Kept exactly as it was built — see the comment above for why a
        // rotation change cannot be answered with a matrix — so it is drawn
        // unmoved rather than reprojected again this frame.
        matrices.set(each.country, IDENTITY_MATRIX);
        continue;
      }

      const landPath = new Path2D();
      const intoLand = geoPath(shown, landPath as unknown as CanvasRenderingContext2D);
      for (const [index, part] of each.landParts.entries()) if (includedLand[index]) intoLand(part.shape);
      const bordersPath = new Path2D();
      const intoBorders = geoPath(shown, bordersPath as unknown as CanvasRenderingContext2D);
      for (const [index, run] of each.borderRuns.entries()) if (includedBorders[index]) intoBorders(run.shape);
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
     */
    const inner = subdivisionFade(zoom.current);
    const inside =
      inner > 0
        ? subdivisions.filter(
            (each): each is Subdivisions & { borders: NonNullable<Subdivisions['borders']> } =>
              each.borders !== null,
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
  }, [fit, projection, subdivisions, coarse, boundaries, arrivalFade]);

  useEffect(() => {
    draw();
    repaint((count) => count + 1);
  }, [draw]);

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
   * `tick` is in the dependencies as the map's own "something was drawn"
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
    const handle = setTimeout(
      () => {
        const rect = stageRef.current?.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) return;
        const shown =
          projection === 'globe' ? projections.current.globe : projections.current.mercator;
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
        // Same set, same array: `useQueries` builds one query per entry and the
        // map keys its canvas work off what comes back, so handing back a new
        // array of the same ids would restart both for nothing.
        setWanted((was) =>
          was.length === plan.countries.length && was.every((id, at) => id === plan.countries[at])
            ? was
            : plan.countries,
        );
      },
      first ? 0 : SETTLE_MS,
    );
    return () => clearTimeout(handle);
  }, [moving, tick, projection, catalogue]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      draw();
      repaint((count) => count + 1);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [draw]);

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
      const landed = drawn.current.every((country) => arrivalFade(country, performance.now()) >= 1);
      flushSync(() => {
        repaint((count) => count + 1);
        // Switched off only once every country is fully lit, so the frame that
        // stops the loop is already the frame that finished the fade — there
        // is nothing left to draw after it.
        if (landed) setArriving(false);
      });
      requestAnimationFrame(tick);
    };
    const handle = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(handle);
    };
  }, [moving, arriving, draw, arrivalFade]);

  /* --------------------------------------------------------------- input -- */

  type Gesture =
    | {
        kind: 'rotate';
        v0: [number, number, number];
        q0: [number, number, number, number];
        r0: [number, number, number];
      }
    | { kind: 'pan'; x: number; y: number; from: { x: number; y: number } };

  const gesture = useRef<Gesture | null>(null);

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

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const { offsetX, offsetY } = event.nativeEvent;
    const target = event.target as Element | null;
    pressed.current = {
      route: target?.getAttribute?.('data-route') ?? null,
      x: offsetX,
      y: offsetY,
    };
    if (projection === 'globe') {
      const inverted = projections.current.globe.invert?.([offsetX, offsetY]);
      if (!inverted) return;
      gesture.current = {
        kind: 'rotate',
        v0: versor.cartesian(inverted),
        q0: versor(rotation.current),
        r0: [...rotation.current] as [number, number, number],
      };
    } else {
      // A flat map has no rotation to speak of, so dragging moves it instead.
      gesture.current = { kind: 'pan', x: offsetX, y: offsetY, from: { ...pan.current } };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setMoving(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const held = gesture.current;
    if (!held) return;
    const { offsetX, offsetY } = event.nativeEvent;

    if (held.kind === 'pan') {
      // Free in both directions; `fit` clamps it to the map's own edges, which
      // at the default zoom leaves only up and down reachable.
      pan.current = { x: held.from.x + (offsetX - held.x), y: held.from.y + (offsetY - held.y) };
      return;
    }

    const inverted = projections.current.globe.rotate(held.r0).invert?.([offsetX, offsetY]);
    if (!inverted) return;
    const next = versor.rotation(
      versor.multiply(held.q0, versor.delta(held.v0, versor.cartesian(inverted))),
    );
    // The third angle is dropped so the horizon stays level. Letting it drift
    // makes the globe feel like it is tumbling rather than turning.
    rotation.current = [next[0], next[1], 0];
  }

  /** A press that has not travelled far enough to be a drag. */
  const STILL = 4;

  function endGesture(event: React.PointerEvent<HTMLDivElement>) {
    const press = pressed.current;
    pressed.current = null;
    if (press?.route) {
      const { offsetX, offsetY } = event.nativeEvent;
      if (Math.hypot(offsetX - press.x, offsetY - press.y) <= STILL) onSelect(press.route);
    }
    if (!gesture.current) return;
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setMoving(false);
    draw();
    repaint((count) => count + 1);
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

    const pinned = anchor.current;
    if (!pinned) return;

    if (projection === 'globe') {
      const nowThere = projections.current.globe.invert?.(pinned.at);
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
      const where = projections.current.mercator(pinned.geo);
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
    if (zoom.current === zoomTarget.current) anchor.current = null;
    return true;
  }

  const latestStep = useRef(stepZoom);
  latestStep.current = stepZoom;

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
    draw();
    repaint((count) => count + 1);
  }
  const latestEnd = useRef(endGlide);
  latestEnd.current = endGlide;

  /** Ask for a new scale, pinned to a point, and let the easing take it there. */
  function aimZoom(factor: number, at: [number, number]) {
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, zoomTarget.current * factor));
    if (next === zoomTarget.current) return false;

    const shown = projection === 'globe' ? projections.current.globe : projections.current.mercator;
    const geo = shown.invert?.(at);
    if (geo && Number.isFinite(geo[0]) && Number.isFinite(geo[1])) {
      anchor.current = { at, geo: [geo[0], geo[1]] };
    }
    zoomTarget.current = next;
    // One step straight away, so the map answers a notch in the frame it
    // arrived in rather than only once the loop wakes.
    stepZoom(16);
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
  const onWheel = (event: WheelEvent) => {
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
  };
  const latestWheel = useRef(onWheel);
  latestWheel.current = onWheel;

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

  /*
   * The wheel is not the only pointer, and it is no pointer at all for someone
   * on a keyboard. With the plus and minus buttons gone, `+` and `-` on the
   * focused map are what keeps zoom reachable without one.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.key === '+' || event.key === '=' ? 1.3 : event.key === '-' ? 1 / 1.3 : null;
    if (step === null) return;
    event.preventDefault();
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (!aimZoom(step, [rect.width / 2, rect.height / 2])) return;
    // Eased like the wheel, so the keyboard is the same gesture at a fixed
    // size rather than the jump the wheel no longer makes.
    setMoving(true);
    if (wheelStop.current) clearTimeout(wheelStop.current);
    wheelStop.current = setTimeout(() => {
      latestEnd.current();
      setMoving(false);
    }, 320);
    draw();
    repaint((count) => count + 1);
  }

  function reset() {
    rotation.current = [...HOME];
    pan.current = { x: 0, y: 0 };
    zoom.current = 1;
    zoomTarget.current = 1;
    anchor.current = null;
    draw();
    repaint((count) => count + 1);
  }

  // Rotation counts as having moved the view. Without it, spinning the globe
  // halfway round the planet left "Reset the view" greyed out.
  const turned = rotation.current.some((angle, axis) => Math.abs(angle - HOME[axis]) > 0.5);
  const moved =
    Math.abs(zoomTarget.current - 1) > 0.001 ||
    turned ||
    Math.abs(pan.current.x) > 0.5 ||
    Math.abs(pan.current.y) > 0.5;

  /* ----------------------------------------------------------------- svg -- */

  const isGlobe = projection === 'globe';
  // Through the glass on a globe; a flat map has no far side to see through.
  const place: GeoProjection = isGlobe ? projections.current.glass : projections.current.mercator;
  const svgPath = geoPath(place);
  const centre = rotation.current;

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
    if (!isGlobe) return [{ points: coordinates, before: 0 }];
    const drawn: { points: LngLat[]; before: number }[] = [];
    let before = 0;
    for (const run of splitByHorizon(coordinates, centre)) {
      if (run.near) drawn.push({ points: run.points, before });
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
  const frame = size.current;
  const view: View = { globe: isGlobe, scale: place.scale(), rotation: centre };
  // Read once per render rather than per name, so every name on a frame agrees
  // about how far into an arrival that frame is.
  const now = performance.now();

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

  const continents = continentFade(zoom.current) * 0.55;
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
  const handover = subdivisionFade(zoom.current);
  const naming = new Map(
    subdivisions
      .filter((each) => each.labels.length > 0)
      .map((each) => [each.country, arrivalFade(each.country, now)] as const),
  );
  const countries = countryFade(zoom.current) * 0.72;
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
      each.labels.map((label) => ({ label, arriving: arrivalFade(each.country, now) })),
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
          No plus and minus. Two buttons that step the scale by a fixed factor
          are the mechanical feel this was asked to lose, and they zoom about
          the middle of the frame rather than about what you are looking at.
          The wheel does it continuously and about the cursor; `+` and `-` on
          the focused map do it for anyone without one.
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
        aria-label="Route map. Scroll or press plus and minus to zoom, drag to move."
      >
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
        <svg
          className={`${styles.overlay} ${moving ? '' : styles.settled}`}
          viewBox={`0 0 ${size.current.width || 1} ${size.current.height || 1}`}
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
                        style={
                          flowing ? { stroke, animationDelay: flowDelay(run.before) } : { stroke }
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
                  style={{ stroke: colour, animationDelay: flowDelay(run.before) }}
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
            const behind = isGlobe && !facesViewer(point, centre);
            return (
              <g key={id} className={behind ? styles.behind : undefined}>
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
              // Dimmed, never hidden. That is the whole point of a translucent
              // globe: an endpoint you have spun away from is still an
              // endpoint you are watching.
              const behind = isGlobe && !facesViewer(point, centre);
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
                <g key={`${route.id}-${code}`} className={behind ? styles.behind : undefined}>
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
      </div>
    </div>
  );
}
