import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import type { Granularity } from '@/features/airfare/lib/buckets';
import { AnalysisPanel } from '@/features/airfare/ui/AnalysisPanel';
import type { FareOffer, FarePricePoint, FareSnapshot } from '@/shared/api/fares';

/**
 * The panel that holds the three views, the two switches, and the period.
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

describe('the period the reader is on', () => {
  it('is still the ninth departure after a look at the price history and back', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Flights' }));
    press('Next day with flights', 8);
    expect(screen.getByText('9 / 31')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Price history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Flights' }));

    expect(screen.getByText('9 / 31')).toBeInTheDocument();
    expect(screen.getByText(/on 09\/03\/2027, 00:00 to 23:59/)).toBeInTheDocument();
  });

  it('survives the lead-time view in between as well', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Flights' }));
    press('Next day with flights', 8);

    fireEvent.click(screen.getByRole('button', { name: 'Lead time' }));
    fireEvent.click(screen.getByRole('button', { name: 'Flights' }));

    expect(screen.getByText('9 / 31')).toBeInTheDocument();
  });

  it('lands on the week holding the ninth, not on the first week of the month', () => {
    // The period is anchored on a departure day rather than on an index into
    // the periods — 12.143 — so the switch resolves it rather than reusing it.
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Flights' }));
    press('Next day with flights', 8);

    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    expect(
      screen.getByText(/between 08\/03\/2027 00:00 and 14\/03\/2027 23:59/),
    ).toBeInTheDocument();
  });

  it('goes back to the start when the reader opens a different watch', () => {
    // An anchor is a day of *one* watched month. Carrying it across would let
    // `activeKey` fall back silently, which reads as the arrows having lost
    // their place rather than as a new route.
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Flights' }));
    press('Next day with flights', 8);
    expect(screen.getByText('9 / 31')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open another route' }));
    expect(screen.getByText('1 / 31')).toBeInTheDocument();
  });
});

describe('the three views', () => {
  it('offers all three and opens on the price history', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Price history' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
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

  it('draws the lead-time chart on days before departure instead of on dates', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Lead time' }));
    expect(screen.getByText(/whole days before the flight, not dates/)).toBeInTheDocument();

    const chart = screen.getByRole('img');
    // The right-hand end of the axis is the departure being flown into, which
    // on this archive is 194 days after the day we looked.
    fireEvent.pointerMove(chart, { clientX: 744, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('194 days before departure');
  });

  it('names the lead unit in the readout so it cannot be read as a calendar week', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Lead time' }));
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    expect(screen.getByText(/read a lead week/)).toBeInTheDocument();
    expect(screen.getByText(/range and median per lead week/)).toBeInTheDocument();
  });

  it('does not carry the crosshair from one axis to the other', () => {
    // Both of these views are the same component, so React keeps one instance
    // across the switch unless it is told not to — and the index it holds is a
    // position on the axis it was left on. Found in a browser: a crosshair left
    // on the third day of the price history reappeared on the fourth bucket of
    // the lead-time axis, which read 281 days ahead where that axis starts at
    // 284.
    render(<Harness />);
    const history = screen.getByRole('img');
    history.focus();
    fireEvent.keyDown(history, { key: 'ArrowRight' });
    fireEvent.keyDown(history, { key: 'ArrowRight' });
    fireEvent.keyDown(history, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('21/06/2026');

    fireEvent.click(screen.getByRole('button', { name: 'Lead time' }));
    expect(screen.getByRole('status')).toHaveTextContent('');

    const lead = screen.getByRole('img');
    lead.focus();
    fireEvent.keyDown(lead, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('285 days before departure');
  });

  it('says a lead time we have never reached is not observed, rather than pricing it', () => {
    // Our own archive reaches 31 of this axis's 91 lead days, all at the near
    // end. The other 60 are the provider's alone and have to read as ours
    // missing rather than borrow the figure drawn beside them.
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Lead time' }));
    const chart = screen.getByRole('img');
    fireEvent.pointerMove(chart, { clientX: 84, clientY: 100 });

    expect(screen.getByRole('status')).toHaveTextContent('285 days before departure');
    expect(screen.getByRole('status')).toHaveTextContent('nothing of our own observed');
  });
});
