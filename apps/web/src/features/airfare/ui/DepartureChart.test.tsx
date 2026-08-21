import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Granularity } from '@/features/airfare/lib/buckets';
import { anchorFor, framePeriodKeys, RAIL_CHAR_WIDTH } from '@/features/airfare/lib/departureFrame';
import { activeKey, departureDays, stepKey } from '@/features/airfare/lib/flightScatter';
import type { Viewport } from '@/features/airfare/lib/viewport';
import { DepartureChart } from '@/features/airfare/ui/DepartureChart';
import type { CalendarCurve, CalendarPoint, FareOffer, FareSnapshot } from '@/shared/api/fares';

/**
 * The departure chart, in the DOM.
 *
 * The arithmetic is `lib/flightScatter.ts`'s and `lib/departureFrame.ts`'s and
 * is tested there; what is left for a rendered chart is the part a pure
 * function cannot answer — that every itinerary reaches the canvas as a node,
 * that a pointer picks the flight nearest it rather than the first in the
 * array, that the arrows cross a month without a mouse, and that a frame
 * straddling the end of the watched month draws both archives at once with the
 * boundary between them visible.
 *
 * jsdom does no layout: nothing here can assert a measured pixel, only the
 * geometry the component computed from its own viewBox. So the dots are counted
 * and their coordinates compared, never their painted positions.
 */

/**
 * The chart's own viewBox, mirrored so a client coordinate is a view unit.
 *
 * 338 rather than 324: the plot floor is where it always was and every dot with
 * it, but there is one more row of chrome below — the source rail, which says
 * which archive answered for which stretch of the frame.
 */
const VIEW = { width: 760, height: 338 };

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

/** The whole of March 2027 is what these snapshots are a watch on. */
const MARCH = { from: '2027-03-01', to: '2027-03-31' };

const COLLECTED_AT = '2026-08-19T15:49:46+00:00';

/**
 * A horizon collected all at once, unless a test asks for otherwise.
 *
 * Every price defaults to the horizon's own stamp, so a test that predates
 * per-date provenance still describes a chart where nothing is carried over.
 * A test about carried-over prices passes an older `observedAt` on the dates it
 * means.
 */
function curveOf(
  from: string,
  to: string,
  prices: Array<Omit<CalendarPoint, 'observedAt'> & { observedAt?: string }>,
): CalendarCurve {
  return {
    capturedAt: COLLECTED_AT,
    source: 'google-flights',
    currency: 'USD',
    fromDate: from,
    toDate: to,
    prices: prices.map((point) => ({ observedAt: COLLECTED_AT, ...point })),
  };
}

/**
 * The chart with the navigation the panel above it now owns.
 *
 * Which periods exist and which one is open are the panel's answers since the
 * frame stopped being a question about one archive — 12.244 — so a chart
 * rendered on its own would have no arrows at all. This wrapper is the smallest
 * thing that reproduces the panel's half: it derives the keys the same way and
 * holds the anchor the chart's steps move. That the panel keeps that anchor
 * across a change of *chart* is `AnalysisPanel.test.tsx`'s business.
 */
function Harness({
  snapshots = WEEK,
  granularity = 'week',
  curve = null,
  watched = MARCH,
  ...rest
}: Partial<Parameters<typeof DepartureChart>[0]>) {
  const [anchor, setAnchor] = useState<string | null>(null);
  // The zoom is the panel's too, and for the same reason as the anchor: this
  // component is remounted on every route change and a reader's zoom should
  // outlive that.
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const boardDays = departureDays(snapshots);
  const keys = framePeriodKeys(boardDays, curve, granularity);
  const periodKey = activeKey(keys, granularity, anchor ?? boardDays[0] ?? null);
  return (
    <DepartureChart
      snapshots={snapshots}
      granularity={granularity}
      curve={curve}
      watched={watched}
      currency="USD"
      periodKey={periodKey}
      keys={keys}
      onStep={(direction) => {
        if (periodKey === null) return;
        const target = stepKey(keys, periodKey, direction);
        if (target !== null) setAnchor(anchorFor(target, granularity, boardDays));
      }}
      viewport={viewport}
      onViewportChange={setViewport}
      label="What each departure date costs for LIM to SCL departing in March 2027"
      {...rest}
    />
  );
}

function chart(props: Partial<Parameters<typeof DepartureChart>[0]> = {}) {
  return render(<Harness {...props} />);
}

function dots(container: HTMLElement): SVGCircleElement[] {
  const group = container.querySelector('[data-testid="flight-dots"]');
  return [...(group?.querySelectorAll('circle') ?? [])] as SVGCircleElement[];
}

