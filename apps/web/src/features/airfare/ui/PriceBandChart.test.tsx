import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bucket } from '@/features/airfare/lib/buckets';
import { PriceBandChart } from '@/features/airfare/ui/PriceBandChart';

/**
 * The crosshair, in the DOM.
 *
 * The arithmetic behind it is `lib/crosshair.ts`'s and is tested there; what is
 * left for a rendered chart is the part a pure function cannot answer — that a
 * pointer at a position picks the period under it, that the readout goes away
 * when the pointer does, and that a reader with no pointer at all can still
 * walk the series. The last one is the reason this file exists: a crosshair
 * reachable only by hovering would leave this panel the one part of the page a
 * keyboard cannot read.
 */

beforeEach(() => {
  // jsdom measures every element as 0x0, and the chart converts a client
  // coordinate into its own viewBox by dividing by the measured width. Given a
  // box the same size as the viewBox, a clientX is a view unit, which keeps the
  // arithmetic in these tests readable. Left at zero the component refuses to
  // track — deliberately, because dividing by it would place the crosshair at
  // infinity.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 760,
    bottom: 260,
    width: 760,
    height: 260,
    toJSON: () => ({}),
  });
});

function bucket(key: string, label: string, low: number, high: number, middle: number): Bucket {
  return { key, label, low, high, middle, count: 4 };
}

const OURS = [
  bucket('2026-08-17', '08-17', 118, 142, 125),
  bucket('2026-08-18', '08-18', 130, 160, 139),
  bucket('2026-08-19', '08-19', 121, 150, 133),
];

const BASELINE = [bucket('2026-08-18', '08-18', 96, 96, 96)];

function chart(props: Partial<Parameters<typeof PriceBandChart>[0]> = {}) {
  render(
    <PriceBandChart
      ours={OURS}
      baseline={BASELINE}
      currency="USD"
      granularity="day"
      label="Cheapest fare for LIM to CUZ"
      {...props}
    />,
  );
  return screen.getByRole('img');
}

describe('PriceBandChart crosshair', () => {
  it('says nothing until the reader points at it', () => {
    chart();
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.getByText(/Point at the chart/)).toBeInTheDocument();
  });

  it('snaps to the period nearest the pointer rather than reading between two', () => {
    const svg = chart();
    // Three periods across the 682-unit track sit at x = 62, 403 and 744.
    fireEvent.pointerMove(svg, { clientX: 410, clientY: 100 });

    expect(screen.getByRole('status')).toHaveTextContent(
      '08-18, on 18/08/2026, 00:00 to 23:59. $130.00 to $160.00, median $139.00, across 4 observations. provider baseline $96.00.',
    );
  });

  it('moves to the next period only once the pointer is nearer to it', () => {
    const svg = chart();
    // The midpoint of the first two periods is x = 232.5.
    fireEvent.pointerMove(svg, { clientX: 230, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('08-17');

    fireEvent.pointerMove(svg, { clientX: 235, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('08-18');
  });

  it('reads the price the pointer is at, not the price of the line', () => {
    // The horizontal hairline is the reader's own height on the axis — that is
    // what makes it usable for "is this above or below what I paid". The period
    // under it is the same either way.
    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: 410, clientY: 20 });
    const high = screen.getByTestId('crosshair').textContent;
    fireEvent.pointerMove(svg, { clientX: 410, clientY: 220 });
    const low = screen.getByTestId('crosshair').textContent;

    expect(high).not.toBe(low);
  });

  it('goes away when the pointer leaves, rather than pinning to where it left', () => {
    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: 410, clientY: 100 });
    expect(screen.queryByTestId('crosshair')).toBeInTheDocument();

    fireEvent.pointerLeave(svg);
    expect(screen.queryByTestId('crosshair')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('walks the series with the arrow keys, and announces each period', () => {
    const svg = chart();
    svg.focus();

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('08-17');

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('08-18');

    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(screen.getByRole('status')).toHaveTextContent('08-17');
  });

  it('stops at the ends instead of wrapping round to the other one', () => {
    const svg = chart();
    svg.focus();

    // Arriving from nothing, the first left press lands on the newest period,
    // which is the end a reader moving leftwards is coming from.
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(screen.getByRole('status')).toHaveTextContent('08-19');

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('08-19');
  });

  it('names a period the provider never reached instead of borrowing a figure', () => {
    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: 62, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('provider baseline —.');
  });

  it('has no crosshair at all on a route nobody has observed', () => {
    render(
      <PriceBandChart
        ours={[]}
        baseline={[]}
        currency="USD"
        granularity="day"
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByTestId('crosshair')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing observed yet/)).toBeInTheDocument();
  });

  it('drops the crosshair when the switch above rebuilds the periods under it', () => {
    // Day to month is not the same axis renumbered, it is a different set of
    // periods; an index kept across the change would point at whichever month
    // happened to sit where the reader's day used to be.
    const { rerender } = render(
      <PriceBandChart
        ours={OURS}
        baseline={BASELINE}
        currency="USD"
        granularity="day"
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    const svg = screen.getByRole('img');
    fireEvent.pointerMove(svg, { clientX: 740, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('08-19');

    rerender(
      <PriceBandChart
        ours={[bucket('2026-08', '2026-08', 118, 160, 131)]}
        baseline={[]}
        currency="USD"
        granularity="month"
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    expect(screen.queryByTestId('crosshair')).not.toBeInTheDocument();
  });
});
