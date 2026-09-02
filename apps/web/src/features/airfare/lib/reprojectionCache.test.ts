import { geoOrthographic, type GeoProjection } from 'd3-geo';
import { describe, expect, it } from 'vitest';

import {
  IDENTITY_MATRIX,
  REFERENCE_GEOMETRY_WEIGHT,
  ROTATE_REBUILD_MS,
  affineMatrix,
  anyStale,
  applyMatrix,
  decideReuse,
  forcesDegrade,
  geometryWeight,
  rotateThrottleMs,
  sameRotation,
  sameSelection,
  standInFor,
  strokesInnerBorders,
  type ProjectionSnapshot,
} from './reprojectionCache';

function snapshotOf(projection: GeoProjection): ProjectionSnapshot {
  return {
    rotation: projection.rotate(),
    scale: projection.scale(),
    translate: projection.translate(),
  };
}

describe('affineMatrix', () => {
  it('reproduces a full reprojection exactly, point for point, when only scale and translate change', () => {
    const from = geoOrthographic().rotate([10, 20, 0]).scale(200).translate([300, 300]);
    const to = geoOrthographic().rotate([10, 20, 0]).scale(340).translate([120, 260]);

    // A handful of points inside the visible hemisphere of both projections.
    const points: [number, number][] = [
      [15, -8],
      [40, 30],
      [-5, 5],
      [0, 0],
    ];

    const matrix = affineMatrix(snapshotOf(from), snapshotOf(to));

    for (const point of points) {
      const oldScreen = from(point);
      const newScreenDirect = to(point);
      expect(oldScreen).not.toBeNull();
      expect(newScreenDirect).not.toBeNull();

      const newScreenViaMatrix = applyMatrix(matrix, oldScreen as [number, number]);
      expect(newScreenViaMatrix[0]).toBeCloseTo((newScreenDirect as number[])[0], 9);
      expect(newScreenViaMatrix[1]).toBeCloseTo((newScreenDirect as number[])[1], 9);
    }
  });

  it('is the identity when nothing about the projection changed', () => {
    const snapshot = snapshotOf(
      geoOrthographic().rotate([5, 5, 0]).scale(250).translate([100, 100]),
    );
    expect(affineMatrix(snapshot, snapshot)).toEqual(IDENTITY_MATRIX);
  });

  it('would misplace the point if applied across a rotation change — the reason the caller must gate on sameRotation', () => {
    const from = geoOrthographic().rotate([10, 20, 0]).scale(200).translate([300, 300]);
    const to = geoOrthographic().rotate([40, 20, 0]).scale(200).translate([300, 300]);
    const point: [number, number] = [15, -8];

    const matrix = affineMatrix(snapshotOf(from), snapshotOf(to));
    const viaMatrix = applyMatrix(matrix, from(point) as [number, number]);
    const direct = to(point) as [number, number];

    // Not close at all: a rotation moves each point by a different amount, so
    // no single affine map can stand in for it. This is exactly why
    // `decideReuse` never returns `reuse` across a rotation change.
    expect(Math.hypot(viaMatrix[0] - direct[0], viaMatrix[1] - direct[1])).toBeGreaterThan(5);
  });
});

