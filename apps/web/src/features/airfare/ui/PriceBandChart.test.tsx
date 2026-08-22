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
  // coordinate into its own viewBox before it can read anything from it. Given
  // a box that shares the viewBox's aspect ratio — this one is the viewBox —
  // that conversion is the identity and a clientX is a view unit, which keeps
  // the arithmetic in these tests readable. That is a property of the two
  // shapes agreeing and not of the chart: `preserveAspectRatio` scales the
  // drawing to fit a box of any other shape and centres it, leaving bars the
  // conversion has to subtract. `crosshair.test.ts` pins that arithmetic, and
  // the panel this chart lives in currently hands it a box that letterboxes at
  // every width — measured 373 to 1638 px of chart — so only the vertical
  // bars are ever non-zero here and this chart reads no `y`. Left at zero the
  // component refuses to track — deliberately, because dividing by it would
  // place the crosshair at infinity.
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

/**
 * A box the drawing does not fill.
 *
 * **This chart's conversion was the same latent bug the departure chart was
 * shipping, and it is correct today only by the luck of the panel's height.**
 * `preserveAspectRatio="xMidYMid meet"` scales a drawing to fit a box of a
 * different shape and centres it, and the blank bars that leaves are not part
 * of the plot. Measured in Chrome on 2026-08-22 by driving the analysis panel's
 * own container query from 300 px of chart width to 1858: this drawing's
 * 760×284 letterboxes at every width from 373 to 1638, so the horizontal bars
 * are zero a side and the old formula and this one agree exactly. **They stop
 * agreeing at about 1658 px of chart** — a stage of roughly 1698 px, which is
 * an ultrawide or a 2560-px monitor at 100% — where the drawing starts to
 * pillarbox and the old formula starts reading a period the reader is not over.
 *
 * That boundary is a fact about `.body`'s `clamp()` and this chart's chrome and
 * not about the chart, so it is not something the chart should be relying on.
 * The pillarboxed case below is the one that is not reachable on the owner's
 * machine today; it is here because the next change to the panel's height
 * decides whether it is.
 */
