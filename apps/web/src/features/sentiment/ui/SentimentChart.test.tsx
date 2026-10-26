import { fireEvent, render, screen, within } from '@testing-library/react';
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
    const { container, svg } = chart();

    expect(screen.getByText('Date')).toBeInTheDocument();
    expect(screen.getByText('index points')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Market Momentum legend' })).toHaveTextContent(
      'S&P 500125-day average',
    );
    expect(container.querySelectorAll('[data-series]')).toHaveLength(2);
    expect(within(svg).getByText('01/01')).toBeInTheDocument();
  });

  it('moves one animated crosshair to a real pointer observation', () => {
    const { svg, container } = chart();

    fireEvent.pointerMove(svg, { clientX: 360, clientY: 100 });

    const crosshair = container.querySelector('[data-testid="sentiment-crosshair"]');
    expect(crosshair?.getAttribute('style')).toContain('translate');
    expect(within(container).getByTestId('sentiment-x-reading')).toHaveTextContent('02/01');
    expect(within(container).getByTestId('sentiment-y-reading')).toHaveTextContent('6,060.00');
    expect(within(container).getByTestId('sentiment-y-reading-average')).toHaveTextContent(
      '5,925.00',
    );
    expect(svg.contains(within(container).getByTestId('sentiment-x-reading'))).toBe(false);
    expect(svg.contains(within(container).getByTestId('sentiment-y-reading'))).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('02/01');
    expect(screen.getByRole('status')).toHaveTextContent('6,060.00 index points');
    expect(screen.getByRole('status').className).toContain('srOnly');
  });

  it('shows the pointer reading only while its own chart is active', () => {
    const { svg, container } = chart();

    expect(container.querySelector('[data-testid="sentiment-crosshair"]')).not.toBeInTheDocument();
    expect(within(container).queryByTestId('sentiment-x-reading')).not.toBeInTheDocument();
    expect(within(container).queryByTestId('sentiment-y-reading')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    fireEvent.pointerEnter(svg, { clientX: 360, clientY: 100 });
    expect(container.querySelector('[data-testid="sentiment-crosshair"]')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('02/01');

    fireEvent.pointerLeave(svg);
    expect(container.querySelector('[data-testid="sentiment-crosshair"]')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('does not activate another sentiment chart when one is hovered', () => {
    const { svg } = chart();
    const second = render(<SentimentChart metric={{ ...METRIC, label: 'Other Momentum' }} />);
    const otherSvg = screen.getByRole('img', { name: /Other Momentum history/i });
    Object.defineProperty(otherSvg, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 720, height: 280 }),
    });

    fireEvent.pointerMove(svg, { clientX: 360, clientY: 100 });

    expect(
      second.container.querySelector('[data-testid="sentiment-crosshair"]'),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('status')[1]).toBeEmptyDOMElement();

    fireEvent.pointerLeave(svg);
    fireEvent.pointerMove(otherSvg, { clientX: 360, clientY: 100 });

    expect(screen.getAllByRole('status')[0]).toBeEmptyDOMElement();
    expect(screen.getAllByRole('status')[1]).toHaveTextContent('02/01');
  });

  it('keeps keyboard readings accessible without showing pointer text or animation', () => {
    const { svg, container } = chart();

    fireEvent.keyDown(svg, { key: 'Home' });
    expect(screen.getByTestId('sentiment-keyboard-reading')).toHaveTextContent('01/01');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByTestId('sentiment-keyboard-reading')).toHaveTextContent('02/01');
    fireEvent.keyDown(svg, { key: 'End' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByTestId('sentiment-keyboard-reading')).toHaveTextContent('03/01');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(container.querySelector('[data-testid="sentiment-crosshair"]')).not.toBeInTheDocument();
  });

  it('does not add table disclosure controls below the plot', () => {
    chart();

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('includes the two-digit year on charts covering more than one year', () => {
    const dates = ['2025-01-01T00:00:00Z', '2025-07-01T00:00:00Z', '2026-01-02T00:00:00Z'];
    const longMetric = {
      ...METRIC,
      series: METRIC.series.map((series) => ({
        ...series,
        points: series.points.map((point, index) => ({ ...point, timestamp: dates[index] })),
      })),
    };
    render(<SentimentChart metric={longMetric} />);
    const svg = screen.getByRole('img', { name: /Market Momentum history/i });
    Object.defineProperty(svg, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 720, height: 280 }),
    });

    expect(within(svg).getByText('01/01/25')).toBeInTheDocument();
    expect(within(svg).getByText('02/01/26')).toBeInTheDocument();
    fireEvent.pointerMove(svg, { clientX: 360, clientY: 100 });
    expect(screen.getByTestId('sentiment-x-reading')).toHaveTextContent('01/07/25');
    expect(screen.getByRole('status')).toHaveTextContent('01/07/25');
  });
});
