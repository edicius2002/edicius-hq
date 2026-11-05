import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildWeeklySeries, fillCalendarWeeks } from '@/features/greenlight/lib/aggregate';
import type { DayStats } from '@/features/greenlight/model/types';
import { WeeklyChart } from '@/features/greenlight/ui/WeeklyChart';

afterEach(cleanup);

function day(amount: number): DayStats {
  return { Deliverable: { amount, details: [] }, currency: 'USD' };
}

describe('WeeklyChart histogram', () => {
  it('shows each calendar week as a proportional horizontal bar for mobile', () => {
    const points = fillCalendarWeeks(
      buildWeeklySeries({ '2026-06-09': day(100), '2026-06-23': day(200) }),
    );
    render(<WeeklyChart points={points} />);

    const rows = within(
      screen.getByRole('list', { name: 'Weekly deliverable values' }),
    ).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      '08/06–14/06$100',
      '15/06–21/06$0',
      '22/06–28/06$200',
    ]);
    const bars = rows.map((row) => within(row).getByRole('meter'));
    expect(bars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['100', '0', '200']);
    expect(bars.map((bar) => (bar.firstElementChild as HTMLElement).style.width)).toEqual([
      '50%',
      '0%',
      '100%',
    ]);
  });

  it('draws a bar for every calendar week, including an empty one', () => {
    const points = fillCalendarWeeks(
      buildWeeklySeries({ '2026-06-09': day(100), '2026-06-23': day(200) }),
    );
    const { container } = render(<WeeklyChart points={points} />);
    const chart = screen.getByRole('img', { name: 'Weekly deliverable value' });
    const bars = chart.querySelectorAll('rect');

    expect(bars).toHaveLength(3);
    expect(bars[1]?.getAttribute('height')).toBe('2');
    expect(container.querySelectorAll('svg path, svg polygon')).toHaveLength(0);
    expect(
      [...chart.querySelectorAll('title')].map((title) =>
        title.textContent?.trim().replace(/\s+/g, ' '),
      ),
    ).toEqual(['08/06–14/06: $100', '15/06–21/06: $0', '22/06–28/06: $200']);
  });

  it('keeps a tapped week value visible after touch release', () => {
    const points = buildWeeklySeries({ '2026-06-09': day(100) });
    render(<WeeklyChart points={points} />);
    const chart = screen.getByRole('img', { name: 'Weekly deliverable value' });
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 560 } as DOMRect);

    fireEvent.pointerDown(chart, { pointerType: 'touch', clientX: 100 });
    fireEvent.pointerLeave(chart, { pointerType: 'touch' });

    expect(screen.getByText('$100', { selector: 'span' })).toBeInTheDocument();
  });
});