describe('a box the drawing does not fill', () => {
  /** Re-mock the box, and hand back where `xMidYMid meet` puts the drawing. */
  function boxOf(width: number, height: number) {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    });
    const scale = Math.min(width / 760, height / 284);
    return { scale, padX: (width - 760 * scale) / 2, padY: (height - 284 * scale) / 2 };
  }

  it('reads the period the pointer is over in a box wider than the drawing', () => {
    // 320 px of pillarbox a side. The three periods are painted at 84, 414 and
    // 744 as ever, and 249 is the midpoint of the first two — so these two
    // presses are two view units apart across a boundary. Dividing by the box's
    // own width instead put both of them at about 309, which is period two:
    // the first press read the wrong day and the boundary was 76 units from
    // where it is drawn.
    const place = boxOf(1400, 284);
    expect(place.padX).toBe(320);
    expect(place.padY).toBe(0);

    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: place.padX + 248 * place.scale, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('08-17');

    fireEvent.pointerMove(svg, { clientX: place.padX + 250 * place.scale, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('08-18');
  });

  it('is unchanged in a box taller than the drawing, which is every box it gets today', () => {
    // The measured case, and the reason this change is observably nothing on
    // this chart: letterboxed, so there is no horizontal bar to subtract and
    // the two formulas are the same arithmetic. The vertical bar is 68 units
    // and this chart reads no height — 12.245 — so it costs nothing either.
    const place = boxOf(760, 420);
    expect(place.padX).toBe(0);
    expect(place.padY).toBe(68);

    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: 248, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('08-17');

    fireEvent.pointerMove(svg, { clientX: 250, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('08-18');
  });
});

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

  it('reads the price the series has on that date, not the height of the hand', () => {
    /*
     * The plate used to follow the pointer, so a reader sweeping across the
     * chart at a constant height read the same invented fare on every day of
     * the series — in the app's money format, on the one element that looks
     * like a quoted price. It is a readout of the data now: two very different
     * pointer heights over the same date print the same number, and it is the
     * number that date actually cost.
     */
    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: 410, clientY: 20 });
    const high = screen.getByTestId('price-tag-text').textContent;
    fireEvent.pointerMove(svg, { clientX: 410, clientY: 220 });
    const low = screen.getByTestId('price-tag-text').textContent;

    expect(high).toBe(low);
    expect(high).toBe('$139.00');
  });

  it('prints each date’s own price as the crosshair moves along the series', () => {
    // Which is the whole point of the change: walking the chart reads out what
    // the route cost on each day, rather than three readings of one ruler.
    const svg = chart();
    const read = (x: number) => {
      fireEvent.pointerMove(svg, { clientX: x, clientY: 140 });
      return screen.getByTestId('price-tag-text').textContent;
    };
    expect([read(90), read(410), read(730)]).toEqual(['$125.00', '$139.00', '$133.00']);
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

/**
 * What the price axis shows on a date we have no median for.
 *
 * The chart holds two series and the archive is young, so on most dates the
 * only figure that exists is the provider's. The plate used to read our median
 * alone and was therefore absent across nearly the whole chart, which is what
 * the owner was looking at when they asked for this. It falls back now — and
 * because the two series are not the same measurement, the fallback has to say
 * which one it is showing, in ink and in words both.
 */
describe('the crosshair over a period with no median of ours', () => {
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

  it('shows the provider’s baseline for a keyboard reader who lands on one', () => {
    // The keyboard is not a lesser path here: 12.245 put the hairline on the
    // series "for the pointer and the keyboard alike", and a fallback that only
    // a hand could reach would put this chart back where 12.234 found it.
    const svg = chartWithHole();
    svg.focus();
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });

    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('08-19');
    expect(screen.getByTestId('price-tag-text')).toHaveTextContent('$96.00');
  });

  it('shows it under a pointer too, on the same date', () => {
    const svg = chartWithHole();
    fireEvent.pointerMove(svg, { clientX: 744, clientY: 100 });
    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('08-19');
    expect(screen.getByTestId('price-tag-text')).toHaveTextContent('$96.00');
  });

  it('lets our own median win wherever we have one', () => {
    // Both the 17th and the 19th are on this axis; only the 17th is ours. The
    // fallback is a fallback, not a preference.
    const svg = chartWithHole();
    svg.focus();
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByTestId('price-tag-text')).toHaveTextContent('$125.00');
    expect(screen.getByTestId('price-tag-text')).toHaveAttribute('data-source', 'ours');
  });

  it('says which of the two series the plate is showing, in words', () => {
    /*
     * The plate has room for a figure and nothing else — the margin is 76 view
     * units and a long-haul fare in soles fills it — so the ink carries the
     * attribution and every reading that is not ink has to carry it too. A
     * screen reader hears the live region; a sighted reader who cannot tell a
     * dashed outline from a filled one reads the row under the plot.
     */
    const svg = chartWithHole();
    svg.focus();

    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Price axis shows the provider’s baseline, $96.00.',
    );
    expect(screen.getByTestId('axis-source')).toHaveTextContent(
      'on the price axis: the provider’s baseline',
    );

    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(screen.getByRole('status')).toHaveTextContent('Price axis shows our median, $125.00.');
    expect(screen.getByTestId('axis-source')).toHaveTextContent('on the price axis: our median');
  });

  it('draws the plate in the series it is reading, not one treatment for both', () => {
    // Ink, since the words cannot fit on a 52-unit plate: the solid line's
    // plate is the filled one it always was, and the dashed line's plate is an
    // outline echoing that dash — the grammar the chart already teaches with
    // `.middle` and `.baseline`.
    const svg = chartWithHole();
    svg.focus();

    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    const provider = screen.getByTestId('price-tag-plate').getAttribute('class');
    expect(screen.getByTestId('price-tag-plate')).toHaveAttribute('data-source', 'baseline');
    expect(provider).toMatch(/tagBaseline/);
    expect(screen.getByTestId('price-tag-text').getAttribute('class')).toMatch(/tagTextBaseline/);
    expect(screen.getByTestId('price-hair').getAttribute('class')).toMatch(/hairBaseline/);
    expect(screen.getByTestId('baseline-marker')).toBeInTheDocument();

    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    const mine = screen.getByTestId('price-tag-plate').getAttribute('class');
    expect(mine).not.toBe(provider);
    expect(mine).not.toMatch(/tagBaseline/);
    expect(screen.getByTestId('price-hair').getAttribute('class')).not.toMatch(/hairBaseline/);
    expect(screen.queryByTestId('baseline-marker')).not.toBeInTheDocument();
  });

  it('states the rule in the chart’s own accessible name', () => {
    // The plate reads one series on some dates and the other on the rest. A
    // reader who cannot see which treatment it is wearing needs that said once,
    // somewhere that does not move as the hairline does.
    chartWithHole();
    expect(screen.getByRole('img')).toHaveAccessibleName(
      /price axis shows our median where we have one for that day, and the provider’s baseline where we do not\.$/,
    );
  });

  it('still prints nothing where neither series reached the period', () => {
    /*
     * 12.234 in full, and the half of 12.245 that is not narrowed by any of
     * this. The old fallback here was the middle of the padded domain, drawn as
     * currency; the pointer's own height is no better a source, and neither is
     * anything else. A second real series is not a ruler.
     */
    render(
      <PriceBandChart
        ours={OURS_ONE}
        baseline={[]}
        unsold={[{ key: '2026-08-19', label: '08-19', count: 2 }]}
        currency="USD"
        axis={calendarAxis('day')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    const svg = screen.getByRole('img');
    svg.focus();
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });

    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('08-19');
    expect(screen.queryByTestId('price-tag-text')).not.toBeInTheDocument();
    expect(screen.queryByTestId('price-hair')).not.toBeInTheDocument();
    expect(screen.queryByTestId('axis-source')).not.toBeInTheDocument();
  });

  it('does not follow the hand up and down while it falls back', () => {
    /*
     * The objection 12.245 closed, checked against the new source: two very
     * different pointer heights over one date print the same number, and it is
     * the provider's figure for that date rather than anything the reader's arm
     * chose. A fallback that reintroduced the ruler would be the audited bug
     * back with a different justification.
     */
    const svg = chartWithHole();
    fireEvent.pointerMove(svg, { clientX: 744, clientY: 20 });
    const high = screen.getByTestId('price-tag-text').textContent;
    fireEvent.pointerMove(svg, { clientX: 744, clientY: 230 });
    const low = screen.getByTestId('price-tag-text').textContent;

    expect(high).toBe(low);
    expect(high).toBe('$96.00');
  });
});

