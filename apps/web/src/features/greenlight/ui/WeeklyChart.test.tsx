import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { buildWeeklySeries, fillCalendarWeeks } from '@/features/greenlight/lib/aggregate';
import type { DayStats } from '@/features/greenlight/model/types';
import { WeeklyChart } from '@/features/greenlight/ui/WeeklyChart';

afterEach(cleanup);

function day(amount: number): DayStats {
  return { Deliverable: { amount, details: [] }, currency: 'USD' };
}

describe('WeeklyChart histogram', () => {
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

  it('uses touching weekly bins and prints every exact date range on a scrollable axis', () => {
    const points = fillCalendarWeeks(
      buildWeeklySeries({ '2026-06-09': day(100), '2026-08-11': day(200) }),
    );
    render(<WeeklyChart points={points} />);
    const chart = screen.getByRole('img', { name: 'Weekly deliverable value' });
    const bars = [...chart.querySelectorAll('rect')];
    const dateParts = [...chart.querySelectorAll('tspan')].map((part) => part.textContent);

    expect(bars).toHaveLength(10);
    expect(Number(bars[0]?.getAttribute('x')) + Number(bars[0]?.getAttribute('width'))).toBeCloseTo(
      Number(bars[1]?.getAttribute('x')),
    );
    expect(Number(chart.getAttribute('viewBox')?.split(' ')[2])).toBeGreaterThanOrEqual(746);
    expect(dateParts).toHaveLength(20);
    expect(dateParts.slice(0, 2)).toEqual(['08/06', '→ 14/06']);
    expect(dateParts.slice(-2)).toEqual(['10/08', '→ 16/08']);
  });
});
