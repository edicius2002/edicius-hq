import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PageSkeleton } from './PageSkeleton';
import { pageSkeletonForPath } from './pageSkeletonForPath';

describe('PageSkeleton', () => {
  it.each([
    'dashboard',
    'finance',
    'greenlight',
    'investing',
    'airfare',
    'seace',
    'sentiment',
    'login',
    'error',
  ] as const)('shows a shaped, accessible %s loading state', (page) => {
    const { container } = render(<PageSkeleton page={page} />);

    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(2);
    expect(container.querySelector('button, input, a')).toBeNull();
  });

  it.each([
    ['dashboard', ['calendar-heatmap', 'fx-line-chart', 'post-list']],
    ['finance', ['diagram-canvas', 'property-panel', 'balance-summary']],
    ['greenlight', ['weekly-line', 'monthly-bars', 'projection-curve', 'week-grid']],
    ['investing', ['candlestick-chart', 'watchlist', 'positions', 'price-alerts']],
    ['airfare', ['route-map', 'fare-history-chart', 'departure-bars', 'flight-table']],
    ['seace', ['procurement-table']],
    ['sentiment', ['featured-history-chart', 'indicator-history-chart']],
  ] as const)('matches the real content on %s', (page, shapes) => {
    const { container } = render(<PageSkeleton page={page} />);
    const rendered = [...container.querySelectorAll('[data-skeleton-shape]')].map((node) =>
      node.getAttribute('data-skeleton-shape'),
    );

    for (const shape of shapes) expect(rendered).toContain(shape);
    expect(new Set(rendered).size).toBeGreaterThan(1);
  });

  it('draws chart marks rather than text lines for the investing candles', () => {
    const { container } = render(<PageSkeleton page="investing" />);
    const chart = container.querySelector('[data-skeleton-shape="candlestick-chart"]');

    expect(chart?.querySelectorAll('[data-skeleton-candle]').length).toBeGreaterThan(8);
    expect(chart?.querySelector('[data-skeleton-axis]')).toBeInTheDocument();
  });

  it('uses a full year of day cells for the Dashboard calendar', () => {
    const { container } = render(<PageSkeleton page="dashboard" />);
    const calendar = container.querySelector('[data-skeleton-shape="calendar-heatmap"]');

    expect(calendar?.querySelectorAll('[data-skeleton-day]')).toHaveLength(52 * 7);
  });

  it('matches the Greenlight weekly line, monthly bars, and projection tables', () => {
    const { container } = render(<PageSkeleton page="greenlight" />);

    expect(container.querySelector('[data-skeleton-shape="weekly-line"]')).toHaveAttribute(
      'data-skeleton-kind',
      'line',
    );
    expect(container.querySelector('[data-skeleton-shape="monthly-bars"]')).toHaveAttribute(
      'data-skeleton-kind',
      'bars',
    );
    expect(container.querySelectorAll('[data-skeleton-shape="projection-table"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-skeleton-week-bar]')).toHaveLength(12);
  });
});

it.each([
  ['/dashboard', 'dashboard'],
  ['/finance', 'finance'],
  ['/greenlight', 'greenlight'],
  ['/investing', 'investing'],
  ['/airfare', 'airfare'],
  ['/seace/recent', 'seace'],
  ['/seace/closed', 'seace'],
  ['/sentiment', 'sentiment'],
  ['/missing', 'error'],
] as const)('chooses the %s route silhouette', (path, page) => {
  expect(pageSkeletonForPath(path)).toBe(page);
});
