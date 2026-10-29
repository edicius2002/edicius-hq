import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FxChart } from './FxChart';
import type { History } from './types';

afterEach(() => vi.unstubAllGlobals());

it('shows six labelled Y-axis marks and five visible divisions', () => {
  const history: History = {
    aggregation: 'observations',
    points: [
      {
        owner_id: 'owner',
        source: 'kambista',
        effective_at: '2026-09-29T15:00:00Z',
        observed_at: '2026-09-29T15:00:00Z',
        buy: 3.71,
        sell: 3.73,
        context: {},
      },
    ],
  };

  render(<FxChart history={history} sourceName="Kambista" />);
  const chart = screen.getByRole('slider', { name: 'History point' });
  const marks = [...chart.querySelectorAll('line[class*="grid"]')];
  expect(marks).toHaveLength(6);
  expect(new Set(marks.map((mark) => mark.getAttribute('y1'))).size).toBe(6);
  expect(chart).toHaveTextContent('3.708');
  expect(chart).toHaveTextContent('3.732');
});

it('labels both axes and distinguishes intraday times for the USD/PEN series', () => {
  const history: History = {
    aggregation: 'observations',
    points: ['2026-09-29T15:00:00Z', '2026-09-29T16:00:00Z', '2026-09-29T17:00:00Z'].map(
      (effective_at, index) => ({
        owner_id: 'owner',
        source: 'kambista',
        effective_at,
        observed_at: effective_at,
        buy: 3.71 + index * 0.01,
        sell: 3.73 + index * 0.01,
        context: {},
      }),
    ),
  };

  render(<FxChart history={history} sourceName="Kambista" />);
  const chart = screen.getByRole('slider', { name: 'History point' });
  expect(chart).toHaveTextContent('PEN per USD');
  expect(chart).toHaveTextContent('Time (Lima)');
  expect(chart).toHaveTextContent('10:00');
  expect(chart).toHaveTextContent('11:00');
  expect(chart).toHaveTextContent('12:00');
  expect(screen.getByText('Buy')).toBeInTheDocument();
  expect(screen.getByText('Sell')).toBeInTheDocument();
});

it('includes dates on an intraday axis that crosses midnight in Lima', () => {
  const history: History = {
    aggregation: 'observations',
    points: ['2026-09-29T02:00:00Z', '2026-09-29T15:00:00Z'].map((effective_at) => ({
      owner_id: 'owner',
      source: 'kambista',
      effective_at,
      observed_at: effective_at,
      buy: 3.71,
      sell: 3.73,
      context: {},
    })),
  };

  render(<FxChart history={history} sourceName="Kambista" />);
  const chart = screen.getByRole('slider', { name: 'History point' });
  expect(chart).toHaveTextContent('Sep 28');
  expect(chart).toHaveTextContent('Sep 29');
});

it('uses the measured plot size for SVG coordinates as the card grows', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(element: HTMLElement) {
        Object.defineProperties(element, {
          clientWidth: { value: 420, configurable: true },
          clientHeight: { value: 180, configurable: true },
        });
        this.callback([], this as unknown as ResizeObserver);
      }
      disconnect() {}
    },
  );
  const history: History = {
    aggregation: 'observations',
    points: [
      {
        owner_id: 'owner',
        source: 'kambista',
        effective_at: '2026-09-29T10:00:00Z',
        observed_at: '2026-09-29T10:00:00Z',
        buy: 3.71,
        sell: 3.73,
        context: {},
      },
    ],
  };
  render(<FxChart history={history} sourceName="Kambista" />);
  expect(screen.getByRole('region', { name: 'Kambista USD/PEN history' })).toBeInTheDocument();
  expect(screen.getByRole('slider', { name: 'History point' })).toHaveAttribute(
    'viewBox',
    '0 0 420 180',
  );
});

