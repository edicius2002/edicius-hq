import { geoMercator, geoOrthographic, geoPath, type GeoProjection } from 'd3-geo';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { feature, mesh } from 'topojson-client';
import versor from 'versor';
import worldAtlas from 'world-atlas/countries-110m.json';

import { flowDelay, polylineLength } from '@/features/airfare/lib/arcFlow';
import {
  facesViewer,
  greatCircle,
  type LngLat,
  type RouteGeometry,
} from '@/features/airfare/lib/geo';
import { COUNTRIES, countryAt } from '@/features/airfare/lib/countries';
import {
  type Boxed,
  CONTINENTS,
  SUBDIVISION_REACH,
  type View,
  approach,
  clampPan,
  continentFade,
  countryFade,
  limbFade,
  roomFade,
  roomForName,
  screenArea,
  splitByHorizon,
  subdivisionFade,
  withoutOverlaps,
} from '@/features/airfare/lib/globe';
import { useSubdivisions } from '@/features/airfare/hooks/useSubdivisions';
import { Button } from '@/shared/ui/Button';

import styles from './RouteMap.module.css';

/**
 * Watched routes as arcs, on a globe or flat.
 *
 * **No frame loop runs at rest.** `requestAnimationFrame` is started only
 * while a pointer is down and stopped the moment it comes up, so an idle map
 * costs no script at all and a drag gets the whole frame budget. That is the
 * half of decision 12.23 that is kept.
 *
 * The half that is not: the globe's dashes flow, from origin towards
 * destination, on the one route the reader has open — every other arc stays
 * dashed and still. It is a declarative `stroke-dashoffset` animation
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

const ZOOM = { min: 1, max: 8 };

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

export type Projection = 'globe' | 'mercator';

type RouteMapProps = {
  routes: RouteGeometry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** A colour per route id, so one arc can be told from the next. */
  colours: Map<string, string>;
  projection: Projection;
  onProjectionChange: (projection: Projection) => void;
};

