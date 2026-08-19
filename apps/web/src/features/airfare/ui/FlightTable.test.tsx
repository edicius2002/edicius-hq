import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { FlightTable } from '@/features/airfare/ui/FlightTable';
import { PriceHistoryChart } from '@/features/airfare/ui/PriceHistoryChart';
import type { FareOffer, FareSnapshot } from '@/shared/api/fares';

afterEach(cleanup);

const SNAPSHOT: FareSnapshot = {
  capturedAt: '2026-08-17T12:00:00+00:00',
  source: 'google-flights',
  origin: 'LIM',
  destination: 'SCL',
  flightDate: '2026-10-16',
  returnDate: null,
  insights: null,
  currency: 'USD',
  offers: [
    {
      airline: 'LA',
      airlineName: 'LATAM',
      flightNumber: '529',
      departureAt: '2026-10-16T00:15',
      arrivalAt: '2026-10-16T05:50',
      transfers: 0,
      durationMinutes: 215,
      price: 125,
      currency: 'USD',
    },
    {
      airline: 'AV',
      airlineName: 'Avianca',
      flightNumber: '812',
      departureAt: '2026-10-16T17:35',
      arrivalAt: '2026-10-17T00:40',
      transfers: 1,
      durationMinutes: 425,
      price: 291,
      currency: 'USD',
    },
  ],
};

/** A snapshot of `count` distinct flights, one an hour, cheapest first. */
function crowded(count: number, capturedAt = '2026-08-18T12:00:00+00:00'): FareSnapshot {
  const offers: FareOffer[] = Array.from({ length: count }, (_, index) => ({
    airline: index % 2 === 0 ? 'LA' : 'AV',
    airlineName: index % 2 === 0 ? 'LATAM' : 'Avianca',
    flightNumber: String(500 + index),
    departureAt: `2026-10-16T${String(index % 24).padStart(2, '0')}:10`,
    arrivalAt: null,
    transfers: 0,
    durationMinutes: 200 + index,
    price: 100 + index,
    currency: 'USD',
  }));
  return { ...SNAPSHOT, capturedAt, offers };
}

function bodyRows() {
  return screen.getAllByRole('row').slice(1);
}

/** The page number beside the buttons, not the one in the caption. */
function pagerText(): string {
  const pager = screen.getByRole('navigation', { name: 'Flight table pages' });
  return within(pager).getByText(/^Page /).textContent ?? '';
}

