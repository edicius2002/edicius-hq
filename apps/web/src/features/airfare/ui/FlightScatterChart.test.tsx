import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Granularity } from '@/features/airfare/lib/buckets';
import { FlightScatterChart } from '@/features/airfare/ui/FlightScatterChart';
import type { FareOffer, FareSnapshot } from '@/shared/api/fares';

/**
 * The scatter, in the DOM.
 *
 * The arithmetic is `lib/flightScatter.ts`'s and is tested there; what is left
 * for a rendered chart is the part a pure function cannot answer — that every
 * itinerary reaches the canvas as a node, that a pointer picks the flight
 * nearest it rather than the first in the array, that the arrows cross a month
 * without a mouse, and that stepping a period lands on one with flights in it.
 *
 * jsdom does no layout: nothing here can assert a measured pixel, only the
 * geometry the component computed from its own viewBox. So the dots are counted
 * and their coordinates compared, never their painted positions — whether two
 * overlapping dots are actually distinguishable on a screen is a question only
 * a browser can answer, and it is on the list of things to look at by hand.
 */

/**
 * The chart's own viewBox, mirrored so a client coordinate is a view unit.
 *
 * 324 rather than 300 since 12.232: the plot floor is where it always was and
 * every dot with it, but there are twenty-four units of chrome below it now —
 * the rail the absent departure days are marked on, and a row of its own for
 * the day labels.
 */
const VIEW = { width: 760, height: 324 };

beforeEach(() => {
  // jsdom measures every element as 0x0, and the chart divides a client
  // coordinate by the measured width to reach its own viewBox. Given a box the
  // size of the viewBox, a clientX is a view unit. Left at zero the component
  // refuses to track, deliberately — dividing by it would place the crosshair
  // at infinity.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: VIEW.width,
    bottom: VIEW.height,
    width: VIEW.width,
    height: VIEW.height,
    toJSON: () => ({}),
  });
});

function offer(overrides: Partial<FareOffer> = {}): FareOffer {
  return {
    airline: 'LA',
    airlineName: 'LATAM',
    flightNumber: '2075',
    departureAt: '2027-03-09T19:55',
    arrivalAt: '2027-03-09T21:15',
    transfers: 0,
    durationMinutes: 80,
    price: 210,
    currency: 'USD',
    ...overrides,
  };
}

function snapshot(
  flightDate: string,
  offers: FareOffer[],
  capturedAt = '2026-08-01T09:00',
): FareSnapshot {
  return {
    capturedAt,
    source: 'google-flights',
    origin: 'LIM',
    destination: 'SCL',
    flightDate,
    returnDate: null,
    currency: 'USD',
    insights: null,
    offers,
  };
}

/** Monday the 8th to Sunday the 14th of March 2027, three of them flown. */
const WEEK = [
  snapshot('2027-03-08', [
    offer({ flightNumber: '1', departureAt: '2027-03-08T07:00', price: 240 }),
    offer({ flightNumber: '2', departureAt: '2027-03-08T18:00', price: 310 }),
  ]),
  snapshot('2027-03-09', [
    offer({ flightNumber: '3', departureAt: '2027-03-09T06:30', price: 260 }),
    offer({ flightNumber: '4', departureAt: '2027-03-09T19:55', price: 195 }),
  ]),
  snapshot('2027-03-14', [
    offer({ flightNumber: '5', departureAt: '2027-03-14T23:59', price: 288 }),
  ]),
];

/**
 * The chart with an anchor of its own, which the panel above it now holds.
 *
 * Stepping a period is a message rather than a state change here — 12.170 — so
 * a chart rendered on its own would step once and come back to where it was.
 * This wrapper is the smallest thing that keeps the arrows working: it holds
 * the day the chart hands out and hands it straight back. That the *panel*
 * holds it across a change of view is `AnalysisPanel.test.tsx`'s business.
 */
