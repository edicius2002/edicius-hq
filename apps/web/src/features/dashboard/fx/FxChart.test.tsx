import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { FxChart } from './FxChart';
import type { History } from './types';

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
    render(<FxChart history={history} />);
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
