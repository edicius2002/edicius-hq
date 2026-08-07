import { describe, expect, it } from 'vitest';

import {
  bollinger,
  closesOf,
  ema,
  extentOf,
  hasIntradaySessions,
  macd,
  rsi,
  sma,
  vwap,
} from '@/features/investing/lib/indicators';
import type { Bar } from '@/shared/api/market';

function series(values: number[]): Float64Array {
  return Float64Array.from(values);
}

/** Defined values only, rounded, so a test reads like the line it describes. */
function defined(values: Float64Array, places = 2): number[] {
  return [...values].filter((v) => !Number.isNaN(v)).map((v) => Number(v.toFixed(places)));
}

function bar(over: Partial<Bar> = {}): Bar {
  return { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 0, ...over };
}

describe('sma', () => {
  it('averages the window and starts only once the window is full', () => {
    const out = sma(series([1, 2, 3, 4, 5]), 3);

    // Nothing is invented for the first two bars: the array is bar-length and
    // says NaN, rather than being shorter and making callers track an offset.
    expect(out).toHaveLength(5);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(defined(out)).toEqual([2, 3, 4]);
  });

  it('says nothing at all when there are fewer bars than the period', () => {
    expect(defined(sma(series([1, 2]), 5))).toEqual([]);
  });

  it('rolls the sum rather than drifting', () => {
    // A rolling sum that subtracted wrongly would accumulate error over a long
    // flat run; this asserts the window is exactly the last n.
    const flat = sma(series(Array.from({ length: 500 }, (_, i) => (i < 250 ? 10 : 20))), 10);

    expect(flat[249]).toBeCloseTo(10);
    expect(flat[499]).toBeCloseTo(20);
  });
});

describe('ema', () => {
  it('seeds from the simple average of the first window', () => {
    // Seeding from one bar would let an opening print drag the line for
    // dozens of periods; every charting package seeds from the mean.
    const out = ema(series([1, 2, 3, 4, 5]), 3);

    expect(out[2]).toBeCloseTo(2);
  });

  it('weights the newest bar by 2/(period+1)', () => {
    const out = ema(series([1, 2, 3, 4]), 3);

    // seed 2, then 2 + (4 - 2) * 0.5 = 3
    expect(out[3]).toBeCloseTo(3);
  });

  it('follows a step change without overshooting it', () => {
    const out = ema(series([...Array(50).fill(10), ...Array(50).fill(20)]), 10);

    expect(out[99]).toBeGreaterThan(19);
    expect(out[99]).toBeLessThanOrEqual(20);
  });
});

describe('bollinger', () => {
  it('puts the basis on the average and the bands a deviation either side', () => {
    const { basis, upper, lower } = bollinger(series([2, 4, 6]), 3, 2);

    // mean 4, population deviation √(8/3) ≈ 1.633
    expect(basis[2]).toBeCloseTo(4);
    expect(upper[2]).toBeCloseTo(4 + 2 * 1.633, 2);
    expect(lower[2]).toBeCloseTo(4 - 2 * 1.633, 2);
  });

  it('collapses the bands onto the basis when nothing moved', () => {
    // The rolling sum-of-squares identity can round to a slightly negative
    // variance on a flat window; clamped, it must give exactly the basis and
    // never NaN from a square root of a negative.
    const flat = Float64Array.from(Array(60).fill(731.42));
    const { basis, upper, lower } = bollinger(flat, 20, 2);

    expect(upper[59]).toBeCloseTo(731.42, 6);
    expect(lower[59]).toBeCloseTo(731.42, 6);
    expect(basis[59]).toBeCloseTo(731.42, 6);
    expect(Number.isNaN(upper[59])).toBe(false);
  });

  it('stays quiet until the window is full', () => {
    const { basis } = bollinger(series([1, 2, 3]), 20);

    expect(defined(basis)).toEqual([]);
  });
});

describe('vwap', () => {
  it('weights by volume rather than averaging the prices', () => {
    const out = vwap([
      bar({ time: 0, high: 10, low: 10, close: 10, volume: 1 }),
      bar({ time: 60, high: 20, low: 20, close: 20, volume: 3 }),
    ]);

    // (10·1 + 20·3) / 4 = 17.5, not the 15 a plain average would give.
    expect(out[1]).toBeCloseTo(17.5);
  });

  it('resets at the day boundary', () => {
    const day = 86_400;
    const out = vwap([
      bar({ time: 0, high: 10, low: 10, close: 10, volume: 100 }),
      bar({ time: day, high: 50, low: 50, close: 50, volume: 1 }),
    ]);

    // Carrying yesterday over would make this an average of a week, which is
    // not what anyone means by a session VWAP.
    expect(out[1]).toBeCloseTo(50);
  });

  it('falls back to the typical price when nothing traded', () => {
    const out = vwap([bar({ high: 12, low: 6, close: 9, volume: 0 })]);

    expect(out[0]).toBeCloseTo(9);
  });

  it('is offered intraday only', () => {
    // Daily and longer, every bar is its own session and a session VWAP
    // degenerates to the typical price.
    expect(hasIntradaySessions('15m')).toBe(true);
    expect(hasIntradaySessions('1d')).toBe(false);
    expect(hasIntradaySessions('1M')).toBe(false);
  });
});

