import { describe, expect, it } from 'vitest';

import {
  barWidth,
  clampWindow,
  indexAt,
  MAX_SLOT_PX,
  MIN_VISIBLE_BARS,
  minVisibleBars,
  panWindow,
  priceRange,
  priceScale,
  priceTicks,
  timeTicks,
  slotWidth,
  visibleBars,
  wickWidth,
  xAt,
  zoomWindow,
} from '@/features/investing/lib/scales';
import type { Bar } from '@/shared/api/market';

const PLOT = { width: 800, height: 400 };

function bar(time: number, low: number, high: number): Bar {
  return { time, open: low, high, low, close: high, volume: 1 };
}

function series(count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => bar(i, 100 + i, 110 + i));
}

describe('clampWindow', () => {
  it('keeps the window inside the series', () => {
    expect(clampWindow({ first: -50, last: 30 }, 100)).toEqual({ first: 0, last: 80 });
  });

  it('anchors to the right edge rather than floating past it', () => {
    const window = clampWindow({ first: 90, last: 140 }, 100);
    expect(window.last).toBe(100);
    expect(window.last - window.first).toBe(50);
  });

  it('never shows fewer bars than are readable', () => {
    const window = clampWindow({ first: 0, last: 2 }, 100);
    expect(window.last - window.first).toBe(MIN_VISIBLE_BARS);
  });

  it('shows the whole series when it is shorter than the window', () => {
    expect(clampWindow({ first: 0, last: 500 }, 20)).toEqual({ first: 0, last: 20 });
  });
});

describe('xAt and indexAt', () => {
  const window = { first: 0, last: 100 };

  it('places a bar in the middle of its slot', () => {
    // The first of a hundred slots across 800px is 8px wide, centred at 4.
    expect(xAt(0, window, PLOT)).toBeCloseTo(4);
    expect(xAt(99, window, PLOT)).toBeCloseTo(796);
  });

  it('reads back the index it drew', () => {
    for (const index of [0, 17, 55, 99]) {
      expect(indexAt(xAt(index, window, PLOT), window, PLOT)).toBeCloseTo(index, 6);
    }
  });

  it('survives a fractional window, which is what panning produces', () => {
    const panned = { first: 12.4, last: 62.4 };
    expect(indexAt(xAt(30, panned, PLOT), panned, PLOT)).toBeCloseTo(30, 6);
  });
});

describe('barWidth', () => {
  it('leaves a gap so candles read as separate bars', () => {
    const width = barWidth({ first: 0, last: 100 }, PLOT);
    expect(width).toBeLessThan(PLOT.width / 100);
    expect(width).toBeGreaterThan(0);
  });

  it('stays visible while its slot can hold a pixel', () => {
    expect(barWidth({ first: 0, last: 500 }, PLOT)).toBeGreaterThanOrEqual(1);
  });

  it('shrinks below a pixel rather than overflowing its slot', () => {
    // The old rule floored every candle at 1px, which past a thousand bars made
    // each one paint over its neighbour. Sub-pixel and antialiased is honest;
    // overlapping is not.
    const window = { first: 0, last: 5000 };
    expect(barWidth(window, PLOT)).toBeLessThanOrEqual(slotWidth(window, PLOT));
    expect(barWidth(window, PLOT)).toBeGreaterThan(0);
  });
});

describe('priceRange', () => {
  it('covers every high and low with room to breathe', () => {
    const range = priceRange([bar(0, 100, 110), bar(1, 90, 120)], 0.1);
    expect(range.min).toBeLessThan(90);
    expect(range.max).toBeGreaterThan(120);
  });

  it('gives a flat series a range instead of collapsing it', () => {
    const range = priceRange([bar(0, 50, 50), bar(1, 50, 50)]);
    expect(range.max).toBeGreaterThan(range.min);
  });

  it('has something to draw even with no bars at all', () => {
    const range = priceRange([]);
    expect(range.max).toBeGreaterThan(range.min);
  });

  it('includes an after-hours spike rather than clipping it', () => {
    // A ghost bar reaching far above the session is still in the range: the
    // scale re-fitting when it is cleared at the open is the agreed behaviour.
    const range = priceRange([bar(0, 100, 110), bar(1, 100, 400)]);
    expect(range.max).toBeGreaterThan(400);
  });
});

describe('priceScale', () => {
  it('puts the highest price at the top, because pixels grow downwards', () => {
    const scale = priceScale({ min: 0, max: 100 }, PLOT);
    expect(scale(100)).toBeCloseTo(0);
    expect(scale(0)).toBeCloseTo(PLOT.height);
  });
});

describe('priceTicks', () => {
  it('produces round numbers rather than the raw bounds', () => {
    const ticks = priceTicks({ min: 117.34, max: 143.89 }, PLOT);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every((t) => Number.isFinite(t))).toBe(true);
    // Ticks land on tidy steps, which is the whole reason d3-scale is here.
    const step = ticks[1] - ticks[0];
    expect(ticks.every((t, i) => i === 0 || Math.abs(t - ticks[i - 1] - step) < 1e-9)).toBe(true);
  });

  it('asks for fewer on a short plot', () => {
    const tall = priceTicks({ min: 0, max: 100 }, { width: 800, height: 800 });
    const short = priceTicks({ min: 0, max: 100 }, { width: 800, height: 100 });
    expect(short.length).toBeLessThan(tall.length);
  });
});

