import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FxChart } from './FxChart';
import type { History } from './types';

afterEach(() => vi.unstubAllGlobals());

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
    expect(chart.querySelectorAll('circle[cx="50"]')).toHaveLength(2);
    for (const path of chart.querySelectorAll('path')) {
      const commands = path.getAttribute('d')!.match(/[ML]/g);
      expect(commands).toEqual(['M', 'M', 'L', 'M']);
    }
    // Selecting another point must not make either isolated capture disappear.
    fireEvent.keyDown(chart, { key: 'Home' });
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(chart.querySelectorAll('circle[cx="50"]')).toHaveLength(2);
    expect(chart.querySelectorAll('circle[cx="305"]')).toHaveLength(2);
  },
);
