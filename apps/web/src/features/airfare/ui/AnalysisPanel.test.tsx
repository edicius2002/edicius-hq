import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import type { Granularity } from '@/features/airfare/lib/buckets';
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
 * A month with one of its days picked out — the shape every route the form has
 * added since 12.180 — and the archive as the page hands it over for one.
 *
 * `AirfarePage` narrows both series onto `readingPrefix` before this panel ever
 * sees them (12.131), so a focused watch arrives holding one departure's
 * snapshots and one departure's baseline.
 */
const FOCUSED: FareRoute = { ...ROUTE, focusDate: '2027-03-09' };
const FOCUS_SNAPSHOTS = MONTH.filter((snapshot) => snapshot.flightDate === '2027-03-09');
const FOCUS_BASELINE = BASELINE.filter((point) => point.flightDate === '2027-03-09');

/**
 * A booking horizon over the whole run-up and a month past the watched one.
 *
 * The real one is 331 dates from today; this is the same shape cut down to
 * something a test can assert on, with the two absences kept in it — the 24th
 * of August answered and empty, the 25th never answered for.
 */
const CURVE_PRICES: CalendarPoint[] = [
  { departureDate: '2026-08-19', price: 164.88 },
  { departureDate: '2026-08-20', price: 119.5 },
  { departureDate: '2026-08-24', price: null },
  { departureDate: '2026-08-26', price: 62.94 },
];
for (let day = 1; day <= 30; day += 1) {
  CURVE_PRICES.push({
    departureDate: `2027-04-${String(day).padStart(2, '0')}`,
    price: 70 + (day % 7),
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
 * The page's half of the arrangement: the granularity is the page's, because
 * the flight table under this panel is grouped by it too.
 */
function Harness(props: Partial<Parameters<typeof AnalysisPanel>[0]> = {}) {
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [route, setRoute] = useState<FareRoute | null>(ROUTE);
  return (
    <>
      <button type="button" onClick={() => setRoute({ ...ROUTE, destination: 'CUZ' })}>
        Open another route
      </button>
      <AnalysisPanel
        route={route}
        snapshots={MONTH}
        baseline={BASELINE}
        curve={CURVE}
        curveLoading={false}
        granularity={granularity}
        onGranularityChange={setGranularity}
        {...props}
      />
    </>
  );
}

beforeEach(() => {
  // jsdom measures every element as 0x0 and both charts divide a client
  // coordinate by the measured width. Given a box the size of the viewBox, a
  // clientX is a view unit.
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

describe('the period the reader is on', () => {
  it('is still the ninth departure after a look at the price chart and back', () => {
    render(<Harness />);
    openDeparture();
    press('Next day', 8);
    expect(screen.getByText('9 / 31')).toBeInTheDocument();

    click(MOVES);
    openDeparture();

    expect(screen.getByText('9 / 31')).toBeInTheDocument();
    expect(screen.getByText(/on 09\/03\/2027, 00:00 to 23:59/)).toBeInTheDocument();
  });

  it('lands on the week holding the ninth, not on the first week of the month', () => {
    // The period is anchored on a departure day rather than on an index into
    // the periods — 12.143 — so the switch resolves it rather than reusing it.
    render(<Harness />);
    openDeparture();
    press('Next day', 8);

    click('Week');
    expect(
      screen.getByText(/between 08\/03\/2027 00:00 and 14\/03\/2027 23:59/),
    ).toBeInTheDocument();
  });

  it('goes back to the start when the reader opens a different watch', () => {
    render(<Harness />);
    openDeparture();
    press('Next day', 8);
    expect(screen.getByText('9 / 31')).toBeInTheDocument();

    click('Open another route');
    expect(screen.getByText('1 / 31')).toBeInTheDocument();
  });
});

describe('what the panel says it is showing', () => {
  it('names the focused departure date and never the month it falls in', () => {
    render(<Harness route={FOCUSED} snapshots={FOCUS_SNAPSHOTS} baseline={FOCUS_BASELINE} />);

    const head = screen.getByRole('heading', { level: 2 });
    expect(head).toHaveTextContent('ARI → SCL · 09/03/2027');
    expect(head.textContent).not.toMatch(/March/);
  });

  it('says the chart is of a fare departing *on* that day, not *in* a month', () => {
    render(<Harness route={FOCUSED} snapshots={FOCUS_SNAPSHOTS} baseline={FOCUS_BASELINE} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'ARI → SCL departing on 09/03/2027',
    );
  });

  it('still names the month for a watch nobody has picked a day inside', () => {
    render(<Harness route={ROUTE} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('ARI → SCL · March 2027');
  });
});

describe('the controls that are gone', () => {
  it('offers no way to read the price axis as the run-up to a flight', () => {
    // Withdrawn rather than hidden: for a single departure date lead is the
    // observation date subtracted from the flight date, so it was one series
    // wearing two labellings — and the reading a reader actually wanted from it
    // is what the other chart draws, on the axis it belongs to.
    render(<Harness route={FOCUSED} snapshots={FOCUS_SNAPSHOTS} baseline={FOCUS_BASELINE} />);
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

  it('keeps the period switch in place on both charts, so the head never moves', () => {
    render(<Harness />);
    const group = () => screen.getByRole('group', { name: 'How much time one period covers' });
    expect(group()).toBeInTheDocument();
    openDeparture();
    expect(group()).toBeInTheDocument();
  });
});

describe('how the price moved, on one axis and one period', () => {
  it('is drawn by day whatever the period switch is set to', () => {
    // A week bucket folds a run of daily figures into a median of medians, and
    // what this chart exists to show is that the fare moved.
    render(<Harness />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('by day');

    click('Week');
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('by day');

    click('Month');
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('by day');
  });

  it('still counts the same observation days after the switch has been moved', () => {
    render(<Harness />);
    const before = screen.getByRole('img').getAttribute('aria-label');
    click('Month');
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(before);
  });

  it('reads the price of the day under the crosshair rather than the pointer height', () => {
    render(<Harness />);
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
    expect(screen.getByText(/each carries one cheapest fare for the whole date/)).toBeTruthy();
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
    press('Next day', 40);
    expect(screen.getByText('31 / 31')).toBeInTheDocument();
    expect(screen.getByText(/on 31\/03\/2027, 00:00 to 23:59/)).toBeInTheDocument();
  });

  it('lets the month view walk out to wherever the horizon reaches', () => {
    render(<Harness />);
    openDeparture();
    click('Month');
    press('Next month', 1);
    expect(screen.getByText(/between 01\/04\/2027 00:00 and 30\/04\/2027 23:59/)).toBeTruthy();
  });

  it('has nowhere outside the month to walk to where no horizon is on disk', () => {
    render(<Harness curve={null} />);
    openDeparture();
    click('Month');
    expect(screen.queryByLabelText('Next month')).not.toBeInTheDocument();
    expect(screen.getByTestId('horizon-note-live')).toHaveTextContent(
      'Every date in this frame is inside the watched month',
    );
  });
});
