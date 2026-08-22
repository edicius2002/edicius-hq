import { describe, expect, it } from 'vitest';

import { PROJECTION_MONTHS, projectMonths } from '@/features/greenlight/lib/compound';
import {
  CURVE_VIEW,
  PLOT_BOTTOM,
  PLOT_LEFT,
  PLOT_RIGHT,
  PLOT_TOP,
  curveLayout,
  monthAtView,
} from '@/features/greenlight/lib/compoundCurve';

const CAPITAL = 20377.8;
const ROWS = projectMonths(CAPITAL, 6);

describe('where the curve is drawn', () => {
  const layout = curveLayout(ROWS, CAPITAL);

  it('spans the plot exactly, month 1 at the left edge and month 120 at the right', () => {
    expect(layout.points[0].x).toBeCloseTo(PLOT_LEFT, 10);
    expect(layout.points.at(-1)!.x).toBeCloseTo(PLOT_RIGHT, 10);
    expect(layout.points).toHaveLength(PROJECTION_MONTHS);
  });

  it('floors at the capital and tops out at the last balance', () => {
    expect(layout.floor).toBe(CAPITAL);
    expect(layout.top).toBeCloseTo(37075.3, 2);
    expect(layout.yAt(layout.floor)).toBeCloseTo(PLOT_BOTTOM, 10);
    expect(layout.yAt(layout.top)).toBeCloseTo(PLOT_TOP, 10);
  });

  it('gives every month about four view units', () => {
    expect(layout.step).toBeCloseTo((PLOT_RIGHT - PLOT_LEFT) / (PROJECTION_MONTHS - 1), 10);
    expect(layout.step).toBeCloseTo(4.2, 2);
  });

  /*
   * The measurement behind the honest note on this chart. Ten years at 6% is
   * 1.82x, and a curve that grows by less than double over its whole width does
   * not read as exponential — it reads as a line with a bend in it. Measured
   * here as the deepest the curve falls below the straight chord between its
   * two ends, so a future change to the axis cannot quietly flatten it further
   * without this going red.
   */
  it('bends about 7% of the plot away from a straight line, and no more', () => {
    const first = layout.points[0];
    const last = layout.points.at(-1)!;
    let deepest = 0;
    for (const point of layout.points) {
      const chordY = first.y + ((last.y - first.y) * (point.x - first.x)) / (last.x - first.x || 1);
      deepest = Math.max(deepest, point.y - chordY);
    }
    const plotH = PLOT_BOTTOM - PLOT_TOP;
    // 21.9 view units of bend in a plot 298 units tall, deepest at month 63.
    expect(plotH).toBe(298);
    expect(deepest).toBeCloseTo(21.87, 2);
    expect(deepest / plotH).toBeCloseTo(0.0734, 4);
  });

  it('draws a path that starts with a move and holds one point per month', () => {
    expect(layout.path.startsWith('M ')).toBe(true);
    expect(layout.path.split('L')).toHaveLength(PROJECTION_MONTHS);
  });

  it('does not divide by zero for a projection with nothing in it', () => {
    const flat = curveLayout([], 0);
    expect(flat.points).toEqual([]);
    expect(Number.isFinite(flat.yAt(0))).toBe(true);
  });
});

describe('the month a position names', () => {
  const layout = curveLayout(ROWS, CAPITAL);
  const at = (x: number) => monthAtView(x, ROWS.length, layout.step);

  it('reads back every month it drew', () => {
    for (const point of layout.points) {
      expect(at(point.x)).toBe(point.month);
    }
  });

  it('snaps rather than interpolating — there is no month 60.4', () => {
    expect(at(layout.xAt(60) + 1)).toBe(60);
    expect(at(layout.xAt(60) + layout.step * 0.9)).toBe(61);
  });

  it('gives a tie to the earlier month, so a shaking hand does not flicker', () => {
    /*
     * A step of exactly 4 rather than the real 4.2017, so the midpoint is
     * representable and the assertion is about the tie-break rather than about
     * which side of it floating point happened to land on.
     */
    const midpoint = PLOT_LEFT + 59 * 4 + 2;
    expect(monthAtView(midpoint, 120, 4)).toBe(60);
    expect(monthAtView(midpoint + 0.01, 120, 4)).toBe(61);
    expect(monthAtView(midpoint - 0.01, 120, 4)).toBe(60);
  });

  it('clamps to the series rather than reading off the ends of it', () => {
    expect(at(-1000)).toBe(1);
    expect(at(PLOT_LEFT - 40)).toBe(1);
    expect(at(CURVE_VIEW.width + 1000)).toBe(PROJECTION_MONTHS);
  });

  it('answers month 1 for a series it cannot space out', () => {
    expect(monthAtView(400, 1, 0)).toBe(1);
    expect(monthAtView(400, 0, 4)).toBe(1);
  });
});