describe('sameRotation', () => {
  it('is true only when every axis matches', () => {
    expect(sameRotation([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameRotation([1, 2, 3], [1, 2, 0])).toBe(false);
    expect(sameRotation([0, 0, 0], [0, 0, 0])).toBe(true);
  });
});

describe('sameSelection', () => {
  it('is true only when every included flag matches, in the same order', () => {
    expect(sameSelection([true, false], [true, false])).toBe(true);
    expect(sameSelection([true, false], [true, true])).toBe(false);
    expect(sameSelection([], [])).toBe(true);
    expect(sameSelection([true], [true, false])).toBe(false);
  });
});

describe('decideReuse', () => {
  const snapshot: ProjectionSnapshot = { rotation: [0, 0, 0], scale: 200, translate: [100, 100] };
  const mainlandOnly = [true, false]; // e.g. Chile's mainland in view, Easter Island not.

  it('rebuilds when nothing is cached yet', () => {
    expect(decideReuse(undefined, 'usa', snapshot, 0, ROTATE_REBUILD_MS, mainlandOnly, [])).toEqual(
      { kind: 'rebuild' },
    );
  });

  it('rebuilds when the underlying data changed, even under the same projection', () => {
    const cached = {
      of: 'usa-v1',
      snapshot,
      builtAt: 0,
      includedLand: mainlandOnly,
      includedBorders: [],
    };
    expect(decideReuse(cached, 'usa-v2', snapshot, 0, ROTATE_REBUILD_MS, mainlandOnly, [])).toEqual(
      { kind: 'rebuild' },
    );
  });

  it('reuses through an affine map when the rotation is unchanged, however different scale or pan are', () => {
    const cached = {
      of: 'usa',
      snapshot,
      builtAt: 0,
      includedLand: mainlandOnly,
      includedBorders: [],
    };
    const moved: ProjectionSnapshot = { rotation: [0, 0, 0], scale: 500, translate: [10, 10] };

    const decision = decideReuse(cached, 'usa', moved, 1000, ROTATE_REBUILD_MS, mainlandOnly, []);
    expect(decision.kind).toBe('reuse');
    if (decision.kind === 'reuse') {
      expect(decision.matrix).toEqual(affineMatrix(snapshot, moved));
    }
  });

  it('rebuilds instead of reusing when a piece crossed into or out of view, even with the rotation unchanged', () => {
    // Easter Island just came into view: the cached Path2D never drew it, and
    // no affine map can add vertices that were never in the path.
    const cached = {
      of: 'chile',
      snapshot,
      builtAt: 0,
      includedLand: [true, false],
      includedBorders: [],
    };
    const bothVisible = [true, true];

    expect(
      decideReuse(cached, 'chile', snapshot, 1000, ROTATE_REBUILD_MS, bothVisible, []),
    ).toEqual({ kind: 'rebuild' });
  });

  it('draws the stale shape unmoved when rotation just changed, inside the throttle window', () => {
    const cached = {
      of: 'usa',
      snapshot,
      builtAt: 1000,
      includedLand: mainlandOnly,
      includedBorders: [],
    };
    const rotated: ProjectionSnapshot = { rotation: [5, 0, 0], scale: 200, translate: [100, 100] };

    expect(
      decideReuse(
        cached,
        'usa',
        rotated,
        1000 + ROTATE_REBUILD_MS - 1,
        ROTATE_REBUILD_MS,
        mainlandOnly,
        [],
      ),
    ).toEqual({ kind: 'stale' });
  });

  it('rebuilds once the throttle window has passed since the last build', () => {
    const cached = {
      of: 'usa',
      snapshot,
      builtAt: 1000,
      includedLand: mainlandOnly,
      includedBorders: [],
    };
    const rotated: ProjectionSnapshot = { rotation: [5, 0, 0], scale: 200, translate: [100, 100] };

    expect(
      decideReuse(
        cached,
        'usa',
        rotated,
        1000 + ROTATE_REBUILD_MS,
        ROTATE_REBUILD_MS,
        mainlandOnly,
        [],
      ),
    ).toEqual({ kind: 'rebuild' });
  });
});

describe('geometryWeight', () => {
  it('counts every point in every land ring and every border run, and nothing else', () => {
    const landParts = [
      {
        shape: {
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      }, // one ring, 4 points
      {
        shape: {
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ], // outer ring, 4 points
            [
              [0.2, 0.2],
              [0.3, 0.2],
              [0.2, 0.2],
            ], // a hole, 3 points
          ],
        },
      },
    ];
    const borderRuns = [
      {
        shape: {
          coordinates: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        },
      }, // 3 points
      {
        shape: {
          coordinates: [
            [5, 5],
            [6, 6],
          ],
        },
      }, // 2 points
    ];

    expect(geometryWeight(landParts, borderRuns)).toBe(4 + 4 + 3 + 3 + 2);
  });

  it('is zero for a country with no land and no borders', () => {
    expect(geometryWeight([], [])).toBe(0);
  });
});

describe('rotateThrottleMs', () => {
  it('gives the reference weight exactly ROTATE_REBUILD_MS — the heaviest country on file sees no regression', () => {
    expect(rotateThrottleMs(REFERENCE_GEOMETRY_WEIGHT)).toBe(ROTATE_REBUILD_MS);
  });

  it('scales down linearly for a lighter country', () => {
    const aFifth = REFERENCE_GEOMETRY_WEIGHT / 5;
    expect(rotateThrottleMs(aFifth)).toBeCloseTo(ROTATE_REBUILD_MS / 5, 6);
  });

  it('is zero for weightless geometry, so it never lags a spin', () => {
    expect(rotateThrottleMs(0)).toBe(0);
  });

  it('never exceeds ROTATE_REBUILD_MS, even for a country heavier than the calibration point', () => {
    expect(rotateThrottleMs(REFERENCE_GEOMETRY_WEIGHT * 10)).toBe(ROTATE_REBUILD_MS);
  });
});

describe('decideReuse with a weight-scaled throttle', () => {
  const snapshot: ProjectionSnapshot = { rotation: [0, 0, 0], scale: 200, translate: [100, 100] };
  const included = [true];

  it('a country light enough rebuilds instead of drawing stale, where the reference-weight country would still be throttled', () => {
    const cached = {
      of: 'el-salvador',
      snapshot,
      builtAt: 1000,
      includedLand: included,
      includedBorders: [],
    };
    const rotated: ProjectionSnapshot = { rotation: [5, 0, 0], scale: 200, translate: [100, 100] };
    const lightThrottle = rotateThrottleMs(1_031); // El Salvador's measured weight
    const now = 1000 + lightThrottle + 1; // just past this country's own throttle...
    expect(now - 1000).toBeLessThan(ROTATE_REBUILD_MS); // ...but well inside the flat constant

    expect(decideReuse(cached, 'el-salvador', rotated, now, lightThrottle, included, [])).toEqual({
      kind: 'rebuild',
    });
    // The same elapsed time, at the flat throttle every country used to share, would still be stale.
    expect(
      decideReuse(cached, 'el-salvador', rotated, now, ROTATE_REBUILD_MS, included, []),
    ).toEqual({ kind: 'stale' });
  });
});

describe('standInFor', () => {
  it('prefers the coarse outline, because it can be drawn where the country actually is', () => {
    expect(standInFor(true)).toBe('coarse-outline');
  });

  it('falls back to the held fine shape when there is no outline to stand in', () => {
    expect(standInFor(false)).toBe('frozen-fine');
  });
});

describe('strokesInnerBorders', () => {
  /*
   * This is the pairing worth pinning down, and the one a later edit is most
   * likely to undo: the borders look like detail somebody removed for no
   * reason, and putting them back costs nothing until you spin the globe.
   *
   * They are 1:10m lines built under an earlier rotation. Over a coarse
   * outline that was reprojected this frame, the two disagree by exactly the
   * drift the outline was brought in to remove — state borders drawn crossing
   * the coast instead of following it, which reads worse than the drift did.
   */
  it('keeps the held-back admin borders off a freshly reprojected outline', () => {
    expect(strokesInnerBorders('coarse-outline')).toBe(false);
  });

  it('strokes them over the frozen fine shape, which is stale the same way they are', () => {
    expect(strokesInnerBorders('frozen-fine')).toBe(true);
  });

  it('draws borders in exactly one of the two stand-ins', () => {
    // Neither both nor neither: a country in a held-back frame shows its admin
    // borders if and only if its coastline is the one they were built against.
    const both = [standInFor(true), standInFor(false)].map(strokesInnerBorders);
    expect(both.filter(Boolean)).toHaveLength(1);
  });
});

describe('anyStale', () => {
  it('is false when nothing is held back', () => {
    expect(anyStale([{ kind: 'reuse', matrix: IDENTITY_MATRIX }, { kind: 'rebuild' }])).toBe(false);
  });

  it('is false with nothing on screen to redraw at all', () => {
    expect(anyStale([])).toBe(false);
  });

  it('is true the moment any one country is held back, even among others that are not', () => {
    // The whole point: one neighbour answering `stale` outvotes the rest, so
    // the caller degrades every one of them together rather than mixing
    // resolutions across a shared frontier.
    expect(
      anyStale([
        { kind: 'reuse', matrix: IDENTITY_MATRIX },
        { kind: 'stale' },
        { kind: 'rebuild' },
      ]),
    ).toBe(true);
  });

  it('is true when it is the only country on screen', () => {
    expect(anyStale([{ kind: 'stale' }])).toBe(true);
  });
});

describe('forcesDegrade', () => {
  it('is true for the whole gesture, independently of the grace window', () => {
    // A pointer that is still down forces coarse no matter what `until` says
    // — including a stale one left over from an earlier gesture.
    expect(forcesDegrade('rotate', 1000, 0)).toBe(true);
    expect(forcesDegrade('rotate', 1000, 2000)).toBe(true);
  });

  it('is true during the grace window after the gesture ends', () => {
    expect(forcesDegrade(undefined, 1000, 1250)).toBe(true);
  });

  it('is false once the grace window has passed with no gesture held', () => {
    expect(forcesDegrade(undefined, 1250, 1250)).toBe(false);
    expect(forcesDegrade(undefined, 1251, 1250)).toBe(false);
  });

  it('is false at rest, with no gesture and no grace window pending', () => {
    expect(forcesDegrade(undefined, 1000, 0)).toBe(false);
  });

  it('is false for a pan gesture, which never mismatches resolution to begin with', () => {
    // The flat map's rotation never changes, so `decideReuse` always answers
    // `reuse` for it; forcing coarse during a pan would degrade a gesture
    // that was never the one this rule exists for.
    expect(forcesDegrade('pan', 1000, 0)).toBe(false);
  });
});
