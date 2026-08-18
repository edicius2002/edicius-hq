import { geoGraticule10, geoMercator, geoOrthographic, geoPath, type GeoProjection } from 'd3-geo';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { feature } from 'topojson-client';
import versor from 'versor';
import worldAtlas from 'world-atlas/countries-110m.json';

import { facesViewer, greatCircle, type RouteGeometry } from '@/features/airfare/lib/geo';

import styles from './RouteMap.module.css';

/**
 * Watched routes as arcs, on a globe or flat.
 *
 * **Nothing here animates by itself.** The arcs are static dashes; the only
 * motion is the one the reader causes by dragging. That is a deliberate
 * constraint and it buys the thing that matters most: the render loop runs
 * *only* while a pointer is down, so an idle map costs nothing at all and a
 * drag has the whole frame budget to itself.
 *
 * Two surfaces, for two different reasons:
 *
 * - **Canvas** draws the sphere, the graticule and the land. Reprojecting a
 *   world outline every frame is the expensive part, and a 2D context absorbs
 *   it where thousands of DOM nodes would not.
 * - **SVG** draws the arcs and the airport dots, so each one stays a node a
 *   test can query and a screen reader can read — the same reasoning that put
 *   the price chart in the DOM (decision 12.12). The nodes are created once
 *   and only their `d` attribute is rewritten; recreating them per frame was
 *   measurably the slowest thing the prototype did.
 *
 * During a drag the SVG is hidden and the arcs are drawn on the canvas
 * instead. Thirty DOM attribute writes per frame is fine at five routes and
 * visible at forty, and the arcs are not interactive while the pointer is
 * already busy dragging.
 */

// 1:110m Natural Earth, bundled. 39 kB gzip, and it never touches the network.
// 1:50m is four times the coastline detail and 236 kB gzip — as heavy as a
// whole tile engine, which is not a trade this map needs to make.
const WORLD = feature(
  worldAtlas as never,
  (worldAtlas as never as { objects: { countries: never } }).objects.countries,
);
const GRATICULE = geoGraticule10();

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
  const rotation = useRef<[number, number, number]>([77, 6, 0]);
  const size = useRef({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const [, forceOverlay] = useState(0);

  const arcs = useMemo(
    () => routes.map((route) => ({ route, line: greatCircle(route.from, route.to) })),
    [routes],
  );

  const projections = useRef({
    globe: geoOrthographic().clipAngle(90).precision(0.5),
    mercator: geoMercator().rotate([62, 0]).precision(0.5),
  });

  /** Fit both projections to the stage. Only on a real size change. */
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
    const radius = Math.min(rect.width, rect.height) * 0.42;
    projections.current.globe
      .translate([rect.width / 2, rect.height / 2])
      .scale(radius)
      .rotate(rotation.current);
    projections.current.mercator
      .translate([rect.width / 2, rect.height / 2 + radius * 0.16])
      .scale(Math.min(rect.width / 6.3, radius * 0.6));
    return { rect, dpr };
  }, []);

  const active = useCallback(
    (): GeoProjection =>
      projection === 'globe' ? projections.current.globe : projections.current.mercator,
    [projection],
  );

  const draw = useCallback(
    (withArcs: boolean) => {
      const fitted = fit();
      const canvas = canvasRef.current;
      const stage = stageRef.current;
      if (!fitted || !canvas || !stage) return;
      const context = canvas.getContext('2d');
      if (!context) return;

      const { rect, dpr } = fitted;
      const shown = active();
      const path = geoPath(shown, context);

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);

      if (projection === 'globe') {
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const radius = projections.current.globe.scale();
        // The halo just outside the limb is most of what makes a flat disc
        // read as a sphere, and it costs one gradient.
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

      if (withArcs) {
        // Drag-time arcs. Same geometry as the SVG, drawn where it is cheap.
        context.save();
        context.setLineDash([5, 5]);
        context.lineWidth = 1.6;
        for (const { route, line } of arcs) {
          context.beginPath();
          path(line);
          const tone = tones.get(route.id) ?? 'neutral';
          context.strokeStyle = readToken(stage, `--arc-${tone}`);
          context.stroke();
        }
        context.restore();
      }
    },
    [active, arcs, fit, projection, tones],
  );

  // Redraw when anything that changes the picture changes — and then stop.
  useEffect(() => {
    draw(false);
    forceOverlay((tick) => tick + 1);
  }, [draw]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      draw(dragging);
      forceOverlay((tick) => tick + 1);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [draw, dragging]);

  /* ------------------------------------------------------------- dragging -- */

  useEffect(() => {
    if (!dragging) return;
    let running = true;
    const tick = () => {
      if (!running) return;
      draw(true);
      requestAnimationFrame(tick);
    };
    const handle = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(handle);
    };
  }, [dragging, draw]);

  const gesture = useRef<{
    v0: [number, number, number];
    q0: [number, number, number, number];
    r0: [number, number, number];
  } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (projection !== 'globe') return;
    const inverted = projections.current.globe.invert?.([
      event.nativeEvent.offsetX,
      event.nativeEvent.offsetY,
    ]);
    if (!inverted) return;
    gesture.current = {
      v0: versor.cartesian(inverted),
      q0: versor(rotation.current),
      r0: [...rotation.current] as [number, number, number],
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const held = gesture.current;
    if (!held) return;
    const globe = projections.current.globe;
    const inverted = globe
      .rotate(held.r0)
      .invert?.([event.nativeEvent.offsetX, event.nativeEvent.offsetY]);
    if (!inverted) return;
    const next = versor.rotation(
      versor.multiply(held.q0, versor.delta(held.v0, versor.cartesian(inverted))),
    );
    // The third angle is dropped so the horizon stays level. Letting it drift
    // makes the globe feel like it is tumbling rather than turning.
    rotation.current = [next[0], next[1], 0];
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!gesture.current) return;
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(false);
    draw(false);
    forceOverlay((tick) => tick + 1);
  };

  /* ---------------------------------------------------------------- svg --- */

  const shown = active();
  const svgPath = geoPath(shown);
  const centre = rotation.current;

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
      </div>

      <div
        ref={stageRef}
        className={`${styles.stage} ${projection === 'globe' ? styles.grabbable : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
        <svg
          className={`${styles.overlay} ${dragging ? styles.hidden : ''}`}
          viewBox={`0 0 ${size.current.width || 1} ${size.current.height || 1}`}
          role="list"
          aria-label="Watched routes"
        >
          {arcs.map(({ route, line }) => {
            const d = svgPath(line);
            if (!d) return null;
            const tone = tones.get(route.id) ?? 'neutral';
            return (
              <g key={route.id} role="listitem">
                <path
                  d={d}
                  className={styles.hit}
                  onClick={() => onSelect(route.id)}
                  aria-hidden="true"
                />
                <path
                  d={d}
                  className={`${styles.arc} ${styles[tone] ?? ''} ${
                    selectedId === route.id ? styles.active : ''
                  }`}
                  aria-label={`${route.fromCity ?? route.origin} to ${route.toCity ?? route.destination}`}
                />
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
              if (projection === 'globe' && !facesViewer(point, centre)) return null;
              const xy = shown(point);
              if (!xy) return null;
              return (
                <g key={`${route.id}-${code}`}>
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
