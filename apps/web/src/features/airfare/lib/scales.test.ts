import { describe, expect, it } from 'vitest';

import {
  linePath,
  priceBand,
  priceTicks,
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

describe('linePath', () => {
  it('moves to the first point and lines to the rest', () => {
    const path = linePath(points(100, 200), { min: 100, max: 200 }, VIEWPORT);
    expect(path).toBe('M0.00 100.00 L100.00 0.00');
  });

  it('is empty for no points, so the chart draws nothing rather than a stray mark', () => {
    expect(linePath([], { min: 0, max: 1 }, VIEWPORT)).toBe('');
  });
});