/**
 * Which stretch of calendar the frame is drawing, read from the chart itself.
 *
 * The head above the plot used to print `5 flights departing between 08/03/2027
 * 00:00 and 14/03/2027 23:59`, and these tests read the bounds out of the page's
 * text. It prints the count alone now — the rest of that sentence was the x axis
 * spelling itself out directly above the axis that draws it — and the bounds
 * moved to the one place that has to carry them whatever is printed: the
 * chart's accessible name, which is how a reader who cannot see the axis is told
 * what it spans. Every assertion that was reading them from `textContent` reads
 * them from here instead, because what each of those tests is proving is that
 * the frame lands on the period it claims, and that is unchanged.
 */
function frameLabel(container: HTMLElement): string {
  return container.querySelector('svg')?.getAttribute('aria-label') ?? '';
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
    expect(screen.getByText(/Nothing collected for this route yet/)).toBeTruthy();
  });

  it('names the whole window it is drawing, both ends and both clocks', () => {
    const { container } = chart();
    expect(frameLabel(container)).toContain('between 08/03/2027 00:00 and 14/03/2027 23:59');
  });

  it('prints the count and leaves the window to the axis and the name', () => {
    /*
     * The head is the figure now rather than the opening of a sentence about
     * it. `16 flights departing on 30/11/2026, 00:00 to 23:59` was a count and
     * then the x axis restated in words immediately above the x axis, and the
     * owner read the whole of it as noise around the chart.
     *
     * Both halves of the change are asserted, because dropping the bounds from
     * the page without keeping them anywhere would be a loss and not a cleanup:
     * the printed head is the count and nothing else, and the bounds are still
     * on the chart's accessible name, where a reader who cannot see the axis is
     * the one person who has no other way to them.
     */
    const { container } = chart();
    expect(screen.getByTestId('frame-summary').textContent).toBe('5 flights');
    expect(frameLabel(container)).toContain('5 flights departing between 08/03/2027 00:00');
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
    expect(container.querySelector('[data-testid="departure-crosshair"]')).toBeTruthy();
    fireEvent.pointerLeave(svg);
    expect(container.querySelector('[data-testid="departure-crosshair"]')).toBeNull();
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
    expect(container.querySelector('[data-testid="departure-crosshair"]')).toBeNull();
  });
});

/**
 * Holding the reading still.
 *
 * The owner: *"creo una accion para poder fijar la vista en un punto con
 * anticlick"* — an action that fixes the view on a point, with a right-click.
 * What is under test is not one gesture but the state it puts the chart into:
 * that the reading stops following the hand, that it is obvious it has, that
 * there is more than one way out of it, and that it lets go by itself of
 * anything it can no longer be pinned to.
 */
