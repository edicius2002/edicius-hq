import { geoMercator, geoPath } from 'd3-geo';
import { describe, expect, it } from 'vitest';

import { clampVertical } from '@/features/airfare/lib/globe';

/**
 * How far the flat map may be dragged.
 *
 * Sideways is deliberately absent — the projection is fitted to the width of
 * the frame, so a horizontal drag only ever swaps map for empty space.
 * Vertically Mercator is genuinely taller than the frame and there is
 * something to reach, so this is about not letting the reader drag past it.
 */

const FRAME = { width: 600, height: 400 };

/** A projection the size the map would be at a given zoom. */
function mercatorAt(scale: number, offset = 0) {
  return geoMercator()
    .rotate([62, 0])
    .precision(0.5)
    .translate([FRAME.width / 2, FRAME.height / 2 + offset])
    .scale(scale);
}

function boundsAt(offset: number) {
  return geoPath(mercatorAt(400, offset)).bounds({ type: 'Sphere' });
}

describe('clampVertical', () => {
  it('centres a map shorter than the frame instead of letting it float', () => {
    // Nothing to scroll, so wherever it was let go is the wrong answer.
    const small = mercatorAt(20, 150);
    const settled = clampVertical(small, FRAME.height, 150);
    const centred = clampVertical(mercatorAt(20, settled), FRAME.height, settled);
    expect(Math.abs(centred - settled)).toBeLessThan(1);
  });

  it('leaves a drag alone while both edges are still outside the frame', () => {
    const tall = mercatorAt(400, 30);
    expect(clampVertical(tall, FRAME.height, 30)).toBe(30);
  });

  it('refuses to pull the top edge down into the frame', () => {
    // Measured: at this scale the map is 2513px tall, so it takes an offset
    // past about 1057 before empty space would appear above it. My first
    // attempt used 900 and was therefore asserting nothing at all.
    const corrected = clampVertical(mercatorAt(400, 1400), FRAME.height, 1400);
    expect(corrected).toBeLessThan(1400);
    expect(boundsAt(corrected)[0][1]).toBeCloseTo(0, 5);
  });

  it('refuses to push the bottom edge up into the frame', () => {
    const corrected = clampVertical(mercatorAt(400, -1400), FRAME.height, -1400);
    expect(corrected).toBeGreaterThan(-1400);
    expect(boundsAt(corrected)[1][1]).toBeCloseTo(FRAME.height, 5);
  });

  it('settles: clamping an already clamped offset changes nothing', () => {
    // Applied on every frame, so it has to be a fixed point or the map creeps
    // a pixel at a time for as long as anyone is looking at it.
    const once = clampVertical(mercatorAt(400, 1400), FRAME.height, 1400);
    const twice = clampVertical(mercatorAt(400, once), FRAME.height, once);
    expect(Math.abs(twice - once)).toBeLessThan(0.01);
  });
});