describe('rsi', () => {
  it('reads 100 on a run that never fell', () => {
    const out = rsi(series(Array.from({ length: 30 }, (_, i) => i + 1)), 14);

    // No losses means no ratio to take; the limit is 100, not a divide by zero
    // that would draw a gap in the middle of an unbroken run.
    expect(out[29]).toBeCloseTo(100);
  });

  it('reads 0 on a run that never rose', () => {
    const out = rsi(series(Array.from({ length: 30 }, (_, i) => 100 - i)), 14);

    expect(out[29]).toBeCloseTo(0);
  });

  it('sits at the midpoint when nothing moves at all', () => {
    const out = rsi(Float64Array.from(Array(30).fill(50)), 14);

    expect(out[29]).toBeCloseTo(50);
  });

  it('matches the published worked example', () => {
    /*
     * Wilder's series, the one every implementation is checked against. The
     * first value is derivable by hand and worth showing, because it is what
     * pins the smoothing: over the first 14 changes the gains total 3.34 and
     * the losses 1.40, so RS = (3.34/14) / (1.40/14) = 2.3857 and
     * RSI = 100 - 100/3.3857 = 70.46.
     */
    const closes = series([
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
      46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
    ]);

    const out = rsi(closes, 14);

    expect(out[14]).toBeCloseTo(70.4641, 3);
    // And five bars of Wilder smoothing later, computed independently.
    expect(out[19]).toBeCloseTo(57.915, 3);
  });

  it('needs one more bar than its period before it can speak', () => {
    // 14 changes need 15 closes. Fewer means the line starts later, never that
    // a value is invented.
    expect(defined(rsi(series(Array(14).fill(1)), 14))).toEqual([]);
    expect(defined(rsi(Float64Array.from(Array(15).fill(1)), 14))).toHaveLength(1);
  });
});

describe('macd', () => {
  it('is the gap between the fast and slow averages', () => {
    const values = series(Array.from({ length: 100 }, (_, i) => 100 + i));
    const { macd: line } = macd(values, 12, 26, 9);

    const fast = ema(values, 12);
    const slow = ema(values, 26);

    expect(line[99]).toBeCloseTo(fast[99] - slow[99]);
  });

  it('starts the line at the slow period and the signal later still', () => {
    const values = series(Array.from({ length: 60 }, (_, i) => 100 + i));
    const { macd: line, signal } = macd(values, 12, 26, 9);

    // The line begins where the slow average does, at index 25. The signal is
    // an EMA of the line, so it needs nine of those before it can speak:
    // 25 + 9 - 1 = 33.
    expect(Number.isNaN(line[24])).toBe(true);
    expect(Number.isNaN(line[25])).toBe(false);
    expect(Number.isNaN(signal[32])).toBe(true);
    expect(Number.isNaN(signal[33])).toBe(false);
  });

  it('computes the signal over the defined stretch, not over the NaNs', () => {
    // Running an EMA across leading NaNs would poison every value after it.
    const values = series(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 5));
    const { signal, histogram } = macd(values);

    expect([...signal].some(Number.isNaN)).toBe(true);
    expect(defined(signal).every(Number.isFinite)).toBe(true);
    expect(defined(histogram).every(Number.isFinite)).toBe(true);
  });

  it('has the histogram as the gap between line and signal', () => {
    const values = series(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 8));
    const { macd: line, signal, histogram } = macd(values);

    expect(histogram[79]).toBeCloseTo(line[79] - signal[79]);
  });

  it('says nothing at all below the slow period', () => {
    const { macd: line } = macd(series(Array.from({ length: 10 }, (_, i) => i)), 12, 26, 9);

    expect(defined(line)).toEqual([]);
  });
});

describe('extentOf', () => {
  it('ignores the bars an indicator cannot speak for', () => {
    const out = extentOf([series([Number.NaN, Number.NaN, 5, 9])], 0, 3);

    expect(out).toEqual([5, 9]);
  });

  it('spans every series it is given', () => {
    expect(extentOf([series([1, 2]), series([-4, 7])], 0, 1)).toEqual([-4, 7]);
  });

  it('answers something usable when there is nothing defined', () => {
    // A pane still has to be drawn; a scale of zero height would divide by it.
    expect(extentOf([series([Number.NaN])], 0, 0)).toEqual([0, 1]);
  });

  it('only looks at the visible window', () => {
    const out = extentOf([series([100, 1, 2, 3, 500])], 1, 3);

    expect(out).toEqual([1, 3]);
  });
});

describe('closesOf', () => {
  it('lifts the closes into an array the indicators can walk', () => {
    const out = closesOf([bar({ close: 1 }), bar({ close: 2 })]);

    expect(out).toBeInstanceOf(Float64Array);
    expect([...out]).toEqual([1, 2]);
  });
});
