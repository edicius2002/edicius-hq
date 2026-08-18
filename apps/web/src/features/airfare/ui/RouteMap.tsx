import { geoGraticule10, geoMercator, geoOrthographic, geoPath, type GeoProjection } from 'd3-geo';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { feature } from 'topojson-client';
import versor from 'versor';
import worldAtlas from 'world-atlas/countries-110m.json';

import {
  facesViewer,
  greatCircle,
  type LngLat,
  type RouteGeometry,
} from '@/features/airfare/lib/geo';
import { CONTINENTS, splitByHorizon } from '@/features/airfare/lib/globe';
import { Button } from '@/shared/ui/Button';

import styles from './RouteMap.module.css';

/**
 * Watched routes as arcs, on a globe or flat.
 *
 * **Nothing here animates by itself.** The arcs are static; the only motion is
 * the one the reader causes. That buys the thing that matters most: the render
 * loop runs *only* while a pointer is down, so an idle map costs nothing.
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
 * - **Canvas** for the sphere, the graticule and the land. Reprojecting a
 *   world outline every frame is the expensive part, and a 2D context absorbs
 *   it where thousands of DOM nodes would not.
 * - **SVG** for the arcs, the airports and the continent names, so each stays
 *   a node a test can query and a screen reader can read — decision 12.12.
 *
 * The continent labels are ours. mapcn gets place names from its basemap's
 * symbol layers; with the blank style this repository requires, that basemap
 * is gone and its labels with it — for mapcn as much as for us. Seven
 * hand-placed points is the whole of what was lost, and it weighs nothing.
 */

// 1:110m Natural Earth, bundled. 39 kB gzip, and it never touches the network.
// 1:50m is four times the coastline detail and 236 kB gzip — as heavy as a
// whole tile engine, which is not a trade this map needs to make.
const WORLD = feature(
  worldAtlas as never,
  (worldAtlas as never as { objects: { countries: never } }).objects.countries,
);
const GRATICULE = geoGraticule10();

const ZOOM = { min: 1, max: 8, step: 1.5, wheel: 1.12 };

/** Looking at Lima, which is where every route on this page starts. */
const HOME: [number, number, number] = [77, 6, 0];

export type Projection = 'globe' | 'mercator';

