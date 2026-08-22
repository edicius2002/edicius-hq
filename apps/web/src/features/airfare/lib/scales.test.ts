import { describe, expect, it } from 'vitest';

import {
  linePath,
  observedEnds,
  priceBand,
  niceTicks,
  priceTicks,
  ticksClear,
  xAt,
  yAt,
  type Viewport,
} from '@/features/airfare/lib/scales';
import type { PricePoint } from '@/features/airfare/lib/series';

const VIEWPORT: Viewport = {
  width: 100,
  height: 100,
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
};

function points(...prices: number[]): PricePoint[] {
  return prices.map((price, index) => ({
    capturedAt: `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00+00:00`,
    price,
    currency: 'USD',
  }));
}

describe('priceBand', () => {
  it('frames the series rather than anchoring at zero', () => {
    // A 600–700 series drawn from zero is a flat line across the top, which
    // hides exactly the movement the page exists to show.
    const band = priceBand(points(600, 700));
    expect(band.min).toBeGreaterThan(0);
    expect(band.min).toBeLessThan(600);
    expect(band.max).toBeGreaterThan(700);
  });

  it('gives a flat series a band to sit in rather than a zero-height one', () => {
    const band = priceBand(points(125, 125, 125));
    expect(band.max).toBeGreaterThan(band.min);
  });

  it('has a usable default for no points at all', () => {
    expect(priceBand([])).toEqual({ min: 0, max: 1 });
  });
});

describe('xAt', () => {
  it('spreads observations across the usable width', () => {
    expect(xAt(0, 3, VIEWPORT)).toBe(0);
    expect(xAt(1, 3, VIEWPORT)).toBe(50);
    expect(xAt(2, 3, VIEWPORT)).toBe(100);
  });

  it('centres a single observation instead of pinning it to the left edge', () => {
    // Hard against the frame it reads as the start of a line that is not there.
    expect(xAt(0, 1, VIEWPORT)).toBe(50);
  });
});

describe('yAt', () => {
  it('puts the cheaper price lower on the screen', () => {
    const band = { min: 100, max: 200 };
    expect(yAt(200, band, VIEWPORT)).toBe(0);
    expect(yAt(100, band, VIEWPORT)).toBe(100);
    expect(yAt(150, band, VIEWPORT)).toBe(50);
  });

  it('does not divide by nothing when the band is flat', () => {
    expect(Number.isFinite(yAt(125, { min: 125, max: 125 }, VIEWPORT))).toBe(true);
  });
});

describe('priceTicks', () => {
  it('spans the band inclusively', () => {
    const ticks = priceTicks({ min: 100, max: 200 }, 3);
    expect(ticks).toEqual([100, 150, 200]);
  });
});

describe('niceTicks', () => {
  it('labels the real horizon at round numbers instead of at the padding term', () => {
    /*
     * The measured case, and the reason this function exists. The booking
     * horizon on the owner's ARI–SCL watch runs $41.24 to $196.33; the chart
     * pads that by 18.61 either side so the extremes are not drawn on the
     * frame, and the three labels it printed were the padded ends and their
     * midpoint — $22.63, $118.79, $214.94. Not one of them is a fare anybody
     * was quoted, and all three were set in the same money format as the fares
     * that were.
     */
    const ticks = niceTicks(41.24 - 18.61, 196.33 + 18.61);
    expect(ticks).toEqual([50, 100, 150, 200]);
    expect(ticks.every((tick) => tick % 50 === 0)).toBe(true);
  });

  it('keeps every tick inside the range it is given', () => {
    for (const tick of niceTicks(117.4, 348.9)) {
      expect(tick).toBeGreaterThanOrEqual(117.4);
      expect(tick).toBeLessThanOrEqual(348.9);
    }
  });

  it('scales the step to the series rather than to the decimal system', () => {
    // A band of 612 to 748 wants ticks at its own scale, not at 0, 500, 1000 —
    // two of which are off the chart. `priceTicks` above states the same rule.
    expect(niceTicks(612, 748)).toEqual([625, 650, 675, 700, 725]);
    expect(niceTicks(0.94, 1.42)).toEqual([1, 1.2, 1.4]);
  });

  it('does not drift off its own step through floating point', () => {
    expect(niceTicks(0.05, 0.55)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it('has nothing to draw for a range with no width', () => {
    expect(niceTicks(120, 120)).toEqual([]);
    expect(niceTicks(200, 100)).toEqual([]);
    expect(niceTicks(Number.NaN, 100)).toEqual([]);
  });
});

describe('linePath', () => {
  it('moves to the first point and lines to the rest', () => {
    const path = linePath(points(100, 200), { min: 100, max: 200 }, VIEWPORT);
    expect(path).toBe('M0.00 100.00 L100.00 0.00');
  });

  it('is empty for no points, so the chart draws nothing rather than a stray mark', () => {
    expect(linePath([], { min: 0, max: 1 }, VIEWPORT)).toBe('');
  });
});

describe('observedEnds', () => {
  it('is the cheapest and the dearest of what is drawn, and not the padded domain', () => {
    // The two figures the axis may state as figures. Both are prices in the
    // list, which is the whole of what separates them from `niceTicks`'s
    // refusal — that one is about numbers the padding invented.
    expect(observedEnds([210, 195.5, 310, 240])).toEqual({ low: 195.5, high: 310 });
  });

  it('is one figure twice where every fare on the frame is the same', () => {
    expect(observedEnds([88])).toEqual({ low: 88, high: 88 });
  });

  it('is nothing at all for a frame with no price on it', () => {
    expect(observedEnds([])).toBeNull();
  });
});

describe('ticksClear', () => {
  it('drops the tick whose label would land on a stated figure', () => {
    // ARI-SCL's March frame, near enough: $62.77 to $69.26 with round ticks at
    // $62.50 and $70. Both are within half a dollar of an end and both go.
    expect(ticksClear([62.5, 65, 67.5, 70], [62.77, 69.26], 1.5)).toEqual([65, 67.5]);
  });

  it('keeps everything where nothing is stated', () => {
    expect(ticksClear([200, 250, 300], [], 6)).toEqual([200, 250, 300]);
  });

  it('measures the gap from every stated figure, not only the nearest end', () => {
    expect(ticksClear([100, 200, 300], [205], 10)).toEqual([100, 300]);
  });

  it('keeps a tick exactly a gap away, so the rule has one edge and not two', () => {
    expect(ticksClear([100], [110], 10)).toEqual([100]);
  });
});