function Harness({
  snapshots = WEEK,
  granularity = 'week',
  ...rest
}: Partial<Parameters<typeof FlightScatterChart>[0]>) {
  const [anchor, setAnchor] = useState<string | null>(null);
  return (
    <FlightScatterChart
      snapshots={snapshots}
      granularity={granularity}
      currency="USD"
      anchor={anchor}
      onAnchorChange={setAnchor}
      label="Every flight for LIM to SCL departing in March 2027"
      {...rest}
    />
  );
}

function chart(props: Partial<Parameters<typeof FlightScatterChart>[0]> = {}) {
  return render(<Harness {...props} />);
}

function dots(container: HTMLElement): SVGCircleElement[] {
  const group = container.querySelector('[data-testid="flight-dots"]');
  return [...(group?.querySelectorAll('circle') ?? [])] as SVGCircleElement[];
}

describe('one dot per itinerary', () => {
  it('puts every flight of the week on the canvas as its own node', () => {
    const { container } = chart();
    expect(dots(container)).toHaveLength(5);
  });

  it('rings the cheapest flight of each day and no other', () => {
    const { container } = chart();
    const rings = container.querySelectorAll('[data-testid="cheapest-rings"] circle');
    expect(rings).toHaveLength(3);
  });

  it('keeps the flight departing at 23:59 on the Sunday inside that week', () => {
    const { container } = chart();
    expect(container.textContent).toContain('5 flights');
    expect(dots(container)).toHaveLength(5);
  });

  it('leaves the flight departing at 00:00 on the Monday after to the next week', () => {
    const { container } = chart({
      snapshots: [
        ...WEEK,
        snapshot('2027-03-15', [
          offer({ flightNumber: '6', departureAt: '2027-03-15T00:00', price: 150 }),
        ]),
      ],
    });
    expect(dots(container)).toHaveLength(5);
    expect(container.textContent).toContain('5 flights');
  });

  it('says so rather than drawing an empty plane when nothing is collected', () => {
    chart({ snapshots: [] });
    expect(screen.getByText(/No flights collected for this month yet/)).toBeTruthy();
  });

  it('names the whole window it is drawing, both ends and both clocks', () => {
    const { container } = chart();
    expect(container.textContent).toContain('between 08/03/2027 00:00 and 14/03/2027 23:59');
  });
});

describe('the flight under the pointer', () => {
  it('reads out the flight nearest the pointer, not the first in the array', () => {
    const { container } = chart();
    const svg = container.querySelector('svg')!;
    const dearest = dots(container).reduce((highest, dot) =>
      Number(dot.getAttribute('cy')) < Number(highest.getAttribute('cy')) ? dot : highest,
    );
    fireEvent.pointerMove(svg, {
      clientX: Number(dearest.getAttribute('cx')),
      clientY: Number(dearest.getAttribute('cy')),
    });
    // $310 is the dearest flight of the week, so it is the highest dot.
    expect(container.textContent).toContain('$310.00');
    expect(container.textContent).toContain('LA 2');
  });

  it('tells the two flights of one day apart by how high the pointer is', () => {
    const { container } = chart({ granularity: 'day' });
    const svg = container.querySelector('svg')!;
    const [first, second] = dots(container);
    fireEvent.pointerMove(svg, {
      clientX: Number(first.getAttribute('cx')),
      clientY: Number(first.getAttribute('cy')),
    });
    const one = container.textContent;
    fireEvent.pointerMove(svg, {
      clientX: Number(second.getAttribute('cx')),
      clientY: Number(second.getAttribute('cy')),
    });
    expect(container.textContent).not.toBe(one);
  });

  it('takes the crosshair away with the pointer', () => {
    const { container } = chart();
    const svg = container.querySelector('svg')!;
    fireEvent.pointerMove(svg, { clientX: 300, clientY: 150 });
    expect(container.querySelector('[data-testid="scatter-crosshair"]')).toBeTruthy();
    fireEvent.pointerLeave(svg);
    expect(container.querySelector('[data-testid="scatter-crosshair"]')).toBeNull();
  });

  it('refuses to place a crosshair in a box it cannot measure', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    });
    const { container } = chart();
    fireEvent.pointerMove(container.querySelector('svg')!, { clientX: 300, clientY: 150 });
    expect(container.querySelector('[data-testid="scatter-crosshair"]')).toBeNull();
  });
});

