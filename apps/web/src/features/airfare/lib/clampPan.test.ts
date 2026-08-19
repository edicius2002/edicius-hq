import { geoMercator, geoPath } from 'd3-geo';
import { describe, expect, it } from 'vitest';

import { clampPan } from '@/features/airfare/lib/globe';

/**
 * How far the flat map may be dragged.
 *
 * One rule on both axes: never past the map's own edge. At the default zoom
 * that reads as up and down only, because the projection is fitted to the
 * width of the frame and there is nothing to reach sideways — which is the
 * behaviour asked for, arrived at by measuring the map rather than by
 * hard-coding the axis. Zoom in and sideways becomes reachable on the same
 * terms, because now there is something over there.
 */

const FRAME = { width: 600, height: 400 };

/** A projection the size the map would be at a given zoom. */
function mercatorAt(scale: number, offset = { x: 0, y: 0 }) {
  return geoMercator()
    .rotate([62, 0])
    .precision(0.5)
    .translate([FRAME.width / 2 + offset.x, FRAME.height / 2 + offset.y])
    .scale(scale);
}

function boundsAt(scale: number, offset: { x: number; y: number }) {
  return geoPath(mercatorAt(scale, offset)).bounds({ type: 'Sphere' });
}

/** The scale at which 360° of longitude spans the frame exactly — our zoom 1. */
const FITS_WIDTH = FRAME.width / (2 * Math.PI);

describe('clampPan', () => {
  it('leaves the flat map only up and down at the zoom it opens at', () => {
    // The load-bearing case: fitted to the width, sideways has nowhere to go,
    // so any horizontal drag is undone and the map stays centred on x.
    const dragged = { x: 220, y: 60 };
    const settled = clampPan(mercatorAt(FITS_WIDTH, dragged), FRAME, dragged);
    expect(settled.x).toBeCloseTo(0, 5);
    expect(settled.y).toBe(60);
  });

  it('lets the map go sideways once zoom has made it wider than the frame', () => {
    const dragged = { x: 200, y: 0 };
    expect(clampPan(mercatorAt(FITS_WIDTH * 3, dragged), FRAME, dragged).x).toBe(200);
  });

  it('centres a map smaller than the frame instead of letting it float', () => {
    const dragged = { x: 150, y: 150 };
    const once = clampPan(mercatorAt(20, dragged), FRAME, dragged);
    const twice = clampPan(mercatorAt(20, once), FRAME, once);
    expect(Math.abs(twice.x - once.x)).toBeLessThan(1);
    expect(Math.abs(twice.y - once.y)).toBeLessThan(1);
  });

  it('leaves a drag alone while both edges are still outside the frame', () => {
    const dragged = { x: 40, y: 30 };
    expect(clampPan(mercatorAt(400, dragged), FRAME, dragged)).toEqual(dragged);
  });

  it('refuses to pull the top or left edge in off the frame', () => {
    // Measured: at this scale the map is 2513px square, so it takes an offset
    // past about 1057 before empty space would appear. My first attempt used
    // 900 and was therefore asserting nothing at all.
    const dragged = { x: 1400, y: 1400 };
    const settled = clampPan(mercatorAt(400, dragged), FRAME, dragged);
    expect(settled.x).toBeLessThan(1400);
    expect(settled.y).toBeLessThan(1400);
    const [[left, top]] = boundsAt(400, settled);
    expect(left).toBeCloseTo(0, 5);
    expect(top).toBeCloseTo(0, 5);
  });

  it('refuses to push the bottom or right edge in off the frame', () => {
    const dragged = { x: -1400, y: -1400 };
    const settled = clampPan(mercatorAt(400, dragged), FRAME, dragged);
    const [, [right, bottom]] = boundsAt(400, settled);
    expect(right).toBeCloseTo(FRAME.width, 5);
    expect(bottom).toBeCloseTo(FRAME.height, 5);
  });

  it('settles: clamping an already clamped offset changes nothing', () => {
    // Applied on every frame, so it has to be a fixed point or the map creeps
    // a pixel at a time for as long as anyone is looking at it.
    const dragged = { x: 1400, y: 1400 };
    const once = clampPan(mercatorAt(400, dragged), FRAME, dragged);
    const twice = clampPan(mercatorAt(400, once), FRAME, once);
    expect(Math.abs(twice.x - once.x)).toBeLessThan(0.01);
    expect(Math.abs(twice.y - once.y)).toBeLessThan(0.01);
  });
});