it('shows the chart cursor only while the pointer is over the plot', () => {
  const history: History = {
    aggregation: 'observations',
    points: [
      {
        owner_id: 'owner',
        source: 'kambista',
        effective_at: '2026-09-29T10:00:00Z',
        observed_at: '2026-09-29T10:00:00Z',
        buy: 3.71,
        sell: 3.73,
        context: {},
      },
    ],
  };
  render(<FxChart history={history} sourceName="Kambista" />);
  const chart = screen.getByRole('slider', { name: 'History point' });
  const detail = screen.getByTestId('point-detail');

  expect(chart.querySelector('line[class*="cursor"]')).toBeNull();
  expect(detail).toBeEmptyDOMElement();
  fireEvent.pointerMove(chart, { clientX: 50 });
  expect(chart.querySelector('line[class*="cursor"]')).toBeInTheDocument();
  expect(detail).toHaveTextContent('Buy 3.710');
  fireEvent.pointerLeave(chart);
  expect(chart.querySelector('line[class*="cursor"]')).toBeNull();
  expect(detail).toBeEmptyDOMElement();

  fireEvent.focus(chart);
  fireEvent.keyDown(chart, { key: 'Home' });
  expect(chart.querySelector('line[class*="cursor"]')).toBeInTheDocument();
  expect(detail).toHaveTextContent('Buy 3.710');
  fireEvent.blur(chart);
  expect(chart.querySelector('line[class*="cursor"]')).toBeNull();
  expect(detail).toBeEmptyDOMElement();

  fireEvent.pointerDown(chart, { clientX: 50, pointerType: 'mouse' });
  fireEvent.focus(chart);
  fireEvent.pointerLeave(chart);
  expect(detail).toBeEmptyDOMElement();
});

it('keeps keyboard details when the pointer leaves and hover details when focus blurs', () => {
  const history: History = {
    aggregation: 'observations',
    points: [
      {
        owner_id: 'owner',
        source: 'kambista',
        effective_at: '2026-09-29T10:00:00Z',
        observed_at: '2026-09-29T10:00:00Z',
        buy: 3.71,
        sell: 3.73,
        context: {},
      },
      {
        owner_id: 'owner',
        source: 'kambista',
        effective_at: '2026-09-29T11:00:00Z',
        observed_at: '2026-09-29T11:00:00Z',
        buy: 3.72,
        sell: 3.74,
        context: {},
      },
    ],
  };
  render(<FxChart history={history} sourceName="Kambista" />);
  const chart = screen.getByRole('slider', { name: 'History point' });
  const detail = screen.getByTestId('point-detail');

  fireEvent.focus(chart);
  fireEvent.keyDown(chart, { key: 'Home' });
  fireEvent.pointerMove(chart, { clientX: 50 });
  fireEvent.pointerLeave(chart);
  fireEvent.keyDown(chart, { key: 'End' });
  expect(detail).toHaveTextContent('Buy 3.720');

  fireEvent.pointerMove(chart, { clientX: 50 });
  fireEvent.blur(chart);
  expect(detail).not.toBeEmptyDOMElement();
  fireEvent.pointerLeave(chart);
  expect(detail).toBeEmptyDOMElement();
});

it.each([
  {
    aggregation: 'daily' as const,
    source: 'bcrp' as const,
    dates: [
      '2026-09-21T05:00:00Z',
      '2026-09-24T05:00:00Z',
      '2026-09-25T05:00:00Z',
      '2026-09-29T05:00:00Z',
    ],
  },
  {
    aggregation: 'observations' as const,
    source: 'kambista' as const,
    dates: [
      '2026-09-29T10:00:00Z',
      '2026-09-29T12:00:00Z',
      '2026-09-29T12:15:00Z',
      '2026-09-29T15:00:00Z',
    ],
  },
])(
  'plots unselected isolated $aggregation captures without bridging gaps',
  ({ aggregation, source, dates }) => {
    const history: History = {
      aggregation,
      points: dates.map((effective_at) => ({
        owner_id: 'owner',
        source,
        effective_at,
        observed_at: effective_at,
        buy: 3.71,
        sell: 3.73,
        context: {},
      })),
    };
    render(
      <FxChart history={history} sourceName={source === 'bcrp' ? 'BCRP interbank' : 'Kambista'} />,
    );
    const chart = screen.getByRole('slider', { name: 'History point' });
    // Last point is selected by default. The first isolated capture must still
    // have both real SVG circles, while the middle pair is connected by a line.
    expect(chart).toHaveAttribute('aria-valuenow', '4');
    expect(chart.querySelectorAll('circle[cx="64"]')).toHaveLength(2);
    for (const path of chart.querySelectorAll('path')) {
      const commands = path.getAttribute('d')!.match(/[ML]/g);
      expect(commands).toEqual(['M', 'M', 'L', 'M']);
    }
    // Selecting another point must not make either isolated capture disappear.
    fireEvent.keyDown(chart, { key: 'Home' });
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(chart.querySelectorAll('circle[cx="64"]')).toHaveLength(2);
    expect(chart.querySelectorAll('circle[cx="308"]')).toHaveLength(2);
  },
);
