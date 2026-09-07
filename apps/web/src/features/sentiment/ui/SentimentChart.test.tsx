import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { SentimentChart } from '@/features/sentiment/ui/SentimentChart';
import type { SentimentMetric } from '@/shared/api/sentiment';

const METRIC: SentimentMetric = {
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
      points: [
        { timestamp: '2026-01-01T00:00:00Z', value: 6000, classification: 'greed' },
        { timestamp: '2026-01-02T00:00:00Z', value: 6060, classification: 'greed' },
        { timestamp: '2026-01-03T00:00:00Z', value: 6030, classification: 'greed' },
      ],
    },
    {
      key: 'average',
      label: '125-day average',
      unit: 'index points',
      points: [
        { timestamp: '2026-01-01T00:00:00Z', value: 5900, classification: 'neutral' },
        { timestamp: '2026-01-02T00:00:00Z', value: 5925, classification: 'neutral' },
        { timestamp: '2026-01-03T00:00:00Z', value: 5950, classification: 'neutral' },
      ],
    },
  ],
};

function chart() {
  const view = render(<SentimentChart metric={METRIC} />);
  const svg = screen.getByRole('img', { name: /Market Momentum history/i });
  Object.defineProperty(svg, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 720, height: 280 }),
  });
  return { ...view, svg };
}

describe('SentimentChart', () => {
  it('draws labelled axes, two distinguishable lines and a text legend', () => {
    const { container } = chart();

    expect(screen.getByText('Date')).toBeInTheDocument();
    expect(screen.getByText('index points')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Market Momentum legend' })).toHaveTextContent(
      'S&P 500125-day average',
    );
    expect(container.querySelectorAll('[data-series]')).toHaveLength(2);
  });

  it('moves one animated crosshair to a real pointer observation', () => {
    const { svg, container } = chart();

    fireEvent.pointerMove(svg, { clientX: 360, clientY: 100 });

    const crosshair = container.querySelector('[data-testid="sentiment-crosshair"]');
    expect(crosshair?.getAttribute('style')).toContain('translate');
    expect(screen.getByRole('status')).toHaveTextContent('Jan 2, 2026');
    expect(screen.getByRole('status')).toHaveTextContent('6,060.00 index points');
  });

  it('walks observations with Arrow keys and clamps with Home and End', () => {
    const { svg } = chart();

    fireEvent.keyDown(svg, { key: 'Home' });
    expect(screen.getByRole('status')).toHaveTextContent('Jan 1, 2026');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('Jan 2, 2026');
    fireEvent.keyDown(svg, { key: 'End' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('Jan 3, 2026');
  });

  it('offers the plotted observations as a data table', async () => {
    const user = userEvent.setup();
    chart();

    await user.click(screen.getByRole('button', { name: 'Show Market Momentum data table' }));

    const table = screen.getByRole('table', { name: 'Market Momentum historical data' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(table).toHaveTextContent('6,060.00');
    expect(table).toHaveTextContent('5,925.00');
  });
});
