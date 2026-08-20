import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import type { Granularity } from '@/features/airfare/lib/buckets';
import { AnalysisPanel } from '@/features/airfare/ui/AnalysisPanel';
import type { CalendarCurve, FareOffer, FarePricePoint, FareSnapshot } from '@/shared/api/fares';

/**
 * The panel that holds the two charts, their controls, and the period.
 *
 * The defect this file was opened for: the period lived inside the flight
 * scatter, and the chart switch unmounts the flight scatter. A reader who
 * walked to the ninth of thirty-one departures, looked at the price history
 * and came back was returned to the first without anything having said so.
 * Nothing was reset on purpose — the state simply had nowhere to live that
 * outlived the view, which is a thing only a test at this level can see: every
 * test of the scatter alone passes either way, because a chart that is never
 * unmounted never loses anything.
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
 * 19 August 2026 over March 2027, which is 194 to 224 days ahead.
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
 * A booking horizon short enough to assert on: a fortnight of departures with
 * the 24th unsold and the 25th never answered for.
 */
const CURVE: CalendarCurve = {
  capturedAt: '2026-08-19T15:49:46+00:00',
  source: 'google-flights',
  currency: 'USD',
  fromDate: '2026-08-19',
  toDate: '2026-09-01',
  prices: [
    { departureDate: '2026-08-19', price: 164.88 },
    { departureDate: '2026-08-20', price: 119.5 },
    { departureDate: '2026-08-21', price: 96.2 },
    { departureDate: '2026-08-22', price: 88.4 },
    { departureDate: '2026-08-23', price: 41.24 },
    { departureDate: '2026-08-24', price: null },
    { departureDate: '2026-08-26', price: 62.94 },
    { departureDate: '2026-08-27', price: 62.94 },
    { departureDate: '2026-08-28', price: 62.94 },
    { departureDate: '2026-08-29', price: 62.94 },
    { departureDate: '2026-08-30', price: 62.94 },
    { departureDate: '2026-08-31', price: 62.94 },
    { departureDate: '2026-09-01', price: 62.94 },
  ],
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
const DAYS = 'What each day costs';

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('the period the reader is on', () => {
  it('is still the ninth departure after a look at the price chart and back', () => {
    render(<Harness />);
    click(DAYS);
    press('Next day with flights', 8);
    expect(screen.getByText('9 / 31')).toBeInTheDocument();

    click(MOVES);
    click(DAYS);

    expect(screen.getByText('9 / 31')).toBeInTheDocument();
    expect(screen.getByText(/on 09\/03\/2027, 00:00 to 23:59/)).toBeInTheDocument();
  });

  it('survives a look at the whole horizon and back to the month', () => {
    // The zoom unmounts the scatter exactly as the chart switch does, so the
    // period has to outlive the zoom as well as the switch — since the two ends
    // became one view, 12.170's defect has a second way in.
    render(<Harness />);
    click(DAYS);
    press('Next day with flights', 8);

    click('Whole horizon');
    click('Watched month');

    expect(screen.getByText('9 / 31')).toBeInTheDocument();
  });

  it('lands on the week holding the ninth, not on the first week of the month', () => {
    // The period is anchored on a departure day rather than on an index into
    // the periods — 12.143 — so the switch resolves it rather than reusing it.
    render(<Harness />);
    click(DAYS);
    press('Next day with flights', 8);

    click('Week');
    expect(
      screen.getByText(/between 08\/03\/2027 00:00 and 14\/03\/2027 23:59/),
    ).toBeInTheDocument();
  });

  it('goes back to the start when the reader opens a different watch', () => {
    // An anchor is a day of *one* watched month. Carrying it across would let
    // `activeKey` fall back silently, which reads as the arrows having lost
    // their place rather than as a new route.
    render(<Harness />);
    click(DAYS);
    press('Next day with flights', 8);
    expect(screen.getByText('9 / 31')).toBeInTheDocument();

    click('Open another route');
    expect(screen.getByText('1 / 31')).toBeInTheDocument();
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

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('ARI → SCL · March 2027');
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'ARI → SCL departing in March 2027',
    );
  });
});

describe('the two charts', () => {
  it('offers two rather than four, and opens on how the price moved', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: MOVES })).toHaveAttribute('aria-pressed', 'true');
    for (const gone of ['Price history', 'Lead time', 'Flights', 'Departure dates']) {
      expect(screen.queryByRole('button', { name: gone })).not.toBeInTheDocument();
    }
    expect(screen.getByText(/the x axis is when the price was observed/)).toBeInTheDocument();
  });

  it('leaves the observation-time chart drawn on observation time', () => {
    render(<Harness />);
    const chart = screen.getByRole('img');
    expect(chart.getAttribute('aria-label')).toContain('by day');
    // 62 observation days: our one pass lands inside the provider's own sixty-two.
    fireEvent.pointerMove(chart, { clientX: 744, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('on 19/08/2026, 00:00 to 23:59');
  });
});