describe('crossing the chart without a mouse', () => {
  it('walks the cheapest flight of each day with left and right', () => {
    const { container } = chart();
    const svg = container.querySelector('svg')!;
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    // The 8th's cheapest is the 07:00 at $240.
    expect(container.textContent).toContain('$240.00');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(container.textContent).toContain('$195.00');
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(container.textContent).toContain('$240.00');
  });

  it('starts at the last day when the reader arrives moving left', () => {
    const { container } = chart();
    fireEvent.keyDown(container.querySelector('svg')!, { key: 'ArrowLeft' });
    expect(container.textContent).toContain('$288.00');
  });

  it('stays on the last day rather than falling off the end', () => {
    const { container } = chart();
    const svg = container.querySelector('svg')!;
    for (let press = 0; press < 8; press += 1) fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(container.textContent).toContain('$288.00');
  });

  it('walks that day’s own board by price with up and down', () => {
    const { container } = chart();
    const svg = container.querySelector('svg')!;
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(container.textContent).toContain('$240.00');
    fireEvent.keyDown(svg, { key: 'ArrowUp' });
    expect(container.textContent).toContain('$310.00');
    fireEvent.keyDown(svg, { key: 'ArrowDown' });
    expect(container.textContent).toContain('$240.00');
  });

  it('reads the flight out as a sentence for a screen reader', () => {
    const { container } = chart();
    fireEvent.keyDown(container.querySelector('svg')!, { key: 'ArrowRight' });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'departs 08/03/2027 07:00',
    );
  });

  it('leaves the page where it was instead of scrolling under the arrow', () => {
    const { container } = chart();
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    container.querySelector('svg')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('moving between periods', () => {
  const TWO_WEEKS = [
    ...WEEK,
    snapshot('2027-03-24', [
      offer({ flightNumber: '9', departureAt: '2027-03-24T09:00', price: 402 }),
    ]),
  ];

  it('steps to the next period that has flights, skipping the empty week between', () => {
    const { container } = chart({ snapshots: TWO_WEEKS });
    expect(container.textContent).toContain('1 / 2');
    fireEvent.click(screen.getByLabelText('Next week with flights'));
    expect(container.textContent).toContain('between 22/03/2027 00:00 and 28/03/2027 23:59');
    expect(container.textContent).toContain('2 / 2');
  });

  it('has nowhere to step from either end', () => {
    chart({ snapshots: TWO_WEEKS });
    expect(screen.getByLabelText('Previous week with flights').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('Next week with flights'));
    expect(screen.getByLabelText('Next week with flights').hasAttribute('disabled')).toBe(true);
  });

  it('offers no arrows on a month, where a watched route has exactly one', () => {
    chart({ snapshots: TWO_WEEKS, granularity: 'month' });
    expect(screen.queryByLabelText('Next month with flights')).toBeNull();
  });

  it('draws each granularity over the period it names', () => {
    const cases: [Granularity, number, string][] = [
      ['day', 2, 'on 08/03/2027, 00:00 to 23:59'],
      ['week', 5, 'between 08/03/2027 00:00 and 14/03/2027 23:59'],
      ['month', 6, 'between 01/03/2027 00:00 and 31/03/2027 23:59'],
    ];
    for (const [granularity, count, caption] of cases) {
      const { container, unmount } = chart({ snapshots: TWO_WEEKS, granularity });
      expect(dots(container)).toHaveLength(count);
      expect(container.textContent).toContain(caption);
      unmount();
    }
  });
});

describe('a frame that only claims what the watch is on', () => {
  /**
   * March 2027's last ISO week runs Monday 29 March to Sunday 4 April, and the
   * 30th is flown. A March watch has never asked about April.
   */
  const LAST_WEEK = [
    snapshot('2027-03-30', [
      offer({ flightNumber: '7', departureAt: '2027-03-30T08:00', price: 330 }),
    ]),
  ];
  const MARCH = { from: '2027-03-01', to: '2027-03-31' };

  it('draws a week that overhangs the month only as far as the month goes', () => {
    // Unclipped, this chart captioned itself "between 29/03/2027 00:00 and
    // 04/04/2027 23:59" under a heading reading "departing in March 2027", and
    // drew ticks and day separators for four April dates nothing was ever
    // collected about.
    const { container } = chart({ snapshots: LAST_WEEK, watched: MARCH });
    expect(container.textContent).toContain('between 29/03/2027 00:00 and 31/03/2027 23:59');
    expect(container.textContent).not.toContain('04/04');
    expect(container.textContent).not.toContain('01/04');
  });

  it('separates the days it does draw and no others', () => {
    const { container } = chart({ snapshots: LAST_WEEK, watched: MARCH });
    // Three days, so two midnights between them.
    expect(container.querySelectorAll('[class*="separator"]')).toHaveLength(2);
  });

  it('leaves a week wholly inside the month exactly as it was', () => {
    const { container } = chart({ watched: MARCH });
    expect(container.textContent).toContain('between 08/03/2027 00:00 and 14/03/2027 23:59');
  });
});

describe('a departure date in the frame with no flight on it', () => {
  it('marks a day whose board came back empty apart from one nobody asked about', () => {
    // Without the marks the reader is left with a broken line and no reason
    // for it: the dashed line stops at both kinds of hole and neither is blank
    // canvas for the same reason.
    chart({
      snapshots: [
        ...WEEK,
        // Asked about on the 10th and there was nothing to sell.
        snapshot('2027-03-10', []),
      ],
    });
    expect(screen.getAllByTestId('day-unsold')).toHaveLength(1);
    // The 11th, 12th and 13th were never collected.
    expect(screen.getAllByTestId('day-unanswered')).toHaveLength(3);
  });

  it('hangs both marks under the plot floor, because a mark inside it is a fare', () => {
    chart({ snapshots: [...WEEK, snapshot('2027-03-10', [])] });
    const y = Number(
      screen.getAllByTestId('day-unsold')[0].querySelector('rect')!.getAttribute('y'),
    );
    // The plot runs from y=14 to y=266; the rail is at 273.
    expect(y).toBeGreaterThan(266);
  });

  it('says nothing at all about a week every day of which was flown', () => {
    const week = Array.from({ length: 7 }, (_, index) =>
      snapshot(`2027-03-${String(8 + index).padStart(2, '0')}`, [
        offer({
          flightNumber: `${index}`,
          departureAt: `2027-03-${String(8 + index).padStart(2, '0')}T09:00`,
          price: 200 + index,
        }),
      ]),
    );
    chart({ snapshots: week });
    expect(screen.queryByTestId('day-unsold')).toBeNull();
    expect(screen.queryByTestId('day-unanswered')).toBeNull();
  });
});

describe('the price axis says only what a flight costs', () => {
  it('ticks at round numbers rather than at four slices of the padded span', () => {
    // `priceSpan` pads the board's range by a twelfth so the extreme dots are
    // not clipped in half. The four labels used to be the padded ends and two
    // points between them — money-formatted figures no itinerary on the canvas
    // costs.
    const { container } = chart();
    const ticks = [...container.querySelectorAll('text')]
      .map((node) => node.textContent ?? '')
      .filter((text) => text.startsWith('$'));
    // The board runs $195 to $310 and the padded span $185.42 to $319.58 —
    // neither end of which is drawn, and none of these is a quote either, which
    // is the point: they read as a scale.
    expect(ticks).toEqual(['$200.00', '$250.00', '$300.00']);
  });

  it('names the range the board actually holds', () => {
    const { container } = chart();
    // $195 to $310 across the week, from the points rather than from the frame.
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toContain(
      'from $195.00 to $310.00',
    );
  });
});

/**
 * What a month actually costs to draw.
 *
 * The reader's estimate was 600–900 dots and the shape of a real collection
 * pass agrees: 31 departures × 20–30 itineraries. This builds the pessimistic
 * end of that and reports what it takes, because "SVG is fine at this size" is
 * a claim and not a measurement — 12.12 is only worth keeping if the number
 * behind it is known.
 *
 * jsdom is the slow end: no compositor, no layout, every attribute a real
 * property set. A browser will do better than this, never worse.
 */
describe('a whole month of departures', () => {
  const MONTH: FareSnapshot[] = [];
  for (let day = 1; day <= 31; day += 1) {
    const date = `2027-03-${String(day).padStart(2, '0')}`;
    const offers: FareOffer[] = [];
    for (let flight = 0; flight < 29; flight += 1) {
      const hour = String(Math.floor(flight / 2) + 5).padStart(2, '0');
      offers.push(
        offer({
          flightNumber: `${day}-${flight}`,
          departureAt: `${date}T${hour}:${flight % 2 ? '45' : '15'}`,
          price: 180 + ((day * 13 + flight * 7) % 240),
        }),
      );
    }
    MONTH.push(snapshot(date, offers));
  }

  it('draws all 899 itineraries as nodes, in under half a second in jsdom', () => {
    const started = performance.now();
    const { container } = chart({ snapshots: MONTH, granularity: 'month' });
    const elapsed = performance.now() - started;

    expect(dots(container)).toHaveLength(899);
    expect(container.querySelectorAll('[data-testid="cheapest-rings"] circle')).toHaveLength(31);
    // Generous, because a shared runner is not a benchmark rig. The measured
    // figure on this machine is in the decision log; this only has to fail if
    // the cost changes by an order of magnitude.
    expect(elapsed).toBeLessThan(2000);
  });

  it('still finds the one flight nearest the pointer among nine hundred', () => {
    const { container } = chart({ snapshots: MONTH, granularity: 'month' });
    const svg = container.querySelector('svg')!;
    const target = dots(container)[500];
    fireEvent.pointerMove(svg, {
      clientX: Number(target.getAttribute('cx')),
      clientY: Number(target.getAttribute('cy')),
    });
    const marker = container.querySelector('[data-testid="scatter-crosshair"] circle')!;
    expect(marker.getAttribute('cx')).toBe(target.getAttribute('cx'));
    expect(marker.getAttribute('cy')).toBe(target.getAttribute('cy'));
  });

  /*
   * A smoke bound on the crosshair, not a benchmark.
   *
   * Measured on this machine, twenty moves across a month of 899 dots: 4.3 to
   * 6.1 ms a move with the cloud memoised, 16.9 to 18.4 ms with it rebuilt
   * inline. This test is honestly reported as *not* catching that difference —
   * a timing bound tight enough to fail on 17 ms would fail on a loaded runner
   * at 6, and this repository has already had to widen two timeouts for exactly
   * that. What it does catch is a change that makes the crosshair cost an order
   * of magnitude more, which is the failure that would make the view unusable.
   */
  it('keeps the crosshair cheap to move across nine hundred dots', () => {
    const { container } = chart({ snapshots: MONTH, granularity: 'month' });
    const svg = container.querySelector('svg')!;
    const all = dots(container);

    const started = performance.now();
    for (let move = 0; move < 20; move += 1) {
      const dot = all[move * 37];
      fireEvent.pointerMove(svg, {
        clientX: Number(dot.getAttribute('cx')),
        clientY: Number(dot.getAttribute('cy')),
      });
    }
    const perMove = (performance.now() - started) / 20;

    // The same nodes, not replacements — the dots were never torn down.
    expect(dots(container)[0]).toBe(all[0]);
    expect(perMove).toBeLessThan(60);
  });
});
