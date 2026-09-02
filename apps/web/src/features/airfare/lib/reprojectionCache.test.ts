import { geoOrthographic, type GeoProjection } from 'd3-geo';
import { describe, expect, it } from 'vitest';

import {
  IDENTITY_MATRIX,
  ROTATE_REBUILD_MS,
  affineMatrix,
  applyMatrix,
  decideReuse,
  sameRotation,
  sameSelection,
  type ProjectionSnapshot,
} from './reprojectionCache';

function snapshotOf(projection: GeoProjection): ProjectionSnapshot {
  return {
    rotation: projection.rotate() as [number, number, number],
    scale: projection.scale(),
    translate: projection.translate() as [number, number],
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
    const snapshot = snapshotOf(geoOrthographic().rotate([5, 5, 0]).scale(250).translate([100, 100]));
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
    expect(
      decideReuse(undefined, 'usa', snapshot, 0, ROTATE_REBUILD_MS, mainlandOnly, []),
    ).toEqual({ kind: 'rebuild' });
  });

  it('rebuilds when the underlying data changed, even under the same projection', () => {
    const cached = { of: 'usa-v1', snapshot, builtAt: 0, includedLand: mainlandOnly, includedBorders: [] };
    expect(
      decideReuse(cached, 'usa-v2', snapshot, 0, ROTATE_REBUILD_MS, mainlandOnly, []),
    ).toEqual({ kind: 'rebuild' });
  });

  it('reuses through an affine map when the rotation is unchanged, however different scale or pan are', () => {
    const cached = { of: 'usa', snapshot, builtAt: 0, includedLand: mainlandOnly, includedBorders: [] };
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
    const cached = { of: 'chile', snapshot, builtAt: 0, includedLand: [true, false], includedBorders: [] };
    const bothVisible = [true, true];

    expect(
      decideReuse(cached, 'chile', snapshot, 1000, ROTATE_REBUILD_MS, bothVisible, []),
    ).toEqual({ kind: 'rebuild' });
  });

  it('draws the stale shape unmoved when rotation just changed, inside the throttle window', () => {
    const cached = { of: 'usa', snapshot, builtAt: 1000, includedLand: mainlandOnly, includedBorders: [] };
    const rotated: ProjectionSnapshot = { rotation: [5, 0, 0], scale: 200, translate: [100, 100] };

    expect(
      decideReuse(cached, 'usa', rotated, 1000 + ROTATE_REBUILD_MS - 1, ROTATE_REBUILD_MS, mainlandOnly, []),
    ).toEqual({ kind: 'stale' });
  });

  it('rebuilds once the throttle window has passed since the last build', () => {
    const cached = { of: 'usa', snapshot, builtAt: 1000, includedLand: mainlandOnly, includedBorders: [] };
    const rotated: ProjectionSnapshot = { rotation: [5, 0, 0], scale: 200, translate: [100, 100] };

    expect(
      decideReuse(cached, 'usa', rotated, 1000 + ROTATE_REBUILD_MS, ROTATE_REBUILD_MS, mainlandOnly, []),
    ).toEqual({ kind: 'rebuild' });
  });
});
