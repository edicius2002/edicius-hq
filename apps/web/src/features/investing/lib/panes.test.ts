import { describe, expect, it } from 'vitest';

import {
  MIN_PANE_HEIGHT,
  MIN_PRICE_HEIGHT,
  bandAt,
  layoutPanes,
  valueToY,
} from '@/features/investing/lib/panes';

describe('layoutPanes', () => {
  it('gives the price everything when no pane is on', () => {
    const layout = layoutPanes(500, []);

    expect(layout.price).toEqual({ top: 0, height: 500 });
    expect(layout.panes).toEqual([]);
  });

  it('stacks the panes under the price, in a fixed order', () => {
    // Order never depends on the order they were switched on: a chart that
    // rearranged itself as you toggled would be unreadable.
    const layout = layoutPanes(600, ['macd', 'rsi']);

    expect(layout.panes.map((p) => p.id)).toEqual(['rsi', 'macd']);
    expect(layout.panes[0].band.top).toBeLessThan(layout.panes[1].band.top);
    expect(layout.price.height).toBeLessThan(600);
  });

  it('leaves no overlap and no gap beyond the hairline', () => {
    const layout = layoutPanes(600, ['rsi', 'macd']);
    const [rsi, macd] = layout.panes;

    expect(rsi.band.top - (layout.price.top + layout.price.height)).toBe(1);
    expect(macd.band.top - (rsi.band.top + rsi.band.height)).toBe(1);
    expect(macd.band.top + macd.band.height).toBeCloseTo(600);
  });

  it('gives the price back its room as panes are turned off', () => {
    const both = layoutPanes(600, ['rsi', 'macd']);
    const one = layoutPanes(600, ['rsi']);
    const none = layoutPanes(600, []);

    expect(both.price.height).toBeLessThan(one.price.height);
    expect(one.price.height).toBeLessThan(none.price.height);
  });

  it('drops panes rather than squeezing them into a smear', () => {
    // Three unreadable bands are worse than one readable one, so a short chart
    // sheds panes from the end and the price keeps its floor.
    const layout = layoutPanes(200, ['rsi', 'macd']);

    expect(layout.panes.length).toBeLessThan(2);
    expect(layout.price.height).toBeGreaterThanOrEqual(MIN_PRICE_HEIGHT);
  });

  it('drops the last pane first, so the first one does not move', () => {
    const layout = layoutPanes(200, ['rsi', 'macd']);

    if (layout.panes.length === 1) expect(layout.panes[0].id).toBe('rsi');
  });

  it('shows nothing at all when even one pane will not fit', () => {
    const layout = layoutPanes(MIN_PRICE_HEIGHT + MIN_PANE_HEIGHT - 10, ['rsi']);

    expect(layout.panes).toEqual([]);
    expect(layout.price.height).toBeGreaterThan(0);
  });

  it('never gives a pane less than it needs to be read', () => {
    const layout = layoutPanes(400, ['rsi', 'macd']);

    for (const pane of layout.panes) {
      expect(pane.band.height).toBeGreaterThanOrEqual(MIN_PANE_HEIGHT);
    }
  });
});

describe('bandAt', () => {
  it('names the band a pointer is over', () => {
    const layout = layoutPanes(600, ['rsi', 'macd']);

    expect(bandAt(layout, 10)).toBe('price');
    expect(bandAt(layout, layout.panes[0].band.top + 5)).toBe('rsi');
    expect(bandAt(layout, layout.panes[1].band.top + 5)).toBe('macd');
  });

  it('answers nothing in the hairline between two bands', () => {
    const layout = layoutPanes(600, ['rsi']);

    expect(bandAt(layout, layout.price.height + 0.5)).toBeNull();
  });
});

describe('valueToY', () => {
  it('puts the low at the bottom of the band and the high at the top', () => {
    const band = { top: 100, height: 200 };

    expect(valueToY(0, band, 0, 100)).toBe(300);
    expect(valueToY(100, band, 0, 100)).toBe(100);
    expect(valueToY(50, band, 0, 100)).toBe(200);
  });

  it('does not divide by a band with nothing in it', () => {
    // A flat series has no span; it draws as a line rather than as NaN.
    expect(Number.isFinite(valueToY(5, { top: 0, height: 100 }, 5, 5))).toBe(true);
  });
});

describe('volume', () => {
  it('sits directly under the price, above the studies', () => {
    // Where every terminal puts it: it belongs to the bars above it rather
    // than being derived from them.
    const layout = layoutPanes(700, ['macd', 'volume', 'rsi']);

    expect(layout.panes.map((p) => p.id)).toEqual(['volume', 'rsi', 'macd']);
  });

  it('takes less room than a study', () => {
    const withVolume = layoutPanes(700, ['volume']);
    const withRsi = layoutPanes(700, ['rsi']);

    expect(withVolume.panes[0].band.height).toBeLessThan(withRsi.panes[0].band.height);
    expect(withVolume.price.height).toBeGreaterThan(withRsi.price.height);
  });

  it('measures the panes actually shown, not the first of the global order', () => {
    // They take different heights, so asking about the wrong ones would fit a
    // volume band where a MACD is going to be drawn.
    const studies = layoutPanes(420, ['rsi', 'macd']);

    for (const pane of studies.panes) {
      expect(pane.band.top + pane.band.height).toBeLessThanOrEqual(420 + 0.001);
    }
    expect(studies.price.height).toBeGreaterThanOrEqual(MIN_PRICE_HEIGHT);
  });
});
