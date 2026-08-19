import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { calendarAxis, type Bucket } from '@/features/airfare/lib/buckets';
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
      axis={calendarAxis('day')}
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
    // Three periods across the 660-unit track sit at x = 84, 414 and 744.
    fireEvent.pointerMove(svg, { clientX: 410, clientY: 100 });

    expect(screen.getByRole('status')).toHaveTextContent(
      '08-18, on 18/08/2026, 00:00 to 23:59. $130.00 to $160.00, median $139.00, across 4 observations. provider baseline $96.00.',
    );
  });

  it('moves to the next period only once the pointer is nearer to it', () => {
    const svg = chart();
    // The midpoint of the first two periods is x = 249.
    fireEvent.pointerMove(svg, { clientX: 245, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('08-17');

    fireEvent.pointerMove(svg, { clientX: 255, clientY: 100 });
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
    fireEvent.pointerMove(svg, { clientX: 84, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('provider baseline —.');
  });

  it('draws the time label on its own plate, not beside it', () => {
    /*
     * The bug this exists for: the plate was positioned as if the label were
     * centred while the label was drawn end-anchored, because `.tagText` set
     * `text-anchor: end` in the stylesheet and a CSS declaration beats a
     * presentation attribute whatever its specificity. On screen `07-27` read
     * as `7-27` — the leading `0` painted outside the plate onto the dark plot.
     *
     * jsdom has no `getBBox`, so the glyphs cannot be measured here. What it
     * can pin is the relationship the placement rests on: the label anchored at
     * the centre of its own plate. Combined with the anchor travelling with the
     * plate out of `timeAxisTag`, that is the whole of the fix.
     */
    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: 410, clientY: 100 });

    const plate = screen.getByTestId('time-tag-plate');
    const text = screen.getByTestId('time-tag-text');
    const x = Number(plate.getAttribute('x'));
    const width = Number(plate.getAttribute('width'));

    expect(Number(text.getAttribute('x'))).toBeCloseTo(x + width / 2, 5);
  });

  it('gives the two tags the anchors their placements assume', () => {
    // The price tag is right-aligned in a fixed margin and the time tag is
    // centred on a hairline that moves. One shared anchor cannot serve both,
    // which is exactly how the two got out of step.
    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: 410, clientY: 100 });

    const price = screen.getByTestId('price-tag-text').getAttribute('class');
    const time = screen.getByTestId('time-tag-text').getAttribute('class');
    expect(price).not.toBe(time);
    expect(price).toMatch(/tagEnd/);
    expect(time).toMatch(/tagMiddle/);
  });

  it('keeps the time tag on the plot at the ends of the series', () => {
    const svg = chart();
    // Hard against the right-hand end, where a plate hung from the hairline
    // rather than centred on it would hang off the plot.
    fireEvent.pointerMove(svg, { clientX: 758, clientY: 100 });

    const plate = screen.getByTestId('time-tag-plate');
    const right = Number(plate.getAttribute('x')) + Number(plate.getAttribute('width'));
    expect(right).toBeLessThanOrEqual(744);
    expect(Number(plate.getAttribute('x'))).toBeGreaterThanOrEqual(84);
  });

  it('has no crosshair at all on a route nobody has observed', () => {
    render(
      <PriceBandChart
        ours={[]}
        baseline={[]}
        currency="USD"
        axis={calendarAxis('day')}
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
        axis={calendarAxis('day')}
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
        axis={calendarAxis('month')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    expect(screen.queryByTestId('crosshair')).not.toBeInTheDocument();
  });
});

describe('a period we never observed', () => {
  /** How many separate strokes a `d` is: one `M` starts each of them. */
  function strokes(d: string | null): number {
    return (d ?? '').split('M').length - 1;
  }

  it('is a break in our band and our line, not a straight run across it', () => {
    // A single path through a hole claims the fare moved evenly through a
    // period nobody looked at. On the lead-time axis this is the ordinary case
    // rather than the edge — our archive reaches a third of the lead days the
    // provider's does — but it is the same lie on either axis.
    render(
      <PriceBandChart
        ours={[
          bucket('2026-08-17', '08-17', 118, 142, 125),
          bucket('2026-08-18', '08-18', 130, 160, 139),
          bucket('2026-08-20', '08-20', 121, 150, 133),
          bucket('2026-08-21', '08-21', 124, 152, 136),
        ]}
        // The collector was down on the 19th; the provider was not, so the
        // period is on the axis and our two figures for it are simply absent.
        baseline={[bucket('2026-08-19', '08-19', 96, 96, 96)]}
        currency="USD"
        axis={calendarAxis('day')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );

    expect(strokes(screen.getByTestId('ours-line').getAttribute('d'))).toBe(2);
    expect(strokes(screen.getByTestId('ours-band').getAttribute('d'))).toBe(2);
  });

  it('is still one unbroken stroke while nothing is missing', () => {
    render(
      <PriceBandChart
        ours={OURS}
        baseline={BASELINE}
        currency="USD"
        axis={calendarAxis('day')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    expect(strokes(screen.getByTestId('ours-line').getAttribute('d'))).toBe(1);
    expect(strokes(screen.getByTestId('ours-band').getAttribute('d'))).toBe(1);
  });

  it('says so in words rather than borrowing the figure beside it', () => {
    render(
      <PriceBandChart
        ours={[bucket('2026-08-17', '08-17', 118, 142, 125)]}
        baseline={[bucket('2026-08-19', '08-19', 96, 96, 96)]}
        currency="USD"
        axis={calendarAxis('day')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    fireEvent.pointerMove(screen.getByRole('img'), { clientX: 744, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('nothing of our own observed');
  });
});
