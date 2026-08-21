import { geoDistance, geoMercator, geoOrthographic } from 'd3-geo';
import { describe, expect, it } from 'vitest';

import type { LngLat } from '@/features/airfare/lib/geo';
import { capOf, capped, cappedRuns, capsMeet, viewCap } from '@/features/airfare/lib/visible';

/**
 * The test that matters here is not "does it drop things", it is "can it drop
 * something that was on screen".
 *
 * A cull is only worth having if it is provably one-sided: it may keep a shape
 * that turns out to be off the frame, at the cost of a little time, and it may
 * never drop one that would have put ink on a pixel. So the cases below are
 * mostly about the direction of the error — an enclosing cap that really does
 * enclose, a camera cap that really does cover the frame — rather than about
 * how tight either of them is.
 *
 * The other half of this change's proof is not a test and cannot be: the map
 * was drawn twice in a real browser, once with the visibility test and once
 * with it forced open, and the two canvases compared byte for byte at eleven
 * views across both projections. A jsdom canvas has no rasteriser, so that
 * check lives in the report rather than here.
 */

const PERU: LngLat[] = [
  [-81.3, -4.0],
  [-68.7, -4.0],
  [-68.7, -18.3],
  [-81.3, -18.3],
  [-81.3, -4.0],
];
const PERU_SHAPE = { type: 'Polygon' as const, coordinates: [PERU] };
/** Looking at Lima: `rotate` is the negative of where the camera points. */
const AT_LIMA: [number, number, number] = [77, 12, 0];
const FRAME = { width: 433, height: 460 };

function globeAt(zoom: number) {
  const fitted = Math.min(FRAME.width, FRAME.height) * 0.42;
  return geoOrthographic()
    .clipAngle(90)
    .precision(0.5)
    .translate([FRAME.width / 2, FRAME.height / 2])
    .scale(fitted * zoom)
    .rotate(AT_LIMA);
}

describe('capOf', () => {
  it('encloses every vertex of the shape it is built from', () => {
    const cap = capOf(PERU_SHAPE);
    for (const point of PERU) {
      expect(geoDistance(cap.at, point)).toBeLessThanOrEqual(cap.radius + 1e-12);
    }
  });

  it('encloses the inside of the shape as well as its outline', () => {
    // The point of the cap is that a camera standing in the middle of Peru is
    // inside Peru's cap, so Peru is drawn even though no vertex of it is near.
    const cap = capOf(PERU_SHAPE);
    expect(geoDistance(cap.at, [-75, -11])).toBeLessThanOrEqual(cap.radius);
  });

  it('gives an empty geometry a cap that reaches nothing', () => {
    expect(capOf({ type: 'Polygon', coordinates: [] }).radius).toBe(0);
  });

  it('refuses to bound a shape that wraps the world, rather than bounding it wrongly', () => {
    // Russia's extent runs from -180 to 180 because it crosses the
    // antimeridian, and a box that wide has points further from its middle than
    // any of its corners. So it is never culled — drawn every frame, exactly as
    // often as it was before this module existed.
    const wrapping = capOf({
      type: 'Polygon',
      coordinates: [
        [
          [-180, 41],
          [180, 41],
          [180, 82],
          [-180, 82],
          [-180, 41],
        ],
      ],
    });
    expect(wrapping.radius).toBe(Math.PI);
    expect(capsMeet(wrapping, { at: [-77, -12], radius: 0.001 })).toBe(true);
  });

  it('reads a Feature and a GeometryCollection the same way as a bare geometry', () => {
    const bare = capOf(PERU_SHAPE);
    expect(capOf({ type: 'Feature', geometry: PERU_SHAPE })).toEqual(bare);
    expect(capOf({ type: 'GeometryCollection', geometries: [PERU_SHAPE] })).toEqual(bare);
  });
});

describe('capsMeet', () => {
  it('keeps a shape the camera is standing inside', () => {
    expect(capsMeet(capOf(PERU_SHAPE), { at: [-75, -11], radius: 0.001 })).toBe(true);
  });

  it('drops a shape on the other side of the planet', () => {
    const tokyo = capOf({
      type: 'Polygon',
      coordinates: [
        [
          [139, 35],
          [140, 35],
          [140, 36],
          [139, 36],
          [139, 35],
        ],
      ],
    });
    expect(capsMeet(tokyo, { at: [-77, -12], radius: 0.05 })).toBe(false);
  });

  it('keeps everything against a cap that covers the sphere', () => {
    expect(capsMeet(capOf(PERU_SHAPE), { at: [0, 0], radius: Math.PI })).toBe(true);
  });
});