/**
 * The legend, after the same cut the departure chart's took.
 *
 * The owner's rule for both charts: the line as it is drawn, its colour, and the
 * minimum meaning. Two charts sharing one box and reading as two different
 * products is worse than either of them reading badly, so what this pins is that
 * they now read the same way — and that shortening did not throw a meaning away.
 */
describe('the legend as marks rather than sentences', () => {
  const NONE_ON_THE_18TH = [{ key: '2026-08-18', label: '08-18', count: 2 }];

  function legend() {
    const { container } = render(
      <PriceBandChart
        ours={OURS}
        baseline={BASELINE}
        unsold={NONE_ON_THE_18TH}
        currency="USD"
        axis={calendarAxis('day')}
        label="Cheapest fare for LIM to CUZ"
      />,
    );
    return [...container.querySelectorAll('figcaption span')];
  }

  it('names every mark in three words or fewer and keeps its sentence', () => {
    const entries = legend();
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect((entry.textContent ?? '').trim().split(/\s+/).length).toBeLessThanOrEqual(3);
      // The clause it used to print is what pointing at it now gets.
      expect(entry.getAttribute('title')).toBeTruthy();
    }
  });

  it('keeps our own series distinguishable from the provider figure', () => {
    // The one distinction this chart is for: what we measured against what the
    // provider claims. Two labels sharing a word would undo it.
    legend();
    const ours = screen.getByTitle('Our observations — range and median per day');
    const theirs = screen.getByTitle(
      'What the provider says it usually costs — one rounded figure a day',
    );
    expect(ours).toHaveTextContent('Our observations');
    expect(theirs).toHaveTextContent('Usually costs');
    expect(ours.textContent).not.toBe(theirs.textContent);
  });

  it('still tells an empty board from a stretch nobody looked at', () => {
    // 12.231's distinction, carried through the cut: one is an absence we
    // measured and the other is an absence of measuring.
    legend();
    expect(
      screen.getByTitle('Nothing on sale — we asked and the board came back empty'),
    ).toHaveTextContent('None on sale');
    expect(
      screen.getByTitle('A blank stretch is time nobody looked at — the axis is spaced by date'),
    ).toHaveTextContent('Nobody looked');
  });
});