describe('how the price moved, and the run-up reading that went with the focus', () => {
  it('offers no way to read the axis as the run-up to a flight', () => {
    /*
     * 12.267. 12.202 made observation time and lead time one chart with a
     * labelling control, and 12.204 offered the lead labelling only where the
     * route named one departure date — a month is thirty-one departures, so
     * one observation of it lands on thirty-one lead times at once and the
     * curve through them is a curve across departure date wearing lead time's
     * labels.
     *
     * The focus was the only thing that ever named that one departure. With it
     * gone the gate is false for every watch there can be, so the switch, the
     * second chart and the sentence explaining their absence are all removed
     * rather than left as a branch nothing can reach. `lib/leadTime.ts` is
     * kept, and its own suite still covers it.
     */
    render(<Harness route={ROUTE} />);

    expect(screen.queryByRole('group', { name: 'Read the axis as' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Days before departure' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'When we looked' })).not.toBeInTheDocument();
    // The explanation went too: it was a sentence about the watch that could
    // not have the reading, and every watch is that watch now.
    expect(screen.queryByText(/thirty-one different lead times at once/)).not.toBeInTheDocument();
  });

  it('leaves two switches on the chart it opens on, not three', () => {
    // Which chart, and how much time one point covers. The zoom is chart B's
    // and appears with it.
    render(<Harness route={ROUTE} />);

    expect(screen.getByRole('group', { name: 'Chart' })).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'How much time one point covers' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Zoom' })).not.toBeInTheDocument();
  });
});

describe('what each day costs, at both ends of its zoom', () => {
  it('opens on the watched month, with the itineraries themselves on it', () => {
    render(<Harness />);
    click(DAYS);

    expect(screen.getByRole('button', { name: 'Watched month' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText(/the x axis is when each itinerary departs/)).toBeInTheDocument();
    expect(screen.getByTestId('flight-dots')).toBeInTheDocument();
  });

  it('zooms out to the whole booking horizon without changing the question', () => {
    render(<Harness />);
    click(DAYS);
    click('Whole horizon');

    expect(screen.getByText(/the x axis is which departure date/)).toBeInTheDocument();
    const chart = screen.getByRole('img');
    expect(chart.getAttribute('aria-label')).toContain('by departure date');
    // The domain is the curve's own window, both ends written out under the plot.
    expect(screen.getByTestId('axis-from')).toHaveTextContent('19/08/2026');
    expect(screen.getByTestId('axis-to')).toHaveTextContent('01/09/2026');
  });

  it('keeps the two absences apart at the far end of the zoom', () => {
    render(<Harness />);
    click(DAYS);
    click('Whole horizon');

    // The 24th was answered for and had nothing to sell; the 25th never came
    // back at all. Wired end to end, they are still two different marks.
    expect(screen.getByTestId('hole-unsold')).toBeInTheDocument();
    expect(screen.getByTestId('hole-unanswered')).toBeInTheDocument();
  });

  it('says the horizon has never been collected rather than drawing an empty one', () => {
    render(<Harness curve={null} curveLoading={false} />);
    click(DAYS);
    click('Whole horizon');
    expect(screen.getByText(/No booking horizon collected for this route yet/)).toBeInTheDocument();
  });

  it('says a failed request failed rather than that nobody ever collected one', () => {
    render(
      <Harness curve={null} curveLoading={false} curveError={new Error('gateway timed out')} />,
    );
    click(DAYS);
    click('Whole horizon');
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be read: gateway timed out/);
    expect(screen.queryByText(/No booking horizon collected/)).not.toBeInTheDocument();
  });

  it('clips the near end of the zoom to the month the route is a watch on', () => {
    // March 2027's last ISO week runs to 4 April. The heading above this chart
    // says "departing in March 2027", and the frame under it must not draw four
    // days of April that no watch on this route has ever asked about.
    render(<Harness />);
    click(DAYS);
    click('Week');
    press('Next week with flights', 4);

    expect(
      screen.getByText(/between 29\/03\/2027 00:00 and 31\/03\/2027 23:59/),
    ).toBeInTheDocument();
    expect(screen.queryByText('01/04')).not.toBeInTheDocument();
  });

  it('hides the zoom while the other chart is open, rather than leaving it inert', () => {
    render(<Harness />);
    expect(screen.queryByRole('group', { name: 'Zoom' })).not.toBeInTheDocument();

    click(DAYS);
    expect(screen.getByRole('group', { name: 'Zoom' })).toBeInTheDocument();
  });
});

describe('the switch that says how wide one point is', () => {
  it('is named for what it does to both charts, not for observations alone', () => {
    // "Group observations by" described two of the four views it drove, and it
    // describes neither end of chart B: at the month zoom the switch decides
    // how much of the month one screen holds, at the horizon zoom how many
    // departure dates fold into one point. Neither is an observation — 12.205.
    render(<Harness />);

    expect(
      screen.getByRole('group', { name: 'How much time one point covers' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Group observations by' })).not.toBeInTheDocument();
  });

  it('still drives whichever chart the reader is actually on', () => {
    render(<Harness />);
    click(DAYS);
    click('Whole horizon');
    click('Week');
    expect(screen.getByText(/to read a week/)).toBeInTheDocument();
  });
});
