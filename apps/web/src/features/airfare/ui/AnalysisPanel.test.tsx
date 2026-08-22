import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { useRouteView } from '@/features/airfare/hooks/useRouteView';
import { AnalysisPanel } from '@/features/airfare/ui/AnalysisPanel';
import type {
  CalendarCurve,
  CalendarPoint,
  FareOffer,
  FarePricePoint,
  FareSnapshot,
} from '@/shared/api/fares';

/**
 * The panel that holds the two charts, the switch between them, and the period.
 *
 * The defect this file was opened for: the period lived inside the departure
 * chart, and the chart switch unmounts that chart. A reader who walked to the
 * ninth of thirty-one departures, looked at the price history and came back was
 * returned to the first without anything having said so — a thing only a test
 * at this level can see, because a chart that is never unmounted never loses
 * anything.
 *
 * What it now also has to hold is which archive answers for the frame about to
 * be drawn, because the switch names the chart after it and the name must be
 * able to change without the switch changing size.
 */

const ROUTE: FareRoute = {
  origin: 'ARI',
  destination: 'SCL',
  month: '2027-03',
  currency: 'USD',
};

function offer(departureAt: string, price: number, flightNumber: string): FareOffer {
  return {
    airline: 'JA',
    airlineName: 'JetSMART',
    flightNumber,
    departureAt,
    arrivalAt: null,
    transfers: 0,
    durationMinutes: 80,
    price,
    currency: 'USD',
  };
}

/**
 * A watched month as the collector leaves it: thirty-one departures, each with
 * a board, all looked at on the same day.
 *
 * The shape of the real ARI–SCL archive rather than round numbers — one pass on
 * 19 August 2026 over March 2027.
 */
const MONTH: FareSnapshot[] = [];
for (let day = 1; day <= 31; day += 1) {
  const date = `2027-03-${String(day).padStart(2, '0')}`;
  MONTH.push({
    capturedAt: '2026-08-19T14:00',
    source: 'google-flights',
    origin: 'ARI',
    destination: 'SCL',
    flightDate: date,
    returnDate: null,
    currency: 'USD',
    insights: null,
    offers: [
      offer(`${date}T07:15`, 61 + (day % 5), `${day}a`),
      offer(`${date}T19:55`, 64 + (day % 5), `${day}b`),
    ],
  });
}

/** Two months of the provider's own history, one series per departure. */
const BASELINE: FarePricePoint[] = [];
for (let day = 1; day <= 31; day += 1) {
  const flightDate = `2027-03-${String(day).padStart(2, '0')}`;
  for (let back = 0; back < 62; back += 1) {
    const observed = new Date(Date.UTC(2026, 7, 19) - back * 86_400_000).toISOString().slice(0, 10);
    BASELINE.push({ flightDate, date: observed, price: 61 + ((day + back) % 5) });
  }
}

/**
 * A booking horizon over the whole run-up and a month past the watched one.
 *
 * The real one is 331 dates from today; this is the same shape cut down to
 * something a test can assert on, with the two absences kept in it — the 24th
 * of August answered and empty, the 25th never answered for.
 */
const COLLECTED_AT = '2026-08-19T15:49:46+00:00';

const CURVE_PRICES: CalendarPoint[] = [
  { departureDate: '2026-08-19', price: 164.88, observedAt: COLLECTED_AT },
  { departureDate: '2026-08-20', price: 119.5, observedAt: COLLECTED_AT },
  { departureDate: '2026-08-24', price: null, observedAt: COLLECTED_AT },
  { departureDate: '2026-08-26', price: 62.94, observedAt: COLLECTED_AT },
];
for (let day = 1; day <= 30; day += 1) {
  CURVE_PRICES.push({
    departureDate: `2027-04-${String(day).padStart(2, '0')}`,
    price: 70 + (day % 7),
    observedAt: COLLECTED_AT,
  });
}

