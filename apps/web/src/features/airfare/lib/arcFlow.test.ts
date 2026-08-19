import { describe, expect, it } from 'vitest';

import {
  ARC_DASH_PERIOD,
  ARC_FLOW_SECONDS,
  flowDelay,
  polylineLength,
} from '@/features/airfare/lib/arcFlow';

/** The seconds back out of the string the stylesheet is handed. */
function seconds(delay: string): number {
  return Number(delay.replace(/s$/, ''));
}

describe('measuring a projected arc run', () => {
  it('adds up the segments, because that is what the browser strokes', () => {
    // A projected LineString is a polyline: the points that go in are the
    // vertices that come out, and its length is the sum of the sides.
    expect(polylineLength([[0, 0]])).toBe(0);
    expect(
      polylineLength([
        [0, 0],
        [3, 4],
        [3, 14],
      ]),
    ).toBeCloseTo(15);
  });

  it('has no length to report for a run of nothing', () => {
    // A run entirely off the projection contributes no points, and a phase
    // computed from `NaN` would silently stop every arc after it.
    expect(polylineLength([])).toBe(0);
  });
});

describe('the phase that keeps a cut arc flowing as one line', () => {
  it('puts the first run of an arc at the start of the pattern', () => {
    // A whole cycle back is the same place as no delay at all, and it keeps
    // every delay on the negative side, where the animation is already
    // running rather than waiting to.
    expect(seconds(flowDelay(0))).toBeCloseTo(-ARC_FLOW_SECONDS);
  });

  it('carries the pattern across a run boundary without a seam', () => {
    // The run after a whole number of periods is back in step with the first
    // one. This is the property the join at the limb depends on.
    for (const periods of [1, 2, 7]) {
      expect(flowDelay(ARC_DASH_PERIOD * periods)).toBe(flowDelay(0));
    }
  });

  it('advances the phase in proportion to how far along the arc a run starts', () => {
    // Half a period along the arc is half a cycle into the animation, which is
    // what makes the dashes on either side of a cut line up as one pattern.
    const half = seconds(flowDelay(ARC_DASH_PERIOD / 2));
    expect(half - seconds(flowDelay(0))).toBeCloseTo(ARC_FLOW_SECONDS / 2);

    const quarter = seconds(flowDelay(ARC_DASH_PERIOD / 4));
    expect(quarter - seconds(flowDelay(0))).toBeCloseTo(ARC_FLOW_SECONDS / 4);
  });

  it('never asks the animation to wait before it starts', () => {
    /*
     * A positive delay holds the first frame for up to a whole cycle. On a map
     * whose arcs are rebuilt on every frame of a drag that is a stutter on
     * every fragment, so the phase is always expressed as "already this far
     * in" rather than "not yet".
     */
    for (const before of [0, 0.4, 3.7, 12.5, 99.9]) {
      const delay = seconds(flowDelay(before));
      expect(delay).toBeLessThanOrEqual(0);
      expect(delay).toBeGreaterThanOrEqual(-ARC_FLOW_SECONDS);
    }
  });

  it('answers for a length nobody should be able to produce', () => {
    // A run measured as negative would come out of a projection returning
    // nonsense, and a `NaN` delay stops the arc dead rather than mispositions
    // it. The modulus is written to fold negatives back into the period.
    expect(seconds(flowDelay(-ARC_DASH_PERIOD / 2))).toBeCloseTo(-ARC_FLOW_SECONDS / 2);
  });
});