function readToken(element: HTMLElement, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

export function RouteMap({
  routes,
  selectedId,
  onSelect,
  colours,
  projection,
  onProjectionChange,
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
   * Which country the view is over, and its subdivisions once they arrive.
   *
   * `null` means nobody has zoomed into anything, and nothing is requested. A
   * country that has no subdivisions to give resolves to `null` too — see
   * `shared/api/geography`, where the 404 is swallowed — so a reader never
   * finds out which of the two happened, which is the point.
   */
  const [focus, setFocus] = useState<string | null>(null);
  const { data: subdivisions } = useSubdivisions(focus);

  const arcs = useMemo(
    () => routes.map((route) => ({ route, line: greatCircle(route.from, route.to) })),
    [routes],
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

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    if (projection === 'globe') {
      const [cx, cy] = projections.current.globe.translate();
      const radius = projections.current.globe.scale();
      // The halo just outside the limb is most of what makes a flat disc read
      // as a sphere, and it costs one gradient.
      const halo = context.createRadialGradient(cx, cy, radius * 0.96, cx, cy, radius * 1.16);
      halo.addColorStop(0, readToken(stage, '--map-halo'));
      halo.addColorStop(1, 'transparent');
      context.fillStyle = halo;
      context.beginPath();
      context.arc(cx, cy, radius * 1.16, 0, Math.PI * 2);
      context.fill();

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
    } else {
      context.beginPath();
      path({ type: 'Sphere' });
      context.fillStyle = readToken(stage, '--map-ocean');
      context.fill();
    }

    /*
     * Land as one flat mass, then every boundary once on top — mapcn's own
     * arrangement, read from its source: a monochrome fill with a separate
     * near-background line, and no graticule anywhere. The grid of meridians
     * and parallels went with it; on a globe carrying seven arcs and a dozen
     * place names it was the busiest thing on screen and the only one carrying
     * nothing.
     */
    context.beginPath();
    path(WORLD);
    context.fillStyle = readToken(stage, '--map-land');
    context.fill();

    /*
     * The subdivisions of the one country the reader has closed in on, under
     * the national borders rather than over them.
     *
     * A mesh, for 12.50's reason and one more: a boundary between two
     * provinces belongs to both, and stroking each province's own outline
     * would paint it twice — which at this opacity is the difference between a
     * quiet line and a visible one, and would make an interior border heavier
     * than the coast. The mesh is computed when the file is built rather than
     * here, so what arrives is already a `MultiLineString` and the browser
     * never walks the topology.
     *
     * Opacity comes from the geometry, per frame, the same way a place name's
     * does — 12.27 — so the borders arrive as the country's name leaves rather
     * than switching on at a threshold.
     */
    const inner = subdivisions?.borders ? subdivisionFade(zoom.current) : 0;
    if (inner > 0 && subdivisions?.borders) {
      context.save();
      context.globalAlpha = inner;
      context.beginPath();
      path(subdivisions.borders);
      context.strokeStyle = readToken(stage, '--map-border-inner');
      // Just over half the national border's width, on top of a colour with
      // just over half its separation from the land. A subdivision line has to
      // read as *inside* something, and matching either one of those alone was
      // not enough to stop the two reading as the same line.
      context.lineWidth = Math.min(1.7, 0.85 + zoom.current * 0.18) * 0.55;
      context.lineJoin = 'round';
      context.stroke();
      context.restore();
    }

    context.beginPath();
    path(BOUNDARIES);
    context.strokeStyle = readToken(stage, '--map-border');
    /*
     * Borders hold their weight as the globe grows, up to a point: a hairline
     * disappears when zoomed out and a fixed width turns into a ribbon when
     * zoomed in. The colour relationship is already mapcn's — 1.70 against its
     * 1.73, measured — so what has to carry the line at globe scale is width.
     */
    context.lineWidth = Math.min(1.7, 0.85 + zoom.current * 0.18);
    context.lineJoin = 'round';
    context.stroke();
  }, [fit, projection, subdivisions]);

  useEffect(() => {
    draw();
    repaint((count) => count + 1);
  }, [draw]);

  /**
   * How long the map must sit still before it asks whose subdivisions to draw.
   *
   * The second of the three things damping this fetch. A reader spinning the
   * globe crosses a dozen countries a second, and asking after each of them
   * would be a dozen requests for geometry nobody looked at. The wheel already
   * holds `moving` true for 320ms past the last notch, so by the time this
   * timer starts the view has genuinely stopped; a quarter of a second past
   * that is about the gap between two deliberate gestures, so a reader
   * reaching for a second drag cancels the first one's question.
   */
  const SETTLE_MS = 250;

  /*
   * Which country the middle of the frame is over.
   *
   * The middle rather than the largest country in view: it is where a reader
   * puts the thing they are looking at, it is what the zoom anchors to, and it
   * is one `invert` instead of a sweep. Both projections answer it the same
   * way, which is why the flat map needs no separate rule.
   *
   * `tick` is in the dependencies as the map's own "something was drawn"
   * signal, so a view that changed without a gesture — a reset, a resize — is
   * noticed too. It changes every frame during a drag, and every one of those
   * runs stops at the `moving` check without setting a timer.
   */
  useEffect(() => {
    if (moving) return;
    // Nothing at all until the view is close enough for the layer to be worth
    // having. This is the first and cheapest of the three: a reader who never
    // zooms in never sends a request.
    if (zoom.current < SUBDIVISION_REACH) {
      setFocus(null);
      return;
    }
    const handle = setTimeout(() => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return;
      const shown =
        projection === 'globe' ? projections.current.globe : projections.current.mercator;
      const at = shown.invert?.([rect.width / 2, rect.height / 2]);
      if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) return;
      // Open water, or a shape the atlas carries without a numeric code, both
      // mean there is nothing to ask for.
      setFocus(countryAt([at[0], at[1]])?.id ?? null);
    }, SETTLE_MS);
    return () => clearTimeout(handle);
  }, [moving, tick, projection]);

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
   * A frame loop only while something is actually moving.
   *
   * `flushSync` is what keeps the two surfaces together. `draw` paints the
   * canvas inside the frame callback, but a plain `repaint` only *schedules* a
   * React render, and React's scheduler runs on a task that the browser gets
   * to after it has already painted — so the land moved this frame and the
   * arcs, the airport codes and the place names moved on the next one. One
   * frame of slip at 60 Hz is small and completely visible: the map slides out
   * from under its own labels for as long as the drag lasts.
   *
   * Committing synchronously costs the same work, just not deferred, and it
   * only ever runs while a pointer is down.
   */
  useEffect(() => {
    if (!moving) return;
    let running = true;
    let last = 0;
    const tick = (now: number) => {
      if (!running) return;
      // Elapsed time, not a fixed step per frame, so the glide takes the same
      // wall-clock time on a 60 Hz panel and on a 144 Hz one.
      if (last) latestStep.current(Math.min(now - last, 50));
      last = now;
      draw();
      flushSync(() => repaint((count) => count + 1));
      requestAnimationFrame(tick);
    };
    const handle = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(handle);
    };
  }, [moving, draw]);

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
    // Long enough for the easing to arrive: about four time constants past the
    // last notch, so the loop is never switched off mid-glide.
    wheelStop.current = setTimeout(() => setMoving(false), 320);
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
    wheelStop.current = setTimeout(() => setMoving(false), 320);
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

  /**
   * The three rungs of the name ladder, each smaller and less tracked out than
   * the one above it — which is also how a reader tells them apart when two of
   * them are half-lit at a handover.
   */
  const TYPE = {
    continent: { key: 'c', font: 11, spacing: 1.98 },
    country: { key: 'n', font: 10, spacing: 0.8 },
    // 8px, and the smallest thing on the map. A name's box is its width times
    // its height and both fall with the face, so a point down from the country
    // rung is 11% narrower and 11% shorter and asks 21% less ground — which at
    // this zoom is the difference between a department carrying its name and
    // carrying nothing.
    subdivision: { key: 's', font: 8, spacing: 0.32 },
  } as const;
  type Tier = keyof typeof TYPE;

  /**
   * How much screen a name takes, before anything decides whether to draw it.
   *
   * Shared, because the subdivision rung asks the same question twice: once to
   * find out whether the ground can hold this particular name, and once to
   * claim that ground against every other name. Letter-spacing is part of the
   * width both times, and the continent names are tracked out a long way.
   */
  function nameBox(name: string, tier: Tier) {
    const { font, spacing } = TYPE[tier];
    return { width: name.length * (font * 0.58 + spacing), height: font * 1.7 };
  }

  type MapName = Boxed & { key: string; text: string; opacity: number; tier: Tier };
  const names: MapName[] = [];

  function offer(name: MapName['text'], at: LngLat, strength: number, tier: Tier) {
    let opacity = strength;
    if (isGlobe) opacity *= limbFade(at, centre);
    if (opacity <= 0.01) return;
    const xy = place(at);
    if (!xy) return;
    const { width, height } = nameBox(name, tier);
    // Off the frame entirely. Worth checking: zoomed in, most of the world is.
    if (xy[0] < -width || xy[0] > frame.width + width) return;
    if (xy[1] < -height || xy[1] > frame.height + height) return;
    names.push({
      key: `${TYPE[tier].key}:${name}`,
      text: name,
      x: xy[0],
      y: xy[1],
      width,
      height,
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

  const continents = continentFade(zoom.current) * 0.55;
  for (const continent of CONTINENTS) offer(continent.name, continent.at, continents, 'continent');

  /*
   * The country the reader has closed in on gives its name up to the
   * subdivisions inside it, and only that one does.
   *
   * Every other country on screen keeps whatever `countryFade` gives it,
   * because no other country's subdivisions have been fetched and drawing none
   * while withdrawing the name would leave a blank shape. That is also exactly
   * what makes the fallback silent: a country Natural Earth does not divide
   * takes this branch too, and looks no different from one nobody has zoomed
   * into.
   */
  const handover = subdivisions?.labels.length ? subdivisionFade(zoom.current) : 0;
  const countries = countryFade(zoom.current) * 0.72;
  for (const country of COUNTRIES) {
    if (countries <= 0.01) break;
    const room = roomFade(screenArea(country.area, country.at, view));
    if (room <= 0) continue;
    const giving = country.id === subdivisions?.country ? 1 - handover : 1;
    offer(country.name, country.at, room * countries * giving, 'country');
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
   */
  if (handover > 0.01 && subdivisions) {
    for (const unit of subdivisions.labels) {
      const box = nameBox(unit.name, 'subdivision');
      const room = roomFade(
        screenArea(unit.area, unit.at, view),
        roomForName(box.width, box.height),
      );
      if (room <= 0) continue;
      offer(unit.name, unit.at, room * handover * 0.72, 'subdivision');
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
            const stroke = colours.get(route.id) ?? DEFAULT_ARC;
            const selected = selectedId === route.id;
            /*
             * Only the open route's dashes move, and only on the globe.
             *
             * The flat map's arcs are solid and have nothing to flow; the
             * others are dashed and still. The route drawn here is the
             * outbound leg — the map has always drawn one arc per route, from
             * origin to destination, and a return date adds a second date to
             * the row rather than a second curve to the map. So "the outbound
             * leg flows" is a description of what is on screen, not a
             * direction that had to be chosen between two.
             */
            const flowing = isGlobe && selected;
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
                      <path d={d} className={styles.hit} data-route={route.id} aria-hidden="true" />
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
                          selected ? styles.active : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        aria-label={
                          index === 0
                            ? `${route.fromCity ?? route.origin} to ${route.toCity ?? route.destination}`
                            : undefined
                        }
                      />
                    </g>
                  );
                })}
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
              return (
                <g key={`${route.id}-${code}`} className={behind ? styles.behind : undefined}>
                  <circle
                    cx={xy[0]}
                    cy={xy[1]}
                    r={isOrigin ? 4.6 : 4}
                    // The origin stays neutral: every route on this page leaves
                    // from it, so colouring it would claim it belongs to one.
                    style={isOrigin ? undefined : { fill: colours.get(route.id) ?? DEFAULT_ARC }}
                    className={isOrigin ? styles.home : styles.node}
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