describe('viewCap on the globe', () => {
  it('is the near hemisphere when the whole disc is inside the frame', () => {
    // At 1x the globe's radius is 0.42 of the short side, so the corners of the
    // frame are well outside it and everything facing the reader is on screen.
    const cap = viewCap(globeAt(1), FRAME, true, AT_LIMA);
    expect(cap.at).toEqual([-77, -12]);
    expect(cap.radius).toBeGreaterThanOrEqual(Math.PI / 2);
  });

  it('closes right down as the reader gets closer', () => {
    // The map's own ceiling. `0.42 x 460 x 32` is 6,182 px of radius against a
    // half-diagonal of 316, so the reader is looking at under three degrees of
    // sphere — which is the whole reason this module exists.
    const cap = viewCap(globeAt(32), FRAME, true, AT_LIMA);
    expect((cap.radius * 180) / Math.PI).toBeLessThan(4);
  });

  it('covers every point of the frame it claims to describe', () => {
    for (const zoom of [1, 1.5, 2, 3, 4, 8, 16, 32]) {
      const shown = globeAt(zoom);
      const cap = viewCap(shown, FRAME, true, AT_LIMA);
      for (let x = 0; x <= FRAME.width; x += FRAME.width / 16) {
        for (let y = 0; y <= FRAME.height; y += FRAME.height / 16) {
          const there = shown.invert?.([x, y]);
          // A point off the disc is water beyond the limb, which is not
          // somewhere anything can be drawn.
          if (!there || !Number.isFinite(there[0])) continue;
          expect(geoDistance(cap.at, [there[0], there[1]])).toBeLessThanOrEqual(cap.radius);
        }
      }
    }
  });

  it('gives up rather than guessing when the projection has no scale', () => {
    expect(viewCap(geoOrthographic().scale(0), FRAME, true, AT_LIMA).radius).toBe(Math.PI);
    expect(viewCap(globeAt(4), { width: 0, height: 0 }, true, AT_LIMA).radius).toBe(Math.PI);
  });
});

describe('viewCap on the flat map', () => {
  const mercatorAt = (zoom: number) => {
    const fitted = Math.min(FRAME.width, FRAME.height) * 0.42;
    return geoMercator()
      .rotate([62, 0])
      .precision(0.5)
      .translate([FRAME.width / 2, FRAME.height / 2])
      .scale(Math.min(FRAME.width / (2 * Math.PI), fitted * 0.6) * zoom);
  };

  it('culls nothing at the default scale, where the frame holds the whole world', () => {
    /*
     * This one nearly shipped as a missing half of the planet. The flat map is
     * fitted to exactly 360° of longitude at 1x, so a point at the right-hand
     * edge of the frame is 180° from the point in the middle of it — and a cap
     * built from the corners called that 95°, because at the corner the
     * latitude is near the pole and the great-circle distance is short. Every
     * country in the outer third of the frame would have been dropped while the
     * reader was looking at it.
     */
    expect(viewCap(mercatorAt(1), FRAME, false, [0, 0, 0]).radius).toBe(Math.PI);
  });

  it('covers the middle of every edge, not only the corners', () => {
    // The corners are where the rule is weakest to test and the edges are where
    // it actually broke: on a Mercator the sides of the frame run to the poles,
    // so a corner can be nearer the middle than the point halfway down from it.
    for (const zoom of [1, 1.5, 2, 3, 4, 8, 16, 32]) {
      const shown = mercatorAt(zoom);
      const cap = viewCap(shown, FRAME, false, [0, 0, 0]);
      if (cap.radius >= Math.PI) continue;
      for (let x = 0; x <= FRAME.width; x += FRAME.width / 8) {
        for (let y = 0; y <= FRAME.height; y += FRAME.height / 8) {
          const there = shown.invert?.([x, y]);
          if (!there || !Number.isFinite(there[0])) continue;
          expect(geoDistance(cap.at, [there[0], there[1]])).toBeLessThanOrEqual(cap.radius);
        }
      }
    }
  });
});

describe('the index', () => {
  it('keeps each shape beside its own cap, in the order it was given', () => {
    const shapes = [PERU_SHAPE, { type: 'Polygon' as const, coordinates: [PERU] }];
    const index = capped(shapes);
    expect(index).toHaveLength(2);
    expect(index[0].shape).toBe(shapes[0]);
    expect(index[0].cap).toEqual(capOf(PERU_SHAPE));
  });

  it('takes a boundary mesh apart into runs without losing one', () => {
    const runs = cappedRuns({
      type: 'MultiLineString',
      coordinates: [
        [
          [-70, -10],
          [-70, -12],
        ],
        [
          [139, 35],
          [140, 36],
        ],
      ],
    });
    expect(runs.map((run) => run.shape.coordinates)).toEqual([
      [
        [-70, -10],
        [-70, -12],
      ],
      [
        [139, 35],
        [140, 36],
      ],
    ]);
    // And each run answers for itself, which is the point: a frontier in Peru
    // and one in Japan are one geometry in the file and two questions here.
    const seen = { at: [-75, -11] as LngLat, radius: 0.1 };
    expect(runs.map((run) => capsMeet(run.cap, seen))).toEqual([true, false]);
  });
});
