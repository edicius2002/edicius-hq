import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { calendarAxis, type Bucket } from '@/features/airfare/lib/buckets';
import { leadAxis } from '@/features/airfare/lib/leadTime';
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
    // 284 rather than 260 since 12.232: the plot floor and every point on it
    // are where they were, but there are twenty-four units of chrome below —
    // the rail the empty boards are marked on, and a row of its own for the
    // axis labels.
    bottom: 284,
    width: 760,
    height: 284,
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

describe('the axis is a measure, not a list', () => {
  /** Where a period's own dot was drawn, by the label under it. */
  function dotAt(container: HTMLElement, label: string): number {
    const title = [...container.querySelectorAll('title')].find((node) =>
      node.textContent?.startsWith(`${label}:`),
    )!;
    return Number(title.parentElement!.querySelector('circle')!.getAttribute('cx'));
  }

  it('leaves a fortnight the collector was down as wide as a fortnight', () => {
    /*
     * The fault this replaces: buckets were spaced by their index in the sorted
     * key list, so a one-day step and a two-week outage were drawn the same
     * width and a period neither series reached had no width at all. Three
     * observations — the 17th, the 18th and the 1st of September — are one day
     * and a fortnight apart, and the drawing has to say so.
     */
    const { container } = render(
      <PriceBandChart
        ours={[
          bucket('2026-08-17', '08-17', 118, 142, 125),
          bucket('2026-08-18', '08-18', 130, 160, 139),
          bucket('2026-09-01', '09-01', 121, 150, 133),
        ]}
        baseline={[]}
        currency="USD"
        axis={calendarAxis('day')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );

    const step = dotAt(container, '08-18') - dotAt(container, '08-17');
    const outage = dotAt(container, '09-01') - dotAt(container, '08-18');
    // Fourteen days against one, to the unit rather than merely "wider".
    expect(outage / step).toBeCloseTo(14, 5);
  });

  it('draws the run-up to a flight on the same ruler, counting down', () => {
    const { container } = render(
      <PriceBandChart
        ours={[
          bucket('lead-0203', '203d ahead', 118, 142, 125),
          bucket('lead-0202', '202d ahead', 130, 160, 139),
          bucket('lead-0189', '189d ahead', 121, 150, 133),
        ]}
        baseline={[]}
        currency="USD"
        axis={leadAxis('day')}
        label="Cheapest fare by days before departure"
      />,
    );

    // Furthest ahead on the left, and the thirteen lead days nobody observed
    // between 202 and 189 are thirteen steps of track.
    expect(dotAt(container, '203d ahead')).toBeLessThan(dotAt(container, '202d ahead'));
    const step = dotAt(container, '202d ahead') - dotAt(container, '203d ahead');
    const outage = dotAt(container, '189d ahead') - dotAt(container, '202d ahead');
    expect(outage / step).toBeCloseTo(13, 5);
  });

  it('labels more than its two ends, so a distance can be read off it', () => {
    const { container } = render(
      <PriceBandChart
        ours={Array.from({ length: 9 }, (_, index) =>
          bucket(`2026-08-${11 + index}`, `08-${11 + index}`, 118, 142, 125 + index),
        )}
        baseline={[]}
        currency="USD"
        axis={calendarAxis('day')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    const labels = [...container.querySelectorAll('text')]
      .map((node) => node.textContent ?? '')
      .filter((text) => /^08-\d\d$/.test(text));
    expect(labels.length).toBeGreaterThan(2);
    expect(labels[0]).toBe('08-11');
    expect(labels.at(-1)).toBe('08-19');
  });
});

describe('a board that came back with nothing on it', () => {
  const OURS_ONE = [bucket('2026-08-17', '08-17', 118, 142, 125)];
  const EMPTY_ON_THE_18TH = [{ key: '2026-08-18', label: '08-18', count: 2 }];

  function withUnsold() {
    render(
      <PriceBandChart
        ours={OURS_ONE}
        baseline={[]}
        unsold={EMPTY_ON_THE_18TH}
        currency="USD"
        axis={calendarAxis('day')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    return screen.getByRole('img');
  }

  it('marks the period on a rail under the plot rather than dropping it', () => {
    // Dropped, a day the provider answered about and had nothing to sell was
    // indistinguishable from a day nobody asked about.
    withUnsold();
    expect(screen.getByTestId('unsold-mark')).toBeInTheDocument();
  });

  it('puts the mark below the plot floor, because a mark inside the plot is a price', () => {
    withUnsold();
    const mark = screen.getByTestId('unsold-mark').querySelector('rect')!;
    // The plot runs from y=14 to y=236; the rail is at 243.
    expect(Number(mark.getAttribute('y'))).toBeGreaterThan(236);
  });

  it('says which kind of nothing it was when the reader lands on it', () => {
    const svg = withUnsold();
    fireEvent.pointerMove(svg, { clientX: 744, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent(
      'nothing on sale — 2 boards came back empty',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('nothing of our own observed');
  });

  it('draws no marker on it, and no band or line reaching to it', () => {
    const svg = withUnsold();
    fireEvent.pointerMove(svg, { clientX: 744, clientY: 100 });
    expect(screen.getByTestId('crosshair').querySelector('circle')).toBeNull();
    expect(screen.queryByTestId('ours-band')).not.toBeInTheDocument();
  });
});

describe('the price axis says only what was quoted', () => {
  it('ticks at round numbers rather than at the padded ends of the domain', () => {
    const { container } = render(
      <PriceBandChart
        ours={[
          bucket('2026-08-17', '08-17', 41.24, 120, 80),
          bucket('2026-08-18', '08-18', 130, 196.33, 160),
        ]}
        baseline={[]}
        currency="USD"
        axis={calendarAxis('day')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    const ticks = [...container.querySelectorAll('text')]
      .map((node) => node.textContent ?? '')
      .filter((text) => text.startsWith('$'));
    expect(ticks).toEqual(['$50.00', '$100.00', '$150.00', '$200.00']);
  });

  it('names the range that was observed, not the range that was drawn', () => {
    // The padded domain runs about $22 to $215 on this data. A screen reader
    // hears the accessible name and nothing else, so it must carry the figures
    // the archive holds.
    render(
      <PriceBandChart
        ours={[
          bucket('2026-08-17', '08-17', 41.24, 120, 80),
          bucket('2026-08-18', '08-18', 130, 196.33, 160),
        ]}
        baseline={[]}
        currency="USD"
        axis={calendarAxis('day')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    expect(screen.getByRole('img')).toHaveAccessibleName(/from \$41\.24 to \$196\.33\.$/);
  });
});

describe('the crosshair over a period with no figure', () => {
  const OURS_ONE = [bucket('2026-08-17', '08-17', 118, 142, 125)];
  const BASELINE_ONLY = [bucket('2026-08-19', '08-19', 96, 96, 96)];

  function chartWithHole() {
    render(
      <PriceBandChart
        ours={OURS_ONE}
        baseline={BASELINE_ONLY}
        currency="USD"
        axis={calendarAxis('day')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    return screen.getByRole('img');
  }

  it('prints no price at all for a keyboard reader who lands on one', () => {
    // The fallback used to be the middle of the padded domain, drawn on a plate
    // as currency: a number invented twice over, beside a readout saying `—`.
    const svg = chartWithHole();
    svg.focus();
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });

    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('08-19');
    expect(screen.queryByTestId('price-tag-text')).not.toBeInTheDocument();
  });

  it('still prints one where the period has a median to sit on', () => {
    const svg = chartWithHole();
    svg.focus();
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByTestId('price-tag-text')).toHaveTextContent('$125.00');
  });

  it('keeps the plate under a pointer, where the height is the reader’s own', () => {
    // There the hairline is a ruler somebody is holding rather than a claim
    // about the period, so it reads what it is at.
    const svg = chartWithHole();
    fireEvent.pointerMove(svg, { clientX: 744, clientY: 100 });
    expect(screen.getByTestId('price-tag-text')).toBeInTheDocument();
  });
});