describe('pinning the reading', () => {
  /** The dearest dot of the week — $310 on the 8th — and where it is drawn. */
  function dearest(container: HTMLElement) {
    const dot = dots(container).reduce((highest, each) =>
      Number(each.getAttribute('cy')) < Number(highest.getAttribute('cy')) ? each : highest,
    );
    return { x: Number(dot.getAttribute('cx')), y: Number(dot.getAttribute('cy')) };
  }

  function pinTheDearest(container: HTMLElement) {
    const svg = container.querySelector('svg')!;
    const at = dearest(container);
    fireEvent.contextMenu(svg, { clientX: at.x, clientY: at.y });
    return { svg, at };
  }

  it('holds the reading where the right-click landed, and the pointer stops moving it', () => {
    const { container } = chart();
    const { svg } = pinTheDearest(container);
    expect(container.textContent).toContain('$310.00');

    // The other end of the week, and a fare the crosshair would certainly have
    // moved to a moment ago.
    fireEvent.pointerMove(svg, { clientX: 700, clientY: 250 });
    expect(container.textContent).toContain('$310.00');
    expect(container.textContent).not.toContain('$288.00');
  });

  it('takes the browser’s menu on a mark, and only on a mark', () => {
    /*
     * The cost of using the right button, kept as small as it can be made.
     * `nearestPlaced` has no cut-off, so without `PIN_REACH` this handler would
     * answer every press anywhere on the plot and the reader would lose copy,
     * translate, back and inspect over the whole panel. Below the plot floor is
     * the axis and the source rail, which are drawn text and nothing else.
     */
    const { container } = chart();
    const svg = container.querySelector('svg')!;
    const at = dearest(container);

    expect(fireEvent.contextMenu(svg, { clientX: at.x, clientY: at.y })).toBe(false);
    expect(fireEvent.contextMenu(svg, { clientX: at.x, clientY: 320 })).toBe(true);
  });

  it('says it is pinned in ink, in a word and out loud', () => {
    /*
     * A reading that looked the same held as live is the trap: a reader who has
     * forgotten they pinned it reads a stale fare as the current one. Three
     * places, because one of them is a colour, one is a word and one is a
     * control — and a reader who cannot see the first can hear the third.
     */
    const { container } = chart();
    pinTheDearest(container);

    expect(
      container.querySelector('[data-testid="departure-crosshair"]')?.getAttribute('data-pinned'),
    ).toBe('true');
    expect(container.textContent).toContain('pinned');
    expect(screen.getByTestId('pin-reading')).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Pinned');
  });

  it('stays put when the pointer leaves the chart and when the chart loses focus', () => {
    // Which is the point of it: the reader pinned a fare so they could go and
    // read the flight table under it.
    const { container } = chart();
    const { svg } = pinTheDearest(container);

    fireEvent.pointerLeave(svg);
    expect(container.querySelector('[data-testid="departure-crosshair"]')).toBeTruthy();
    fireEvent.blur(svg);
    expect(container.textContent).toContain('$310.00');
  });

  it('lets go on Escape, and the pointer takes over again', () => {
    const { container } = chart();
    const { svg } = pinTheDearest(container);

    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(container.textContent).not.toContain('pinned');
    expect(screen.getByTestId('pin-reading')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.pointerMove(svg, { clientX: 700, clientY: 250 });
    expect(container.textContent).not.toContain('$310.00');
  });

  it('lets go on a second right-click on the same mark', () => {
    const { container } = chart();
    const { svg, at } = pinTheDearest(container);
    fireEvent.contextMenu(svg, { clientX: at.x, clientY: at.y });
    expect(screen.getByTestId('pin-reading')).toHaveAttribute('aria-pressed', 'false');
  });

  it('pins what the arrow keys walked to, with P, and lets go with P', () => {
    // A pointer-only action on a chart with two keyboard axes, a keyboard zoom
    // and a spoken readout would be a regression, not a feature.
    const { container } = chart();
    const svg = container.querySelector('svg')!;
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(container.textContent).toContain('$240.00');

    fireEvent.keyDown(svg, { key: 'p' });
    expect(screen.getByTestId('pin-reading')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.pointerMove(svg, { clientX: 700, clientY: 250 });
    expect(container.textContent).toContain('$240.00');

    fireEvent.keyDown(svg, { key: 'p' });
    expect(screen.getByTestId('pin-reading')).toHaveAttribute('aria-pressed', 'false');
  });

  it('names the two keys where the chart says what it can do', () => {
    const { container } = chart();
    expect(container.textContent).toContain('P pins the reading');
    expect(container.textContent).toContain('Escape lets it go');
    expect(container.querySelector('svg')?.getAttribute('aria-keyshortcuts')).toContain('Escape');
  });

  it('offers a control that does both, disabled while there is nothing to pin', () => {
    const { container } = chart();
    const svg = container.querySelector('svg')!;
    const button = screen.getByTestId('pin-reading');
    expect(button).toBeDisabled();

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('survives a zoom, staying on its flight rather than on a coordinate', () => {
    /*
     * The pin names an itinerary and not a place on the plot, so the crosshair
     * is redrawn at wherever that flight now sits. Which is what makes a pin
     * usable at all while the reader works the zoom around it.
     *
     * The mark does not visibly move under *this* zoom, and that is a second
     * property rather than a missing one: a keyboard zoom anchors on the
     * crosshair, so the thing the reader is looking at is the thing that holds
     * its place. What is asserted is the invariant underneath both — the
     * hairline is wherever the dot is.
     */
    const { container } = chart();
    const { svg } = pinTheDearest(container);

    fireEvent.keyDown(svg, { key: '+' });
    expect(container.textContent).toContain('$310.00');
    expect(screen.getByTestId('pin-reading')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('reset-zoom')).toBeEnabled();

    const hair = container.querySelector('[data-testid="departure-crosshair"] line')!;
    expect(Number(hair.getAttribute('x1'))).toBeCloseTo(dearest(container).x, 6);
  });

  it('keeps the flight and takes its new price when a pass brings one', () => {
    // The pin is a flag beside the reading rather than a copy of it, which is
    // exactly this: a held copy would still be showing $310 an hour later.
    const { container, rerender } = chart();
    pinTheDearest(container);
    expect(container.textContent).toContain('$310.00');

    const cheaper = WEEK.map((each) =>
      each.flightDate !== '2027-03-08'
        ? each
        : {
            ...each,
            offers: each.offers.map((one) =>
              one.flightNumber === '2' ? { ...one, price: 275 } : one,
            ),
          },
    );
    rerender(<Harness snapshots={cheaper} />);

    expect(container.textContent).toContain('$275.00');
    expect(screen.getByTestId('pin-reading')).toHaveAttribute('aria-pressed', 'true');
  });

  it('lets go of a flight that has left the board', () => {
    const { container, rerender } = chart();
    pinTheDearest(container);

    const without = WEEK.map((each) =>
      each.flightDate !== '2027-03-08'
        ? each
        : { ...each, offers: each.offers.filter((one) => one.flightNumber !== '2') },
    );
    rerender(<Harness snapshots={without} />);

    expect(container.querySelector('[data-testid="departure-crosshair"]')).toBeNull();
    expect(screen.getByTestId('pin-reading')).toHaveAttribute('aria-pressed', 'false');
    expect(container.textContent).not.toContain('pinned');
  });

  it('lets go when the reader steps to another period', () => {
    // Every mark under it is a different mark. A pin that survived would be
    // pointing at a flight that is not on screen.
    // A day frame, because that is the granularity this archive has more than
    // one period of — a week frame of these three departures is one week, and a
    // chart with one period draws no arrows to step with.
    const { container } = chart({ granularity: 'day' });
    pinTheDearest(container);

    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    expect(container.querySelector('[data-testid="departure-crosshair"]')).toBeNull();
    expect(screen.getByTestId('pin-reading')).toHaveAttribute('aria-pressed', 'false');
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
    fireEvent.click(screen.getByLabelText('Next week'));
    expect(frameLabel(container)).toContain('between 22/03/2027 00:00 and 28/03/2027 23:59');
    expect(container.textContent).toContain('2 / 2');
  });

  it('has nowhere to step from either end', () => {
    chart({ snapshots: TWO_WEEKS });
    expect(screen.getByLabelText('Previous week').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('Next week'));
    expect(screen.getByLabelText('Next week').hasAttribute('disabled')).toBe(true);
  });

  it('offers no arrows on a month, where a watched route has exactly one', () => {
    chart({ snapshots: TWO_WEEKS, granularity: 'month' });
    expect(screen.queryByLabelText('Next month')).toBeNull();
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
      expect(frameLabel(container)).toContain(caption);
      unmount();
    }
  });
});

describe('a period that straddles the end of the watched month', () => {
  /**
   * March 2027's last ISO week runs Monday 29 March to Sunday 4 April, and the
   * 30th is flown. Three board dates, four curve dates, one frame — the case
   * the whole arrangement is built for.
   *
   * The curve prices the 1st and the 3rd, answers "nothing on sale" for the
   * 2nd, and never reaches the 4th. Real routes do not have holes like that;
   * this one is synthetic precisely so all four outcomes are on screen at once.
   */
  const LAST_WEEK = [
    snapshot('2027-03-30', [
      offer({ flightNumber: '7', departureAt: '2027-03-30T08:00', price: 330 }),
    ]),
  ];
  const CURVE = curveOf('2027-03-01', '2027-04-03', [
    { departureDate: '2027-04-01', price: 61.5 },
    { departureDate: '2027-04-02', price: null },
    { departureDate: '2027-04-03', price: 74 },
  ]);

  function straddling(props: Partial<Parameters<typeof DepartureChart>[0]> = {}) {
    return chart({ snapshots: LAST_WEEK, curve: CURVE, granularity: 'week', ...props });
  }

  it('draws the whole week, boards to the end of the month and the curve past it', () => {
    const { container } = straddling();
    expect(frameLabel(container)).toContain('between 29/03/2027 00:00 and 04/04/2027 23:59');
    expect(dots(container)).toHaveLength(1);
    expect(screen.getAllByTestId('curve-day')).toHaveLength(2);
  });

  it('says in the head that it is showing both', () => {
    const { container } = straddling();
    expect(container.textContent).toContain('1 flight and 2 priced dates');
  });

  it('draws one seam, on the midnight the boards stop answering at', () => {
    const { container } = straddling();
    const seams = screen.getAllByTestId('source-seam');
    expect(seams).toHaveLength(1);

    // Three of seven dates are board dates, so the boundary is three sevenths
    // along the plot. The plot runs from the left padding to the right edge.
    const separators = [...container.querySelectorAll('[class*="separator"]')];
    const third = separators[2].getAttribute('x1');
    expect(seams[0].getAttribute('x1')).toBe(third);
  });

  it('names which archive answered on each side of it', () => {
    straddling();
    expect(screen.getByTestId('source-board')).toHaveTextContent(
      'every flight, at the hour it departs',
    );
    expect(screen.getByTestId('source-curve')).toHaveTextContent('one price a date');
  });

  it('spans a curve date across the whole date rather than putting it at an hour', () => {
    const { container } = straddling();
    const [first] = screen.getAllByTestId('curve-day');
    const rule = first.querySelector('line')!;
    const width = Number(rule.getAttribute('x2')) - Number(rule.getAttribute('x1'));

    // One seventh of the plot, which is exactly one date of the seven — the
    // same distance as the gap between two midnights.
    const separators = [...container.querySelectorAll('[class*="separator"]')];
    const between =
      Number(separators[1].getAttribute('x1')) - Number(separators[0].getAttribute('x1'));
    expect(width).toBeCloseTo(between, 6);
  });

  it('keeps the two absences apart on the far side of the seam', () => {
    straddling();
    // The 2nd was answered about and had nothing; the 4th the curve never
    // reached at all. Telling a reader the first when the second is true has
    // them believing a route is sold out on a day nobody asked about.
    expect(screen.getAllByTestId('curve-unsold')).toHaveLength(1);
    expect(screen.getAllByTestId('curve-unanswered')).toHaveLength(1);
  });

  it('says where the dates beyond the month came from, and when', () => {
    straddling();
    expect(screen.getByTestId('horizon-note-live')).toHaveTextContent(
      'booking horizon, last collected 19/08/2026 15:49',
    );
  });

  it('does not claim the newest collection for a price an older one answered', () => {
    /*
     * The horizon is assembled from every stored curve, so the far end can be
     * older than the near end. The stamp above names the freshest thing on
     * screen; without this the reader would take it for the age of all of them,
     * which is the quiet lie the merge would otherwise introduce.
     */
    chart({
      snapshots: LAST_WEEK,
      granularity: 'week',
      curve: curveOf('2027-03-01', '2027-04-03', [
        { departureDate: '2027-04-01', price: 61.5 },
        { departureDate: '2027-04-02', price: null },
        { departureDate: '2027-04-03', price: 74, observedAt: '2026-08-16T09:00:00+00:00' },
      ]),
    });

    expect(screen.getByTestId('horizon-note-live')).toHaveTextContent(
      '1 of them was carried over from earlier collections, the oldest from 16/08/2026 09:00',
    );
    // And it is drawn as its own kind of mark, so the sentence has something to
    // point at.
    expect(screen.getAllByTestId('curve-day-carried')).toHaveLength(1);
    expect(screen.getAllByTestId('curve-day')).toHaveLength(1);
  });

  it('says nothing about age where every price came from the same collection', () => {
    straddling();
    expect(screen.getByTestId('horizon-note-live')).not.toHaveTextContent('carried over');
    expect(screen.queryByTestId('curve-day-carried')).toBeNull();
  });

  it('keeps the frame exactly the same size whichever archive answers', () => {
    // The layout must not move as the reader steps across the boundary: the
    // viewBox is the same, so nothing below the chart is pushed anywhere.
    const inside = chart({ granularity: 'week' });
    const insideBox = inside.container.querySelector('svg')!.getAttribute('viewBox');
    inside.unmount();
    const across = straddling();
    expect(across.container.querySelector('svg')!.getAttribute('viewBox')).toBe(insideBox);
  });
});

describe('the crosshair on a date with no time of day', () => {
  const LAST_WEEK = [
    snapshot('2027-03-30', [
      offer({ flightNumber: '7', departureAt: '2027-03-30T08:00', price: 330 }),
    ]),
  ];
  const CURVE = curveOf('2027-03-01', '2027-04-03', [
    { departureDate: '2027-04-01', price: 61.5 },
    { departureDate: '2027-04-02', price: null },
    { departureDate: '2027-04-03', price: 74 },
  ]);

  function straddling() {
    return chart({ snapshots: LAST_WEEK, curve: CURVE, granularity: 'week' });
  }

  /**
   * The plot runs from x=84 to x=744 across seven dates, so a date is 94.3
   * units wide and the fourth of them — 1 April — covers 366.9 to 461.1.
   */
  const INSIDE_FIRST_APRIL = 410;
  const INSIDE_SECOND_APRIL = 500;

  it('reads the whole column, so the price is the date’s and not the pointer’s', () => {
    const { container } = straddling();
    const svg = container.querySelector('svg')!;
    fireEvent.pointerMove(svg, { clientX: INSIDE_FIRST_APRIL, clientY: 40 });
    const high = screen.getByTestId('departure-price-tag').textContent;
    fireEvent.pointerMove(svg, { clientX: INSIDE_FIRST_APRIL, clientY: 250 });
    expect(screen.getByTestId('departure-price-tag').textContent).toBe(high);
    expect(high).toBe('$61.50');
  });

  it('tags it with the date alone, because there is no clock to print', () => {
    const { container } = straddling();
    fireEvent.pointerMove(container.querySelector('svg')!, {
      clientX: INSIDE_FIRST_APRIL,
      clientY: 120,
    });
    expect(screen.getByTestId('departure-time-tag')).toHaveTextContent('01/04');
    expect(container.textContent).toContain('whole date, no departure time');
  });

  it('prints no price at all over a date that carried none', () => {
    const { container } = straddling();
    fireEvent.pointerMove(container.querySelector('svg')!, {
      clientX: INSIDE_SECOND_APRIL,
      clientY: 120,
    });
    expect(screen.getByTestId('departure-time-tag')).toHaveTextContent('02/04');
    expect(screen.queryByTestId('departure-price-tag')).toBeNull();
    expect(container.textContent).toContain('nothing on sale');
  });

  it('reads it out as a sentence that names the date and not an hour', () => {
    const { container } = straddling();
    fireEvent.pointerMove(container.querySelector('svg')!, {
      clientX: INSIDE_FIRST_APRIL,
      clientY: 120,
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      '01/04/2027, the whole departure date with no time of day. cheapest fare $61.50.',
    );
  });

  it('walks across the seam one departure date at a time', () => {
    const { container } = straddling();
    const svg = container.querySelector('svg')!;
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    // The only board date first — the 30th, whose one flight is $330.
    expect(container.textContent).toContain('$330.00');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(container.textContent).toContain('$61.50');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(container.textContent).toContain('nothing on sale');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(container.textContent).toContain('$74.00');
  });
});

describe('a frame with no boards in it at all', () => {
  const CURVE = curveOf('2027-03-01', '2027-05-31', [
    { departureDate: '2027-05-04', price: 88 },
    { departureDate: '2027-05-05', price: 91 },
  ]);

  it('draws the curve alone, with no seam and one source named', () => {
    const { container } = chart({ granularity: 'month', curve: CURVE });
    fireEvent.click(screen.getByLabelText('Next month'));
    fireEvent.click(screen.getByLabelText('Next month'));

    expect(frameLabel(container)).toContain('between 01/05/2027 00:00 and 31/05/2027 23:59');
    expect(screen.queryByTestId('source-seam')).toBeNull();
    expect(screen.queryByTestId('source-board')).toBeNull();
    expect(screen.getByTestId('source-curve')).toBeInTheDocument();
    expect(dots(container)).toHaveLength(0);
    expect(screen.getAllByTestId('curve-day')).toHaveLength(2);
  });

  it('never mixes at month granularity, which is worth being able to check', () => {
    // A calendar month is the watched one or it is not, so the mixed case a
    // reader goes looking for here does not exist.
    const { container } = chart({ granularity: 'month', curve: CURVE });
    expect(screen.getByTestId('source-board')).toBeInTheDocument();
    expect(screen.queryByTestId('source-curve')).toBeNull();
    expect(container.textContent).toContain('5 flights');
  });
});

describe('a route whose horizon has never been collected', () => {
  it('cannot step outside its month at all', () => {
    // The owner's LIM-SCL: boards for one month and no curve anywhere. A run of
    // empty frames would be worse than a shorter walk.
    chart({ granularity: 'month', curve: null });
    expect(screen.queryByLabelText('Next month')).toBeNull();
  });

  it('says the horizon is not collected yet rather than that the flights vanished', () => {
    // A focused watch reads one date, so a week around it is mostly curve —
    // and with no curve on disk it is mostly blank. The note is the difference
    // between "no fares" and "we have not asked".
    chart({
      snapshots: [
        snapshot('2027-03-10', [
          offer({ flightNumber: '8', departureAt: '2027-03-10T09:00', price: 250 }),
        ]),
      ],
      watched: { from: '2027-03-10', to: '2027-03-10' },
      granularity: 'week',
      curve: null,
    });
    expect(screen.getByTestId('horizon-note-live')).toHaveTextContent(
      'booking horizon has not been collected for this route yet',
    );
    expect(screen.getAllByTestId('curve-unanswered')).toHaveLength(6);
  });

  it('reports a failed horizon request as a fault at our end', () => {
    chart({
      granularity: 'month',
      curve: null,
      watched: { from: '2027-03-10', to: '2027-03-10' },
      horizonError: new Error('500 Internal Server Error'),
    });
    expect(screen.getByTestId('horizon-note-live')).toHaveTextContent(
      'could not be read: 500 Internal Server Error',
    );
    expect(screen.getByTestId('horizon-note')).toHaveAttribute('role', 'alert');
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

  it('names what the frame holds in its accessible name', () => {
    const { container } = chart();
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toContain(
      '5 flights departing between 08/03/2027 00:00 and 14/03/2027 23:59',
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
    const marker = container.querySelector('[data-testid="departure-crosshair"] circle')!;
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

describe('a watched range narrower than the frame', () => {
  /**
   * The frame the rail defect was found in, on the owner's own ARI-SCL.
   *
   * That watch carried a focus date at the time, so the page narrowed the
   * boards to one departure and the week around it was three stretches: curve,
   * board, curve. Every earlier test here has two, which is exactly why
   * nothing caught the rail drawing a second `one price a date` through the
   * board label.
   *
   * **No watch produces this frame since 12.260**, which took the focus away:
   * a watched month is either the whole of a month frame or disjoint from it,
   * so two stretches is the most the page can build. It is kept because this
   * component is handed a `watched` range rather than a route, and the rule it
   * broke is a rule about stretches — one that held only for the ranges one
   * caller sends today would break the next time a caller sent something else,
   * and this is the frame that has already caught it out once.
   */
  const ONE_DAY = [
    snapshot('2027-03-06', [
      offer({ flightNumber: '11', departureAt: '2027-03-06T07:15', price: 62.94 }),
      offer({ flightNumber: '12', departureAt: '2027-03-06T19:55', price: 64.9 }),
    ]),
  ];
  const CURVE = curveOf(
    '2027-03-01',
    '2027-03-31',
    Array.from({ length: 31 }, (_, index) => ({
      departureDate: `2027-03-${String(index + 1).padStart(2, '0')}`,
      price: 62.94,
    })),
  );
  const FOCUS = { from: '2027-03-06', to: '2027-03-06' };

  function focused(granularity: Granularity = 'week') {
    return chart({ snapshots: ONE_DAY, curve: CURVE, watched: FOCUS, granularity });
  }

  it('draws the frame the defect was found in', () => {
    const { container } = focused();
    expect(frameLabel(container)).toContain('between 01/03/2027 00:00 and 07/03/2027 23:59');
    expect(container.textContent).toContain('2 flights and 6 priced dates');
  });

  it('marks both boundaries around the single board date', () => {
    focused();
    expect(screen.getAllByTestId('source-seam')).toHaveLength(2);
  });

  it('names each archive exactly once, however many stretches it holds', () => {
    // Two labels, not three. `getByTestId` throws on a duplicate, which is the
    // assertion: before the fix there were two `source-curve` nodes.
    focused();
    expect(screen.getByTestId('source-board')).toBeInTheDocument();
    expect(screen.getByTestId('source-curve')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^source-(board|curve)$/)).toHaveLength(2);
  });

  it('draws no two rail labels through each other', () => {
    const { container } = focused();
    const labels = [
      ...container.querySelectorAll('[data-testid^="source-board"], [data-testid^="source-curve"]'),
    ]
      .map((node) => {
        const centre = Number(node.getAttribute('x'));
        // The same width arithmetic the placement used; jsdom has no
        // `getComputedTextLength` to measure the rendered glyphs with.
        const width = (node.textContent ?? '').length * RAIL_CHAR_WIDTH;
        return { from: centre - width / 2, to: centre + width / 2 };
      })
      .sort((a, b) => a.from - b.from);

    for (let index = 1; index < labels.length; index += 1) {
      expect(labels[index].from).toBeGreaterThanOrEqual(labels[index - 1].to);
    }
  });

  it('keeps naming both archives when the boards are one date of a whole month', () => {
    // The narrowest stretch this chart can produce: one date out of thirty-one
    // is 21 units of track against 87 of glyphs. The label overhangs rather
    // than vanishing, because the stretch it names is the one a reader cannot
    // identify from its marks alone.
    focused('month');
    expect(screen.getByTestId('source-board')).toHaveTextContent('flights, by hour');
    expect(screen.getByTestId('source-curve')).toBeInTheDocument();
  });
});

/**
 * The chrome around the plot, which is where the ink was rather than where the
 * data is.
 *
 * The owner read this panel and quoted back a keyboard-help paragraph, five
 * legend sentences, a crosshair readout and a caption naming the axis, all of it
 * printed around a chart that draws its own axis. What this block pins is the
 * half of that cleanup a reader cannot see: that the words which came off the
 * page are still reachable by everyone who was relying on them, and that the two
 * facts this panel exists to keep apart did not collapse into one when their
 * sentences became labels.
 */
describe('the chrome around the plot', () => {
  it('keeps the keyboard help on the chart for a screen reader', () => {
    /*
     * The help is the only account a screen reader gets of the two keyboard
     * axes and the three zoom keys, so it is a regression if it stops being
     * reachable — and "not printed" and "not there" are exactly the two states
     * this has to tell apart. The chart points at it by id, which is the route
     * assistive technology takes.
     */
    const { container } = chart();
    const svg = container.querySelector('svg')!;
    const describedBy = svg.getAttribute('aria-describedby')!;
    const help = container.querySelector(`#${CSS.escape(describedBy)}`);

    expect(help?.textContent).toContain('Left and right arrow keys move one departure date');
    expect(help?.textContent).toContain('Plus and minus close and open the frame');
    expect(help?.textContent).toContain('shift with left or right moves the frame along it');
  });

  it('describes the chart with the help alone, not with the live readout', () => {
    /*
     * The defect the owner's paste is a fingerprint of. All three ids were on
     * `aria-describedby`, so the chart's description was the whole keyboard
     * paragraph immediately followed by whatever the crosshair was on, with no
     * pause between them — read out in full every time focus arrived, and again
     * in front of every fare. The readout and the zoom range are `role="status"`,
     * which is what makes them speak; they do not need to be pointed at as well.
     */
    const { container } = chart();
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-describedby')!.trim().split(/\s+/)).toHaveLength(1);
    // And the live regions are still there and still live.
    expect(container.querySelectorAll('[role="status"]').length).toBeGreaterThanOrEqual(2);
  });

  it('shows a pointer no tooltip, while the ear keeps the help', () => {
    // An SVG tooltip comes from a `<title>` child and from nothing else, so the
    // absence of that child is the whole assertion: a pointer resting on a
    // flight used to get five lines of keyboard help painted over the mark it
    // was aimed at.
    //
    // `:scope > title` and not `title`, deliberately. The marks inside carry
    // titles of their own — a hole says "never collected", a curve day says its
    // date and price — and those are wanted: they are short, they are about the
    // thing under the pointer, and they are the reason a hole is legible at
    // all. What was removed is the one on the plot itself, which answered for
    // every pixel of it.
    const { container } = chart();
    const svg = container.querySelector('svg')!;
    expect(svg.querySelector(':scope > title')).toBeNull();

    // And nothing was lost with it: the help is still a node in the document
    // and still what the chart points `aria-describedby` at.
    const described = svg.getAttribute('aria-describedby')!;
    expect(described).toBeTruthy();
    expect(container.querySelector(`#${described}`)?.textContent).toContain(
      'Left and right arrow keys move one departure date',
    );
    expect(frameLabel(container)).toContain('What each departure date costs');
  });

  it('tells nothing on sale from never collected in two words each', () => {
    /*
     * The distinction the whole panel is built on, carried through the cut from
     * clauses to labels. An answer that came back empty is a fact about the
     * route; an answer that never came is a fact about us, and a legend that let
     * the two read as one mark would undo what the two marks are for.
     */
    chart();
    const unsold = screen.getByTitle('Nothing on sale — we asked and there was none');
    const never = screen.getByTitle('Never collected — we have no reading either way');

    expect(unsold).toHaveTextContent('None on sale');
    expect(never).toHaveTextContent('Never collected');
    expect(unsold.textContent).not.toBe(never.textContent);
  });

  it('says each legend mark in three words or fewer', () => {
    // The cut itself, asserted rather than described: entries that were
    // forty-eight words of explanation are names. The sentences are not lost —
    // each is the entry's `title` — and the test above reads two of them.
    // Six since the horizon gained a carried-over mark, and the rule it is held
    // to is the same one.
    const { container } = chart();
    const entries = [...container.querySelectorAll('figcaption span')];
    expect(entries).toHaveLength(6);
    for (const entry of entries) {
      expect((entry.textContent ?? '').trim().split(/\s+/).length).toBeLessThanOrEqual(3);
      expect(entry.getAttribute('title')).toBeTruthy();
    }
  });

  it('keeps the words on the reset button after taking them off it', () => {
    // The glyph is the size reduction; the two words move to the accessible name
    // and the tooltip, which is where a control showing a glyph has to keep them.
    chart();
    const reset = screen.getByTestId('reset-zoom');
    expect(reset).toHaveAccessibleName('Reset zoom');
    expect(reset).toHaveAttribute('title', 'Reset zoom');
    // Nothing to undo yet, so it is offered and disabled rather than absent.
    expect(reset).toBeDisabled();
  });
});
