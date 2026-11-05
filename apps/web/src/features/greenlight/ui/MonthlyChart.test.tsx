import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MonthlyChart } from '@/features/greenlight/ui/MonthlyChart';

const POINTS = [
  { key: '2026-06', label: 'Jun 2026', amount: 100, currency: 'USD' },
  { key: '2026-07', label: 'Jul 2026', amount: 200, currency: 'USD' },
];

describe('MonthlyChart', () => {
  it('draws horizontal month bars against a money X axis on mobile', () => {
    render(<MonthlyChart points={POINTS} />);

    const chart = screen.getByRole('img', { name: 'Monthly deliverable value, horizontal bars' });
    const bars = [...chart.querySelectorAll('rect')];
    expect(bars).toHaveLength(2);
    expect(bars[0]?.getAttribute('x')).toBe(bars[1]?.getAttribute('x'));
    expect(Number(bars[1]?.getAttribute('y'))).toBeGreaterThan(Number(bars[0]?.getAttribute('y')));
    expect(Number(bars[1]?.getAttribute('width'))).toBeGreaterThan(
      Number(bars[0]?.getAttribute('width')),
    );
    expect(chart.textContent).toContain('Jun 2026');
    expect(chart.textContent).toContain('Jul 2026');
    expect(chart.textContent).toContain('$0');
    expect(chart.textContent).toContain('$200');
  });
});
