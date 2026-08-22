import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildMonthGroupsFromWeeks, buildWeeklySeries } from '@/features/greenlight/lib/aggregate';
import type { DayStats } from '@/features/greenlight/model/types';
import { MoneyWeekChart } from '@/features/greenlight/ui/MoneyWeekChart';

import styles from './MoneyWeekChart.module.css';

afterEach(cleanup);

function day(amount: number): DayStats {
  return { Deliverable: { amount, details: [] }, currency: 'USD' };
}

/**
 * Two months, four weeks in the second — the shape that used to wrap 3 + 1 at
 * the owner's window and the reason this grid was changed.
 */
const STATS: Record<string, DayStats> = {
  '2026-06-09': day(2442.98),
  '2026-06-16': day(1960.84),
  '2026-06-23': day(1365),
  '2026-06-30': day(4272.5),
  '2026-07-07': day(1408.42),
  '2026-07-21': day(2275.14),
  '2026-07-28': day(1113.4),
};

function renderChart(markers: string[] = []) {
  const onToggleMarker = vi.fn();
  const onToggleWidget = vi.fn();
  const months = buildMonthGroupsFromWeeks(buildWeeklySeries(STATS));
  render(
    <MoneyWeekChart
      months={months}
      stats={STATS}
      markers={markers}
      widgets={{}}
      onToggleMarker={onToggleMarker}
      onToggleWidget={onToggleWidget}
    />,
  );
  return { months, onToggleMarker, onToggleWidget };
}

describe('the boxes the Weeks panel draws', () => {
  it('draws one box per month and one card per week inside it', () => {
    const { months } = renderChart();

    const sections = screen.getAllByRole('heading', { level: 3 });
    expect(sections).toHaveLength(months.length);
    // The week of 29/06–05/07 belongs to July: its Thursday falls in July.
    expect(months.map((month) => month.key)).toEqual(['2026-06', '2026-07']);
    expect(months.map((month) => month.weeks.length)).toEqual([3, 4]);

    // One `img` per week card: the bar carries the accessible name.
    expect(screen.getAllByRole('img')).toHaveLength(7);
  });

  it('names every week card with its own amount and its own dates', () => {
    renderChart();

    expect(screen.getByRole('img', { name: /29\/06.*05\/07/ })).toBeTruthy();
    // The figure the card has to print whole, and the widest one there is here.
    // Nine characters under this suite's `en-US`, eight under the owner's own
    // locale — `moneyWeekGrid` sizes the card for the longer of the two.
    expect(screen.getByText('$4,272.50')).toBeTruthy();
    expect('$4,272.50').toHaveLength(9);
  });

  it('prints the share of the month beside the figure, unrounded', () => {
    renderChart();

    // 4272.50 of July's 9069.46. One decimal, and the words that say what the
    // percentage is of — both of which the narrow card keeps, by wrapping the
    // pill onto a second line rather than shortening it.
    expect(screen.getByText('47.1% of month')).toBeTruthy();
    expect(screen.getByText('12.3% of month')).toBeTruthy();
  });
});

/**
 * The heading is placed on a two-line grid by `MoneyWeekChart.module.css`, and
 * grid placement reads the DOM: the month name is `span:first-child`, the total
 * is `strong`, and the chips span both columns on the second line. Reordering
 * these children moves the total or the name without any stylesheet changing,
 * and the boxes in a row then start their cards at different heights.
 */
describe('the order the month heading puts its parts in', () => {
  it('is the month name, then the chips, then the total', () => {
    renderChart();

    const heading = screen.getAllByRole('heading', { level: 3 })[0];
    const parts = [...heading.children];

    expect(parts[0]?.tagName).toBe('SPAN');
    expect(parts[0]?.textContent).toBe('June 2026');
    expect(parts[1]?.className).toContain(styles.toolChips);
    expect(parts.at(-1)?.tagName).toBe('STRONG');
    expect(parts.at(-1)?.textContent).toBe('$5,768.82');
  });

  it('keeps the subscription chips inside the heading, one per tool', () => {
    const { onToggleWidget } = renderChart();

    const heading = screen.getAllByRole('heading', { level: 3 })[0];
    const chips = within(heading).getAllByRole('button');

    expect(chips.map((chip) => chip.textContent)).toEqual(['+ VSCode', '+ Cursor']);
    expect(onToggleWidget).not.toHaveBeenCalled();
  });
});

describe('the marker slot between two week cards', () => {
  it('sits after every week but the last one in the archive', () => {
    renderChart();

    // Seven weeks, so six gutters carry a marker. The seventh card is the one
    // the stylesheet reserves a gutter for without drawing anything in it.
    expect(screen.getAllByRole('button', { name: 'Add marker' })).toHaveLength(6);
  });

  it('offers to remove the marker it already carries', () => {
    renderChart(['2026-07-06']);

    expect(screen.getAllByRole('button', { name: 'Remove marker' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Add marker' })).toHaveLength(5);
  });
});
