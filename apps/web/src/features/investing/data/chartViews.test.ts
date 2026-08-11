import { describe, expect, it } from 'vitest';

import {
  NO_CHART_VIEWS,
  chartViewKey,
  normalizeChartViews,
  setChartWindow,
} from '@/features/investing/data/chartViews';

describe('normalizeChartViews', () => {
  it('starts empty when storage has no usable view document', () => {
    expect(normalizeChartViews(undefined)).toEqual(NO_CHART_VIEWS);
    expect(normalizeChartViews({ windows: [] })).toEqual(NO_CHART_VIEWS);
  });

  it('keeps only finite, forward index windows', () => {
    expect(
      normalizeChartViews({
        windows: {
          'AAPL:1d': { first: 63.5, last: 183.5 },
          backwards: { first: 20, last: 20 },
          negative: { first: -1, last: 30 },
          broken: { first: 'no', last: 10 },
        },
      }),
    ).toEqual({ version: 1, windows: { 'AAPL:1d': { first: 63.5, last: 183.5 } } });
  });
});

describe('chartViewKey', () => {
  it('makes an instrument and timeframe independent, in canonical symbol case', () => {
    expect(chartViewKey(' aapl ', '1d')).toBe('AAPL:1d');
    expect(chartViewKey('AAPL', '1h')).not.toBe(chartViewKey('AAPL', '1d'));
  });
});

describe('setChartWindow', () => {
  it('sets a new view and preserves the others', () => {
    const first = setChartWindow(NO_CHART_VIEWS, 'AAPL:1d', { first: 20, last: 140 });
    const second = setChartWindow(first, 'MSFT:1d', { first: 10, last: 130 });

    expect(second.windows).toEqual({
      'AAPL:1d': { first: 20, last: 140 },
      'MSFT:1d': { first: 10, last: 130 },
    });
  });

  it('does not make a new document when the view has not moved', () => {
    const views = setChartWindow(NO_CHART_VIEWS, 'AAPL:1d', { first: 20, last: 140 });
    expect(setChartWindow(views, 'AAPL:1d', { first: 20, last: 140 })).toBe(views);
  });
});