describe('timeTicks', () => {
  it('returns indices inside the window', () => {
    const ticks = timeTicks({ first: 0, last: 100 }, PLOT);
    expect(ticks.length).toBeGreaterThan(1);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ticks)).toBeLessThan(100);
  });

  it('keeps labels anchored so they do not slide while panning', () => {
    const a = timeTicks({ first: 0, last: 100 }, PLOT);
    const b = timeTicks({ first: 1, last: 101 }, PLOT);
    // The same multiples appear in both, one step having scrolled off.
    expect(b.every((tick) => tick % (a[1] - a[0]) === 0)).toBe(true);
  });

  it('is empty for an empty window', () => {
    expect(timeTicks({ first: 5, last: 5 }, PLOT)).toEqual([]);
  });
});

describe('zoomWindow', () => {
  it('keeps the bar under the pointer under the pointer', () => {
    const before = { first: 0, last: 100 };
    const pivot = 25;
    const after = zoomWindow(before, 0.5, pivot, 500);

    const wasAt = xAt(pivot, before, PLOT);
    const nowAt = xAt(pivot, after, PLOT);
    expect(nowAt).toBeCloseTo(wasAt, 6);
  });

  it('shows fewer bars zooming in and more zooming out', () => {
    const start = { first: 100, last: 200 };
    expect(zoomWindow(start, 0.5, 150, 500).last - zoomWindow(start, 0.5, 150, 500).first).toBe(50);
    expect(zoomWindow(start, 2, 150, 500).last - zoomWindow(start, 2, 150, 500).first).toBe(200);
  });

  it('stops at the readable minimum instead of one fat candle', () => {
    let window = { first: 0, last: 100 };
    for (let i = 0; i < 20; i += 1) window = zoomWindow(window, 0.5, 50, 500);
    expect(window.last - window.first).toBe(MIN_VISIBLE_BARS);
  });

  it('cannot zoom out past the series it has', () => {
    const window = zoomWindow({ first: 0, last: 100 }, 100, 50, 120);
    expect(window.first).toBe(0);
    expect(window.last).toBe(120);
  });
});

describe('panWindow', () => {
  it('moves without changing how much is on screen', () => {
    const window = panWindow({ first: 100, last: 200 }, -30, 500);
    expect(window).toEqual({ first: 70, last: 170 });
  });

  it('stops at the start of history', () => {
    expect(panWindow({ first: 10, last: 60 }, -999, 500).first).toBe(0);
  });

  it('stops at the latest bar', () => {
    expect(panWindow({ first: 400, last: 450 }, 999, 500).last).toBe(500);
  });
});

describe('visibleBars', () => {
  it('takes the slice the window covers', () => {
    expect(visibleBars(series(100), { first: 10.6, last: 20.2 })).toHaveLength(11);
  });

  it('does not run off either end', () => {
    expect(visibleBars(series(5), { first: -10, last: 99 })).toHaveLength(5);
  });
});

describe('zoom limits in pixels', () => {
  it('asks for more bars on a wider plot, so a candle never becomes a poster', () => {
    // The same bar count means different things on different screens; the limit
    // is a slot width, so it has to be derived from the plot.
    expect(minVisibleBars({ width: 1413, height: 400 })).toBe(45);
    expect(minVisibleBars({ width: 800, height: 400 })).toBe(25);
  });

  it('keeps a floor so a very narrow plot still asks for something sane', () => {
    expect(minVisibleBars({ width: 100, height: 400 })).toBe(MIN_VISIBLE_BARS);
  });

  it('never lets a slot exceed the maximum once the limit is applied', () => {
    const plot = { width: 1413, height: 400 };
    const min = minVisibleBars(plot);
    let window = { first: 0, last: 500 };
    for (let i = 0; i < 40; i += 1) window = zoomWindow(window, 0.5, 250, 1000, min);

    expect(slotWidth(window, plot)).toBeLessThanOrEqual(MAX_SLOT_PX + 0.001);
  });
});

describe('barWidth against its slot', () => {
  it('never paints over its neighbour, however far out you zoom', () => {
    const plot = { width: 1413, height: 400 };
    for (const bars of [100, 500, 1000, 1500, 5000]) {
      const window = { first: 0, last: bars };
      expect(barWidth(window, plot)).toBeLessThanOrEqual(slotWidth(window, plot));
    }
  });

  it('leaves a visible gap while the bars are wide enough to have one', () => {
    const plot = { width: 1413, height: 400 };
    const window = { first: 0, last: 120 };
    expect(slotWidth(window, plot) - barWidth(window, plot)).toBeGreaterThan(1);
  });
});

describe('wickWidth', () => {
  it('grows with the body instead of staying a thread', () => {
    expect(wickWidth(99)).toBeGreaterThan(wickWidth(8));
  });

  it('is never thinner than a pixel', () => {
    expect(wickWidth(0.5)).toBe(1);
  });

  it('stops growing before it becomes a second body', () => {
    expect(wickWidth(600)).toBeLessThanOrEqual(6);
  });
});
