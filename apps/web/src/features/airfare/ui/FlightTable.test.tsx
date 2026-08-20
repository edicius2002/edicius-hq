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
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" />);

    const rows = bodyRows();
    expect(rows).toHaveLength(2);

    const first = within(rows[0]);
    // The day as well as the clock, since 12.110 puts a month of departures in
    // this table at once and `00:15` alone no longer names a flight. Rendered
    // as written: a 00:15 Lima departure must not be shifted into the reader's
    // own zone by a `Date` round trip.
    expect(first.getByText('16/10/2026 00:15')).toBeInTheDocument();
    expect(first.getByText('LATAM')).toBeInTheDocument();
    expect(first.getByText('LA 529')).toBeInTheDocument();
    expect(first.getByText('Direct')).toBeInTheDocument();
    expect(first.getByText('3h 35m')).toBeInTheDocument();

    const second = within(rows[1]);
    expect(second.getByText('16/10/2026 17:35')).toBeInTheDocument();
    expect(second.getByText('1 stop')).toBeInTheDocument();
  });

  it('says so when the latest observation is empty', () => {
    render(<FlightTable snapshots={[]} granularity="day" departure="09/03/2027" />);
    expect(screen.getByText(/No itineraries/i)).toBeInTheDocument();
    // A panel whose heading disappears with its data reads as a panel that
    // lost its name, so the heading is outside the early return.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Flights seen');
  });

  it('names the panel and the departure on the filter row, not on a line above it', () => {
    // 12.255. The middot is the separator the watchlist row already uses
    // between a pair and its month, and it is `aria-hidden` because a screen
    // reader announcing "middle dot" between a name and a date is noise.
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" />);

    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveAccessibleName('Flights seen 09/03/2027');
    expect(heading.textContent).toBe('Flights seen·09/03/2027');

    // Heading and controls are siblings on one row: the group a screen reader
    // hears as "Filter flights" must not claim the heading as one of its
    // controls.
    const filters = screen.getByRole('group', { name: 'Filter flights' });
    expect(filters).not.toContainElement(heading);
    expect(heading.parentElement).toBe(filters.parentElement);
  });

  it('says only what it knows when no route is selected', () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" departure={null} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Flights seen');
  });

  it('states the stretch of watching the rows come from', () => {
    // The period is an interpretation of the switch above the chart, and an
    // unstated interpretation is one nobody can correct.
    render(
      <FlightTable
        snapshots={[SNAPSHOT, { ...SNAPSHOT, capturedAt: '2026-08-18T12:00:00+00:00' }]}
        granularity="week"
        departure="09/03/2027"
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
        departure="09/03/2027"
      />,
    );

    expect(bodyRows()).toHaveLength(1);
    expect(
      screen.getByText(/1 flight seen on 18\/08\/2026, 00:00 to 23:59, of 2 ever observed/),
    ).toBeTruthy();
  });

  it('marks every column as sortable and says which one is in force', async () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" />);

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
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" />);
    const options = within(screen.getByLabelText('Airline'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    // One word for "no constraint", the same in every select on the row: the
    // label above already says which constraint is being lifted.
    expect(options).toEqual(['Any', 'Avianca', 'LATAM']);
  });

  it('cuts a carrier name too long for the row, and keeps the whole one within reach', async () => {
    /*
     * 12.256. A select is as wide as its widest option, so `Aerolineas
     * Argentinas` — 19 of the archive's 1275 offers — was setting 251px of a
     * row with 1099 to spend. The cut is marked, because a silently clipped
     * name is one the reader has no reason to doubt, and the whole name is
     * still on the option and in the row the flight is on.
     */
    const long = {
      ...SNAPSHOT,
      offers: [
        SNAPSHOT.offers[0],
        {
          ...SNAPSHOT.offers[1],
          airline: 'AR',
          airlineName: 'Aerolineas Argentinas',
          flightNumber: '1365',
        },
      ],
    };
    render(<FlightTable snapshots={[long]} granularity="day" departure="09/03/2027" />);

    const select = screen.getByLabelText('Airline');
    const cut = within(select).getByRole('option', { name: 'Aerolin…' });
    expect(cut).toHaveAttribute('title', 'Aerolineas Argentinas');

    // The table beneath still writes it out in full.
    const row = bodyRows().find((one) => within(one).queryByText('AR 1365'))!;
    expect(within(row).getByText('Aerolineas Argentinas')).toBeInTheDocument();

    // And the closed control names the carrier in full once one is chosen.
    await userEvent.selectOptions(select, 'AR');
    expect(select).toHaveAttribute('title', 'Aerolineas Argentinas');
  });

  it('says how many rows a filter took away, rather than reporting the rest as the board', async () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" />);

    await userEvent.selectOptions(screen.getByLabelText('Airline'), 'AV');
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText(/1 shown, 1 hidden by filters/)).toBeInTheDocument();
  });

  it('pages ten at a time and reaches the rest with a labelled control', async () => {
    render(<FlightTable snapshots={[crowded(12)]} granularity="day" departure="09/03/2027" />);

    expect(bodyRows()).toHaveLength(10);
    expect(pagerText()).toBe('Page 1 of 2');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('goes back to the first page when a filter changes, but not when the sort does', async () => {
    render(<FlightTable snapshots={[crowded(12)]} granularity="day" departure="09/03/2027" />);

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
    const { rerender } = render(
      <FlightTable snapshots={snapshots} granularity="day" departure="09/03/2027" />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(pagerText()).toBe('Page 2 of 2');

    rerender(<FlightTable snapshots={snapshots} granularity="month" departure="09/03/2027" />);
    expect(pagerText()).toBe('Page 1 of 2');
  });

  it('clears every filter at once and says nothing is hidden any more', async () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" />);

    await userEvent.selectOptions(screen.getByLabelText('Airline'), 'AV');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(bodyRows()).toHaveLength(2);
    expect(screen.queryByText(/hidden by filters/)).not.toBeInTheDocument();
  });

  it('asks for a price as one range with two ends, not as two filters', async () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" />);

    // One group, named once, holding both ends — and each end still answers to
    // its own name, so nothing that reads the page loses track of which is
    // which.
    const range = screen.getByRole('group', { name: 'Price' });
    expect(within(range).getByLabelText('Min price')).toBeInTheDocument();
    expect(within(range).getByLabelText('Max price')).toBeInTheDocument();

    // The two ends of the board are the two placeholders, which is where the
    // sentence that used to say "the board runs $125.00 to $291.00" went.
    expect(within(range).getByLabelText('Min price')).toHaveAttribute('placeholder', '125');
    expect(within(range).getByLabelText('Max price')).toHaveAttribute('placeholder', '291');
    expect(screen.queryByText(/The board runs/)).not.toBeInTheDocument();

    await userEvent.type(within(range).getByLabelText('Min price'), '200');
    expect(bodyRows()).toHaveLength(1);
  });

  it('prints a measured nought for a fare that held, and a dash for one nobody has compared', () => {
    // 12.252. Two looks at the same price is a fact about the price; one look
    // is a fact about how often we have looked, and the column must not read
    // the second as the first.
    render(
      <FlightTable
        snapshots={[
          SNAPSHOT,
          {
            ...SNAPSHOT,
            capturedAt: '2026-08-18T12:00:00+00:00',
            offers: [SNAPSHOT.offers[0], { ...SNAPSHOT.offers[1], flightNumber: '999' }],
          },
        ]}
        granularity="day"
        departure="09/03/2027"
      />,
    );

    const held = bodyRows().find((row) => within(row).queryByText('LA 529'))!;
    expect(within(held).getByText('0.0%')).toBeInTheDocument();

    const once = bodyRows().find((row) => within(row).queryByText('AV 999'))!;
    expect(within(once).getByText('—')).toBeInTheDocument();
  });

  it('says a flight has gone in the change column rather than leaving it blank', async () => {
    render(
      <FlightTable
        snapshots={[
          SNAPSHOT,
          {
            ...SNAPSHOT,
            capturedAt: '2026-08-17T21:00:00+00:00',
            offers: [SNAPSHOT.offers[0]],
          },
        ]}
        granularity="day"
        departure="09/03/2027"
      />,
    );

    const left = bodyRows().find((row) => within(row).queryByText('AV 812'))!;
    expect(within(left).getByText('Gone')).toBeInTheDocument();

    // And the filter keeps exactly the row the column labelled.
    await userEvent.selectOptions(screen.getByLabelText('Change'), 'gone');
    expect(bodyRows()).toHaveLength(1);
    expect(within(bodyRows()[0]).getByText('AV 812')).toBeInTheDocument();
  });

  it('says the filters emptied the table rather than showing a bare header', async () => {
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" />);

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