const CURVE: CalendarCurve = {
  capturedAt: '2026-08-19T15:49:46+00:00',
  source: 'google-flights',
  currency: 'USD',
  fromDate: '2026-08-19',
  toDate: '2027-04-30',
  prices: CURVE_PRICES,
};

/**
 * The page's half of the arrangement, which is now one hook.
 *
 * The granularity, the anchor and the zoom all belong to the page because the
 * flight table under this panel is grouped by the first of them, and because a
 * reading is a *route's* rather than a page's. Using the real `useRouteView`
 * here rather than a `useState` of its own is deliberate: what these tests are
 * about includes what survives a change of route, and a harness that held the
 * state differently from the page would prove it about the harness.
 */
function Harness(props: Partial<Parameters<typeof AnalysisPanel>[0]> = {}) {
  const [route, setRoute] = useState<FareRoute | null>(ROUTE);
  const { view, setGranularity, setAnchor, setViewport } = useRouteView(
    route ? routeId(route) : null,
    route?.month ?? null,
  );
  return (
    <>
      <button type="button" onClick={() => setRoute({ ...ROUTE, destination: 'CUZ' })}>
        Open another route
      </button>
      <button type="button" onClick={() => setRoute(ROUTE)}>
        Back to the first route
      </button>
      <AnalysisPanel
        route={route}
        snapshots={MONTH}
        baseline={BASELINE}
        curve={CURVE}
        curveLoading={false}
        granularity={view.granularity}
        onGranularityChange={setGranularity}
        anchor={view.anchor}
        onAnchorChange={setAnchor}
        viewport={view.viewport}
        onViewportChange={setViewport}
        {...props}
      />
    </>
  );
}

beforeEach(() => {
  // jsdom measures every element as 0x0 and both charts convert a client
  // coordinate into their own viewBox before reading anything from it. A
  // clientX is a view unit only where the box shares the drawing's aspect
  // ratio, or where the drawing letterboxes inside it — `preserveAspectRatio`
  // centres a drawing it has to scale, and the bars either side are not part of
  // the plot. This box is 760×300, which letterboxes chart A's 760×284 with no
  // horizontal bars at all, and that is the only chart this file points at. It
  // pillarboxes chart B's 760×338 by 42.7 units a side, so a test that moved a
  // pointer over chart B here would have to place it as the browser paints it,
  // the way 'a box the drawing does not fill' does in `DepartureChart.test.tsx`.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 760,
    bottom: 300,
    width: 760,
    height: 300,
    toJSON: () => ({}),
  });
});

function press(label: string, times = 1) {
  for (let time = 0; time < times; time += 1) fireEvent.click(screen.getByLabelText(label));
}

/** The chart switch, by the names a reader sees on it. */
const MOVES = 'How the price moved';

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

/** Chart B's button, which cannot be found by a fixed name any more. */
function openDeparture() {
  fireEvent.click(screen.getByTestId('days-chart-button'));
}

function chartName(): string {
  return screen.getByTestId('days-chart-name').textContent ?? '';
}

/**
 * Which stretch of calendar the open chart is drawing, from the chart itself.
 *
 * The frame used to print its own bounds — `16 flights departing on 09/03/2027,
 * 00:00 to 23:59` — in the head above the plot, and these tests read them from
 * the page's text. It prints the count alone now, because the second half of
 * that sentence was the x axis saying in words what it draws two rows below.
 * The bounds are not gone: they are the chart's accessible name, which is where
 * a reader who cannot see the axis gets them, and that is the one place they
 * have to be right. So the assertions follow them there rather than being
 * dropped — what they were proving is that the panel's navigation lands the
 * frame on the period it claims, and that is exactly as true of the name.
 */
function frameLabel(): string {
  return screen.getByRole('img').getAttribute('aria-label') ?? '';
}