type RouteMapProps = {
  routes: RouteGeometry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** `cheap` | `dear` | `neutral` per route id, for the arc colour. */
  tones: Map<string, string>;
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
  tones,
  projection,
  onProjectionChange,
}: RouteMapProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rotation = useRef<[number, number, number]>([...HOME]);
  const pan = useRef({ x: 0, y: 0 });
  const size = useRef({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [moving, setMoving] = useState(false);
  const [, repaint] = useState(0);

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

    const radius = Math.min(rect.width, rect.height) * 0.42 * zoom;
    const centre: [number, number] = [
      rect.width / 2 + pan.current.x,
      rect.height / 2 + pan.current.y,
    ];
    for (const globe of [projections.current.globe, projections.current.glass]) {
      globe.translate(centre).scale(radius).rotate(rotation.current);
    }
    projections.current.mercator
      .translate([centre[0], centre[1] + radius * 0.16])
      .scale(Math.min(rect.width / 6.3, radius * 0.6));
    return { rect, dpr };
  }, [zoom]);

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

    context.beginPath();
    path(GRATICULE);
    context.strokeStyle = readToken(stage, '--map-graticule');
    context.lineWidth = 0.5;
    context.stroke();

    context.beginPath();
    path(WORLD);
    context.fillStyle = readToken(stage, '--map-land');
    context.fill();
    context.strokeStyle = readToken(stage, '--map-coast');
    context.lineWidth = 0.6;
    context.stroke();
  }, [fit, projection]);

  useEffect(() => {
    draw();
    repaint((tick) => tick + 1);
  }, [draw]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      draw();
      repaint((tick) => tick + 1);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [draw]);

  // A frame loop only while something is actually moving.
  useEffect(() => {
    if (!moving) return;
    let running = true;
    const tick = () => {
      if (!running) return;
      draw();
      repaint((count) => count + 1);
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

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const { offsetX, offsetY } = event.nativeEvent;
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

  function endGesture(event: React.PointerEvent<HTMLDivElement>) {
    if (!gesture.current) return;
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setMoving(false);
    draw();
    repaint((tick) => tick + 1);
  }

  function nudgeZoom(factor: number) {
    setZoom((current) => Math.min(ZOOM.max, Math.max(ZOOM.min, current * factor)));
  }

  // Attached by hand rather than through `onWheel`: React registers wheel
  // listeners passively, and a passive listener cannot stop the page scrolling
  // underneath the map.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? ZOOM.wheel : 1 / ZOOM.wheel;
      setZoom((current) => Math.min(ZOOM.max, Math.max(ZOOM.min, current * factor)));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  function reset() {
    rotation.current = [...HOME];
    pan.current = { x: 0, y: 0 };
    setZoom(1);
    draw();
    repaint((tick) => tick + 1);
  }

  const moved = zoom !== 1 || pan.current.x !== 0 || pan.current.y !== 0;

  /* ----------------------------------------------------------------- svg -- */

  const isGlobe = projection === 'globe';
  // Through the glass on a globe; a flat map has no far side to see through.
  const place: GeoProjection = isGlobe ? projections.current.glass : projections.current.mercator;
  const svgPath = geoPath(place);
  const centre = rotation.current;

  function runsFor(coordinates: LngLat[]) {
    return isGlobe ? splitByHorizon(coordinates, centre) : [{ near: true, points: coordinates }];
  }

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

        <div className={styles.zoomGroup}>
          <Button
            variant="secondary"
            size="small"
            aria-label="Zoom out"
            disabled={zoom <= ZOOM.min}
            onClick={() => nudgeZoom(1 / ZOOM.step)}
          >
            &minus;
          </Button>
          <Button
            variant="secondary"
            size="small"
            aria-label="Zoom in"
            disabled={zoom >= ZOOM.max}
            onClick={() => nudgeZoom(ZOOM.step)}
          >
            +
          </Button>
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
      >
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
        <svg
          className={styles.overlay}
          viewBox={`0 0 ${size.current.width || 1} ${size.current.height || 1}`}
          role="list"
          aria-label="Watched routes"
        >
          {/*
            Continent names first, so a label never sits on top of the data.
            Only the ones facing the viewer: on the far side the name would
            land over a different continent entirely.
          */}
          {isGlobe
            ? CONTINENTS.filter((continent) => facesViewer(continent.at, centre)).map(
                (continent) => {
                  const xy = place(continent.at);
                  if (!xy) return null;
                  return (
                    <text
                      key={continent.name}
                      x={xy[0]}
                      y={xy[1]}
                      className={styles.continent}
                      aria-hidden="true"
                    >
                      {continent.name}
                    </text>
                  );
                },
              )
            : null}

          {arcs.map(({ route, line }) => {
            const tone = tones.get(route.id) ?? 'neutral';
            const selected = selectedId === route.id;
            return (
              <g key={route.id} role="listitem">
                {runsFor(line.coordinates).map((run, index) => {
                  const d = svgPath({ type: 'LineString', coordinates: run.points } as never);
                  if (!d) return null;
                  return (
                    <g key={index}>
                      <path
                        d={d}
                        className={styles.hit}
                        onClick={() => onSelect(route.id)}
                        aria-hidden="true"
                      />
                      <path
                        d={d}
                        className={[
                          styles.arc,
                          styles[tone],
                          // Dashed on the globe, where the surface is curved
                          // and busy; solid on the flat map, where a dash only
                          // fragments a line that already reads.
                          isGlobe ? styles.dashed : '',
                          run.near ? '' : styles.behind,
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
                    r={isOrigin ? 3.4 : 2.6}
                    className={isOrigin ? styles.home : styles.node}
                  />
                  <text x={xy[0] + 7} y={xy[1] + 3.5} className={styles.label}>
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