describe('FlightTable', () => {
  it('shows each itinerary with its airline, departure time and stops', () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" />);

    const rows = bodyRows();
    expect(rows).toHaveLength(2);

    const first = within(rows[0]);
    // Rendered as written: a 00:15 Lima departure must not be shifted into the
    // reader's own zone by a `Date` round trip.
    expect(first.getByText('00:15')).toBeInTheDocument();
    expect(first.getByText('LATAM')).toBeInTheDocument();
    expect(first.getByText('LA 529')).toBeInTheDocument();
    expect(first.getByText('Direct')).toBeInTheDocument();
    expect(first.getByText('3h 35m')).toBeInTheDocument();

    const second = within(rows[1]);
    expect(second.getByText('17:35')).toBeInTheDocument();
    expect(second.getByText('1 stop')).toBeInTheDocument();
  });

  it('says so when the latest observation is empty', () => {
    render(<FlightTable snapshots={[]} granularity="day" />);
    expect(screen.getByText(/No itineraries/i)).toBeInTheDocument();
  });

  it('states the stretch of watching the rows come from', () => {
    // The period is an interpretation of the switch above the chart, and an
    // unstated interpretation is one nobody can correct.
    render(
      <FlightTable
        snapshots={[SNAPSHOT, { ...SNAPSHOT, capturedAt: '2026-08-18T12:00:00+00:00' }]}
        granularity="week"
      />,
    );
    expect(
      screen.getByText(/2 flights seen between 17\/08\/2026 00:00 and 23\/08\/2026 23:59/),
    ).toBeInTheDocument();
  });

  it('shows only the flights the newest day saw, and counts the ones it did not', () => {
    render(
      <FlightTable
        snapshots={[
          SNAPSHOT,
          { ...SNAPSHOT, capturedAt: '2026-08-18T12:00:00+00:00', offers: [SNAPSHOT.offers[0]] },
        ]}
        granularity="day"
      />,
    );

    expect(bodyRows()).toHaveLength(1);
    expect(
      screen.getByText(/1 flight seen on 18\/08\/2026, 00:00 to 23:59, of 2 ever observed/),
    ).toBeTruthy();
  });

  it('marks every column as sortable and says which one is in force', async () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" />);

    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((header) => header.getAttribute('aria-sort'))).toEqual([
      'ascending',
      'none',
      'none',
      'none',
      'none',
      'none',
      'none',
    ]);

    await userEvent.click(screen.getByRole('button', { name: /price/i }));
    expect(screen.getByRole('columnheader', { name: /price/i })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    await userEvent.click(screen.getByRole('button', { name: /price/i }));
    expect(screen.getByRole('columnheader', { name: /price/i })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(within(bodyRows()[0]).getByText('$291.00')).toBeInTheDocument();
  });

  it('offers only the airlines that are actually on this board', () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" />);
    const options = within(screen.getByLabelText('Airline'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['All airlines', 'Avianca', 'LATAM']);
  });

  it('says how many rows a filter took away, rather than reporting the rest as the board', async () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" />);

    await userEvent.selectOptions(screen.getByLabelText('Airline'), 'AV');
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText(/1 shown, 1 hidden by filters/)).toBeInTheDocument();
  });

  it('pages ten at a time and reaches the rest with a labelled control', async () => {
    render(<FlightTable snapshots={[crowded(12)]} granularity="day" />);

    expect(bodyRows()).toHaveLength(10);
    expect(pagerText()).toBe('Page 1 of 2');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('goes back to the first page when a filter changes, but not when the sort does', async () => {
    render(<FlightTable snapshots={[crowded(12)]} granularity="day" />);

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(pagerText()).toBe('Page 2 of 2');

    // A sort is a different order of the same rows, so the page still means
    // something; a filter is a different set of rows, and page two of it may
    // not exist.
    await userEvent.click(screen.getByRole('button', { name: /price/i }));
    expect(pagerText()).toBe('Page 2 of 2');

    await userEvent.selectOptions(screen.getByLabelText('Stops'), '0');
    expect(pagerText()).toBe('Page 1 of 2');
  });

  it('goes back to the first page when the period above it changes', async () => {
    // A new period is a different set of flights, so page two of the old one
    // is not a page of this one.
    const snapshots = [crowded(12)];
    const { rerender } = render(<FlightTable snapshots={snapshots} granularity="day" />);
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(pagerText()).toBe('Page 2 of 2');

    rerender(<FlightTable snapshots={snapshots} granularity="month" />);
    expect(pagerText()).toBe('Page 1 of 2');
  });

  it('clears every filter at once and says nothing is hidden any more', async () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" />);

    await userEvent.selectOptions(screen.getByLabelText('Airline'), 'AV');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(bodyRows()).toHaveLength(2);
    expect(screen.queryByText(/hidden by filters/)).not.toBeInTheDocument();
  });

  it('says the filters emptied the table rather than showing a bare header', async () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" />);

    await userEvent.type(screen.getByLabelText('Min price'), '999');
    expect(bodyRows()).toHaveLength(0);
    expect(screen.getByText(/hidden by the filters above/i)).toBeInTheDocument();
    expect(screen.getByText(/0 shown, 2 hidden by filters/)).toBeInTheDocument();
  });
});

describe('PriceHistoryChart', () => {
  const points = [
    { capturedAt: '2026-08-17T12:00:00+00:00', price: 125, currency: 'USD' },
    { capturedAt: '2026-08-18T12:00:00+00:00', price: 139, currency: 'USD' },
  ];

  it('describes the whole series to a screen reader, not just the shape', () => {
    render(<PriceHistoryChart points={points} currency="USD" label="LIM to SCL" />);

    const chart = screen.getByRole('img');
    expect(chart).toHaveAccessibleName(/LIM to SCL/);
    expect(chart).toHaveAccessibleName(/2026-08-17: \$125\.00/);
    expect(chart).toHaveAccessibleName(/2026-08-18: \$139\.00/);
    expect(screen.getByText('2 observations')).toBeInTheDocument();
  });

  it('invites a collection pass instead of drawing an empty box', () => {
    render(<PriceHistoryChart points={[]} currency="USD" label="LIM to SCL" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/No observations yet/i)).toBeInTheDocument();
  });
});