describe('the period the reader is on', () => {
  it('opens a watch it has never read on the whole of its own month', () => {
    /*
     * `a-watch-opens-on-its-own-month`, at the level a reader meets it. The
     * frame is March 2027 end to end — the month this watch is on — rather than
     * the first of its thirty-one departure days, and the switch says so.
     *
     * The month is named in full rather than checked as "not a day", because
     * the failure this is guarding against is landing on the *wrong* month: with
     * no anchor the frame falls back to the earliest thing on the axis, which
     * for this route is the booking horizon's August 2026.
     */
    render(<Harness />);
    openDeparture();

    expect(screen.getByRole('button', { name: 'Month' }).getAttribute('aria-pressed')).toBe('true');
    expect(frameLabel()).toContain('between 01/03/2027 00:00 and 31/03/2027 23:59');
    expect(chartName()).toBe('Flights seen');
  });

  it('is still the ninth departure after a look at the price chart and back', () => {
    render(<Harness />);
    openDeparture();
    click('Day');
    press('Next day', 8);
    expect(screen.getByText('9 / 31')).toBeInTheDocument();

    click(MOVES);
    openDeparture();

    expect(screen.getByText('9 / 31')).toBeInTheDocument();
    expect(frameLabel()).toContain('on 09/03/2027, 00:00 to 23:59');
  });

  it('lands on the week holding the ninth, not on the first week of the month', () => {
    // The period is anchored on a departure day rather than on an index into
    // the periods — 12.143 — so the switch resolves it rather than reusing it.
    render(<Harness />);
    openDeparture();
    click('Day');
    press('Next day', 8);

    click('Week');
    expect(frameLabel()).toContain('between 08/03/2027 00:00 and 14/03/2027 23:59');
  });

  it('opens a different watch on its own month rather than where the last one was left', () => {
    render(<Harness />);
    openDeparture();
    click('Day');
    press('Next day', 8);
    expect(screen.getByText('9 / 31')).toBeInTheDocument();

    click('Open another route');
    expect(screen.getByRole('button', { name: 'Month' }).getAttribute('aria-pressed')).toBe('true');
    expect(frameLabel()).toContain('between 01/03/2027 00:00 and 31/03/2027 23:59');
  });

  it('gives the reader back the day they chose rather than reopening on the month', () => {
    /*
     * The test that stops `a-watch-opens-on-its-own-month` becoming a bug: the
     * month is where a route with no reading *starts*, not a setting reapplied
     * every time the route is opened. Walk to one departure day, look at another
     * watch, come back — and the day is still there.
     */
    render(<Harness />);
    openDeparture();
    click('Day');
    press('Next day', 8);

    click('Open another route');
    click('Back to the first route');

    expect(screen.getByRole('button', { name: 'Day' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('9 / 31')).toBeInTheDocument();
    expect(frameLabel()).toContain('on 09/03/2027, 00:00 to 23:59');
  });
});

describe('what the panel says it is showing', () => {
  it('names the watched month, which is the whole of what a watch is', () => {
    /*
     * It briefly named a focused departure date instead, where a watch carried
     * one, because the figures under the head were that one day's — 12.131.
     * With the focus gone (12.260) there is one thing to name, and the page
     * narrows the snapshots to the same month before this panel sees them, so
     * the head and the figures under it cannot disagree.
     */
    render(<Harness route={ROUTE} />);

    const head = screen.getByRole('heading', { level: 2 });
    expect(head).toHaveTextContent('ARI → SCL · March 2027');
    expect(head.textContent).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('says the chart is of fares departing *in* a month, never *on* a day', () => {
    render(<Harness route={ROUTE} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'ARI → SCL departing in March 2027',
    );
  });
});

describe('the controls that are gone', () => {
  it('offers no way to read the price axis as the run-up to a flight', () => {
    // Withdrawn rather than hidden: for a single departure date lead is the
    // observation date subtracted from the flight date, so it was one series
    // wearing two labellings — and the reading a reader actually wanted from it
    // is what the other chart draws, on the axis it belongs to.
    render(<Harness route={ROUTE} />);
    expect(screen.queryByRole('group', { name: 'Read the axis as' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Days before departure' })).not.toBeInTheDocument();
    expect(screen.queryByText(/days before the flight/)).not.toBeInTheDocument();
  });

  it('offers no zoom, because the date now picks the archive', () => {
    render(<Harness />);
    openDeparture();
    expect(screen.queryByRole('group', { name: 'Zoom' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Whole horizon' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Watched month' })).not.toBeInTheDocument();
  });

  it('keeps no period switch in the panel head, on either chart', () => {
    /*
     * `period-switch-follows-its-chart` superseded, and this is the assertion
     * that replaces the one proving it.
     *
     * The switch used to stand in this head and fold away with chart A, holding
     * its own space open by `visibility` so that folding could not slide the two
     * chart buttons under a pressing hand — so the old test looked for a strip
     * that was in the layout and out of reach. There is no strip now: the switch
     * is inside the chart it moves, and the head's contents are the same on both
     * charts because they no longer depend on which chart is open. That is the
     * same no-reflow guarantee, so it is still asserted — by the stronger fact
     * that nothing here changes at all.
     */
    render(<Harness />);
    const head = screen.getByRole('group', { name: 'Chart' }).parentElement!;
    /*
     * The text and the controls, which are between them what sets this row's
     * width — not `innerHTML`, because pressing a chart button flips its own
     * `aria-pressed` and that is the change the reader asked for. What must not
     * move is how many controls are here and how wide their words are.
     */
    const shape = () => [head.textContent, head.querySelectorAll('button').length] as const;
    const before = shape();

    // Never in this row, on either chart. Scoped to the head rather than global,
    // because on chart B the switch does exist — one row further down — and the
    // claim here is only about where it is not.
    expect(head.querySelector('[aria-label="How much time one period covers"]')).toBeNull();

    openDeparture();
    expect(shape()).toEqual(before);
    expect(head.querySelector('[aria-label="How much time one period covers"]')).toBeNull();
  });

  it('opens on Flights seen, with its period switch already on screen', () => {
    /*
     * The chart a reader arrives to, pinned so it cannot drift back.
     *
     * Both halves matter and they are one decision. Opening on chart B is what
     * `the-panel-opens-on-flights-seen` says; the switch being present at the
     * first paint is what `period-switch-follows-its-chart` makes of that, and
     * it is the half a reader notices — `a-watch-opens-on-its-own-month` seeds
     * Month, and a control they cannot see is a choice made for them silently.
     */
    render(<Harness />);
    expect(screen.getByTestId('days-chart-button')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: MOVES })).toHaveAttribute('aria-pressed', 'false');
    expect(chartName()).toBe('Flights seen');
    expect(
      screen.getByRole('group', { name: 'How much time one period covers' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows no period switch on chart A, in any form', () => {
    /*
     * The owner's rule, stated as flatly as they stated it: "How the price
     * moved" must never show Week or Month. Not live, not inert, not reserved.
     *
     * Three ways it could come back and all three are checked. `queryByRole`
     * catches a switch a reader can reach; `hidden: true` catches one held in
     * the layout by `visibility` — the mechanism
     * `period-switch-follows-its-chart` used, which cost the space permanently
     * on the one chart that must never have the control; and the raw attribute
     * query catches a node that is present with neither.
     */
    render(<Harness />);
    // The panel opens on chart B since `the-panel-opens-on-flights-seen`, so
    // reaching chart A is now setup rather than the starting state.
    click(MOVES);
    expect(
      screen.queryByRole('group', { name: 'How much time one period covers' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'How much time one period covers', hidden: true }),
    ).not.toBeInTheDocument();
    for (const name of ['Day', 'Week', 'Month']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('extends the period switch from the Flights seen tab and takes it away with it', () => {
    /*
     * The placement `period-switch-follows-its-chart` had right: the control
     * belongs to chart B's tab, appears with it and goes away with it. What is
     * different is that nothing is reserved for it — it is rendered or it is
     * not.
     *
     * That is safe because it no longer shares a row with the chart pill. The
     * old arrangement put it beside those two buttons, where appearing would
     * slide them sideways under the hand that had just pressed one, and the
     * hidden strip existed to stop that. A row of its own cannot move them at
     * all, which is the whole reason the strip could go.
     */
    render(<Harness />);
    const head = screen.getByRole('group', { name: 'Chart' }).parentElement!;

    openDeparture();
    const shown = screen.getByRole('group', { name: 'How much time one period covers' });
    expect(shown).toBeInTheDocument();
    // Below the pill, not beside it, and outside the chart's own figure.
    expect(head).not.toContainElement(shown);
    expect(screen.getByRole('img').closest('figure')).not.toContainElement(shown);

    click(MOVES);
    expect(
      screen.queryByRole('group', { name: 'How much time one period covers', hidden: true }),
    ).not.toBeInTheDocument();
  });

  it('draws both charts inside one box that the switch does not replace', () => {
    /*
     * The structural half of `both-charts-share-one-fixed-box`. **jsdom lays
     * nothing out**, so nothing here can assert the height that decision is
     * about — that was measured in Chrome, at 150px of reflow before and zero
     * after, and this test cannot see a pixel of it.
     *
     * What it can pin is the arrangement the height rests on: there is one box,
     * both charts are rendered inside it, and changing chart does not replace
     * it. A future edit that returns either chart to being a direct child of the
     * panel would take its height back from the box without failing anything
     * else, and this is the assertion that notices.
     */
    const { container } = render(<Harness />);
    const box = () => container.querySelector('[class*="body"]');

    const before = box();
    expect(before).not.toBeNull();
    expect(before).toContainElement(screen.getByRole('img'));

    openDeparture();
    // The same node, not merely another one matching: a box torn down and
    // rebuilt per chart is a box that can be a different size per chart.
    expect(box()).toBe(before);
    expect(before).toContainElement(screen.getByRole('img'));

    click(MOVES);
    expect(box()).toBe(before);
    expect(before).toContainElement(screen.getByRole('img'));
  });

  it('keeps the period the reader chose across a change of chart', () => {
    // The switch only exists on chart B, so a period chosen there has to survive
    // a look at chart A and back — the value lives in `useRouteView`, above both
    // charts, and the flight table below the panel is grouped by it either way.
    render(<Harness />);
    openDeparture();
    click('Month');
    expect(frameLabel()).toContain('between 01/03/2027 00:00 and 31/03/2027 23:59');

    click(MOVES);
    openDeparture();
    expect(screen.getByRole('button', { name: 'Month' }).getAttribute('aria-pressed')).toBe('true');
    expect(frameLabel()).toContain('between 01/03/2027 00:00 and 31/03/2027 23:59');
  });
});

describe('how the price moved, on one axis and one period', () => {
  it('is drawn by day whatever the period switch is set to', () => {
    // A week bucket folds a run of daily figures into a median of medians, and
    // what this chart exists to show is that the fare moved.
    //
    // The switch now only reaches from chart B, so moving it means going there
    // and coming back. That the period survives the round trip is the page's
    // doing rather than the panel's — it is a route's reading and outlives
    // both charts — and it is what makes this test say anything at all.
    render(<Harness />);
    // The panel opens on chart B since `the-panel-opens-on-flights-seen`, so
    // reaching chart A is now setup rather than the starting state.
    click(MOVES);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('by day');

    openDeparture();
    click('Week');
    click(MOVES);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('by day');

    openDeparture();
    click('Month');
    click(MOVES);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('by day');
  });

  it('still counts the same observation days after the switch has been moved', () => {
    render(<Harness />);
    // The panel opens on chart B since `the-panel-opens-on-flights-seen`, so
    // reaching chart A is now setup rather than the starting state.
    click(MOVES);
    const before = screen.getByRole('img').getAttribute('aria-label');
    openDeparture();
    click('Month');
    click(MOVES);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(before);
  });

  it('reads the price of the day under the crosshair rather than the pointer height', () => {
    render(<Harness />);
    // The panel opens on chart B since `the-panel-opens-on-flights-seen`, so
    // reaching chart A is now setup rather than the starting state.
    click(MOVES);
    const chart = screen.getByRole('img');
    fireEvent.pointerMove(chart, { clientX: 744, clientY: 40 });
    const high = screen.getByTestId('price-tag-text').textContent;
    fireEvent.pointerMove(chart, { clientX: 744, clientY: 250 });
    expect(screen.getByTestId('price-tag-text').textContent).toBe(high);
    expect(screen.getByRole('status')).toHaveTextContent('on 19/08/2026, 00:00 to 23:59');
  });
});

describe('the name of the chart that follows what it draws', () => {
  it('calls itself Flights seen while every date in the frame is a board date', () => {
    render(<Harness />);
    expect(chartName()).toBe('Flights seen');
    openDeparture();
    expect(screen.getByTestId('flight-dots')).toBeInTheDocument();
  });

  it('calls itself both where the week straddles the end of the watched month', () => {
    // March 2027's last ISO week runs 29 March to 4 April: three board dates
    // and four curve dates in one frame.
    render(<Harness />);
    openDeparture();
    click('Week');
    press('Next week', 4);

    expect(chartName()).toBe('Flights and cheapest per date');
    expect(screen.getByTestId('source-board')).toBeInTheDocument();
    expect(screen.getByTestId('source-curve')).toBeInTheDocument();
    expect(screen.getAllByTestId('source-seam')).toHaveLength(1);
  });

  it('calls itself the cheapest per date once the frame has left the month', () => {
    render(<Harness />);
    openDeparture();
    click('Month');
    press('Next month', 1);

    expect(chartName()).toBe('Cheapest per date');
    expect(screen.queryByTestId('source-board')).not.toBeInTheDocument();
    // The line under the switch still names the archive that is answering, which
    // is the half of it a reader cannot get by looking; how the axis is built is
    // no longer restated above the axis, and neither is the hour — the source
    // rail on the plot says that, per stretch, and the two were near-identical.
    expect(screen.getByText('The booking horizon, beyond the watched month.')).toBeTruthy();
  });

  it('holds every name it can wear at once, so the switch cannot change width', () => {
    /*
     * The one mechanism behind "the text changes and nothing reflows". All four
     * names are in the button; the three that are not live are hidden with
     * `visibility`, which still takes its space, so the control is as wide as
     * its widest name whichever is showing. A `min-width` in pixels would be a
     * guess that the next type-scale change breaks.
     */
    render(<Harness />);
    const button = screen.getByTestId('days-chart-button');
    for (const name of [
      'What each date costs',
      'Flights seen',
      'Cheapest per date',
      'Flights and cheapest per date',
    ]) {
      expect(button.textContent).toContain(name);
    }
    // And only one of them is the live one, so a screen reader hears one name.
    expect(button.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
    expect(button).toHaveAccessibleName('Flights seen');
  });
});

describe('where the reader may walk', () => {
  it('cannot take the day view out of the watched month', () => {
    // The extreme case the owner ruled out — a single timeless number on a
    // 24-hour clock — is unreachable because the day view has thirty-one
    // periods and every one of them is a date the boards hold.
    render(<Harness />);
    openDeparture();
    click('Day');
    press('Next day', 40);
    expect(screen.getByText('31 / 31')).toBeInTheDocument();
    expect(frameLabel()).toContain('on 31/03/2027, 00:00 to 23:59');
  });

  it('lets the month view walk out to wherever the horizon reaches', () => {
    render(<Harness />);
    openDeparture();
    click('Month');
    press('Next month', 1);
    expect(frameLabel()).toContain('between 01/04/2027 00:00 and 30/04/2027 23:59');
  });

  it('has nowhere outside the month to walk to where no horizon is on disk', () => {
    render(<Harness curve={null} />);
    openDeparture();
    click('Month');
    expect(screen.queryByLabelText('Next month')).not.toBeInTheDocument();
    expect(screen.getByTestId('horizon-note-live')).toHaveTextContent(
      'Every date here is inside the watched month',
    );
  });
});
