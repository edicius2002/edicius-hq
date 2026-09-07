import { describe, expect, it } from 'vitest';

import { chartLayout, formatSeriesValue } from '@/features/sentiment/lib/chart';
import type { SentimentMetric } from '@/shared/api/sentiment';

const metric = (values: number[], reference: number[] = []): SentimentMetric => ({
  key: 'market_momentum',
  label: 'Market Momentum',
  score: 74,
  classification: 'greed',
  timestamp: '2026-01-03T00:00:00Z',
  series: [
    {
      key: 'sp500',
      label: 'S&P 500',
      unit: 'index points',
      points: values.map((value, index) => ({
        timestamp: `2026-01-0${index + 1}T00:00:00Z`,
        value,
        classification: 'greed',
      })),
    },
    ...(reference.length
      ? [
          {
            key: 'average',
            label: '125-day average',
            unit: 'index points',
            points: reference.map((value, index) => ({
              timestamp: `2026-01-0${index + 1}T00:00:00Z`,
              value,
              classification: 'neutral' as const,
            })),
          },
        ]
      : []),
  ],
});

describe('chartLayout', () => {
  it('places every line in one shared finite time and value domain', () => {
    const layout = chartLayout(metric([6000, 6060, 6030], [5900, 5925, 5950]));

    expect(layout.paths).toHaveLength(2);
    expect(layout.paths.every((path) => path.d.startsWith('M '))).toBe(true);
    expect(layout.domain).toEqual({ min: 5900, max: 6060 });
    expect(layout.xAt('2026-01-01T00:00:00Z')).toBe(layout.plot.left);
    expect(layout.xAt('2026-01-03T00:00:00Z')).toBe(layout.plot.right);
    expect(
      layout.paths.flatMap((path) => path.points).every((point) => Number.isFinite(point.y)),
    ).toBe(true);
  });

  it('expands a flat domain instead of dividing by zero', () => {
    const layout = chartLayout(metric([18, 18]));

    expect(layout.domain.min).toBeLessThan(18);
    expect(layout.domain.max).toBeGreaterThan(18);
    expect(Number.isFinite(layout.yAt(18))).toBe(true);
  });

  it('formats raw units without implying they are the current 0-100 score', () => {
    expect(formatSeriesValue(6060.25, 'index points')).toBe('6,060.25 index points');
    expect(formatSeriesValue(0.82, 'ratio')).toBe('0.82 ratio');
  });
});
