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
      viaPoints: ['BOG'],
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

/**
 * The route these flights fly, which is what turns a row into a link out.
 *
 * Peru, because that is where LIM is and because the storefront is picked off
 * the origin's country. A test that left this null would exercise the table
 * with every link switched off and never notice one going missing.
 */
const LEG = { origin: 'LIM', destination: 'SCL', originCountry: 'Peru' };

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
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

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
    expect(second.getByText('BOG')).toBeInTheDocument();
  });

  it('declares a fixed column for every stable board field', () => {
    const { container } = render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

    const columns = container.querySelectorAll('col');
    expect(columns).toHaveLength(7);
    expect(columns[0]).toHaveClass(/departs/);
    expect(columns[3]).toHaveClass(/stops/);
    expect(columns[5]).toHaveClass(/price/);
  });

  it('says so when the latest observation is empty', () => {
    render(<FlightTable snapshots={[]} granularity="day" departure="09/03/2027" leg={LEG} />);
    expect(screen.getByText(/No itineraries/i)).toBeInTheDocument();
    // A panel whose heading disappears with its data reads as a panel that
    // lost its name, so the heading is outside the early return.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Flights seen');
  });

  it('names the panel and the departure on the filter row, not on a line above it', () => {
    // 12.257. The middot is the separator the watchlist row already uses
    // between a pair and its month, and it is `aria-hidden` because a screen
    // reader announcing "middle dot" between a name and a date is noise.
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

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
    render(<FlightTable snapshots={[SNAPSHOT]} granularity="day" departure={null} leg={LEG} />);
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
        leg={LEG}
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
        leg={LEG}
      />,
    );

    expect(bodyRows()).toHaveLength(1);
    expect(
      screen.getByText(/1 flight seen on 18\/08\/2026, 00:00 to 23:59, of 2 ever observed/),
    ).toBeTruthy();
  });

  it('marks every column as sortable and says which one is in force', async () => {
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

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
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );
    const options = within(screen.getByLabelText('Airline'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    // One word for "no constraint", the same in every select on the row: the
    // label above already says which constraint is being lifted.
    expect(options).toEqual(['Any', 'Avianca', 'LATAM']);
  });

  it('cuts a carrier name too long for the row, and keeps the whole one within reach', async () => {
    /*
     * 12.258. A select is as wide as its widest option, so `Aerolineas
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
    render(<FlightTable snapshots={[long]} granularity="day" departure="09/03/2027" leg={LEG} />);

    const select = screen.getByLabelText('Airline');
    const cut = within(select).getByRole('option', { name: 'Aerolin…' });
    expect(cut).toHaveAttribute('title', 'Aerolineas Argentinas');

    // The narrow table cell keeps the same compact spelling and exposes the
    // full carrier name on hover/focus rather than making a long name decide
    // the entire column's width.
    const row = bodyRows().find((one) => within(one).queryByText('AR 1365'))!;
    expect(within(row).getByText('Aerolin…')).toHaveAttribute('title', 'Aerolineas Argentinas');

    // And the closed control names the carrier in full once one is chosen.
    await userEvent.selectOptions(select, 'AR');
    expect(select).toHaveAttribute('title', 'Aerolineas Argentinas');
  });

  it('says how many rows a filter took away, rather than reporting the rest as the board', async () => {
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

    await userEvent.selectOptions(screen.getByLabelText('Airline'), 'AV');
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText(/1 shown, 1 hidden by filters/)).toBeInTheDocument();
  });

  it('pages ten at a time and reaches the rest with a labelled control', async () => {
    render(
      <FlightTable snapshots={[crowded(12)]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

    expect(bodyRows()).toHaveLength(10);
    expect(pagerText()).toBe('Page 1 of 2');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('goes back to the first page when a filter changes, but not when the sort does', async () => {
    render(
      <FlightTable snapshots={[crowded(12)]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

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
      <FlightTable snapshots={snapshots} granularity="day" departure="09/03/2027" leg={LEG} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(pagerText()).toBe('Page 2 of 2');

    rerender(
      <FlightTable snapshots={snapshots} granularity="month" departure="09/03/2027" leg={LEG} />,
    );
    expect(pagerText()).toBe('Page 1 of 2');
  });

  it('clears every filter at once and says nothing is hidden any more', async () => {
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

    await userEvent.selectOptions(screen.getByLabelText('Airline'), 'AV');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(bodyRows()).toHaveLength(2);
    expect(screen.queryByText(/hidden by filters/)).not.toBeInTheDocument();
  });

  it('asks for a price as one range with two ends, not as two filters', async () => {
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

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
    // 12.254. Two looks at the same price is a fact about the price; one look
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
        leg={LEG}
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
        leg={LEG}
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
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

    await userEvent.type(screen.getByLabelText('Min price'), '999');
    expect(bodyRows()).toHaveLength(0);
    expect(screen.getByText(/hidden by the filters above/i)).toBeInTheDocument();
    expect(screen.getByText(/0 shown, 2 hidden by filters/)).toBeInTheDocument();
  });

  /* --------------------------------------------- the link out to the airline -- */

  it('links a flight to its own airline’s search, on that flight’s departure date', () => {
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

    const link = screen.getByRole('link', {
      name: 'LA 529 — Search LATAM for LIM to SCL on 16/10/2026',
    });
    // The date is the flight's own, off `departureAt` and not off the snapshot,
    // and the storefront is the origin's — LIM is in Peru.
    expect(link).toHaveAttribute(
      'href',
      'https://www.latamairlines.com/pe/es/ofertas-vuelos?origin=LIM&outbound=2026-10-16T00%3A00%3A00.000Z&destination=SCL&adt=1&chd=0&inf=0&trip=OW&cabin=Economy&redemption=false&sort=RECOMMENDED',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('makes the flight number itself the link, and draws no arrow beside it', () => {
    /*
     * The owner's report: the `↗` worked and could not be found. It was
     * `--color-muted` at 0.7rem with `text-decoration: none`, so what replaces
     * it is the one word in the row a reader is already looking at, drawn the
     * way the web draws links.
     */
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

    const row = bodyRows().find((each) => within(each).queryByText('LA 529'))!;
    expect(within(row).getByText('LA 529').tagName).toBe('A');
    // Nothing else in the cell — the arrow is gone rather than moved.
    expect(within(row).getAllByRole('cell')[2].textContent).toBe('LA 529');
    expect(row.textContent).not.toContain('↗');
  });

  it('names the flight in the link and still promises only a search', () => {
    /*
     * The whole scope of the feature, guarded where a reader meets it. The
     * carrier's page is a list of that route's departures on that date, so the
     * name must not read as "book LA 529" — and it does not: the verb is
     * `Search` and its object is a carrier, a city pair and a date.
     *
     * The flight number leads it because the *visible* label is now the flight
     * number, and WCAG 2.5.3 asks that an accessible name contain the words on
     * screen. While the anchor was a bare glyph there were none to contain.
     */
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

    const link = screen.getByRole('link', { name: /LA 529/ });
    expect(link).toHaveAccessibleName('LA 529 — Search LATAM for LIM to SCL on 16/10/2026');
    expect(link).toHaveAccessibleName(expect.not.stringContaining('Book'));
    // And a pointer resting on it is told exactly the same thing.
    expect(link).toHaveAttribute('title', 'LA 529 — Search LATAM for LIM to SCL on 16/10/2026');
  });

  it('gives an Avianca flight no link at all rather than a guessed one', () => {
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={LEG} />,
    );

    const row = bodyRows().find((each) => within(each).queryByText('AV 812'))!;
    expect(within(row).queryByRole('link')).toBeNull();
    // And nothing stands in its place: no marker, no greyed affordance, no
    // tooltip explaining an absence. Plain text, as the number always was.
    expect(within(row).getByText('AV 812').textContent).toBe('AV 812');
    expect(within(row).getByText('AV 812').tagName).not.toBe('A');
  });

  it('draws no links at all while the route or its country is unknown', () => {
    render(
      <FlightTable snapshots={[SNAPSHOT]} granularity="day" departure="09/03/2027" leg={null} />,
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('draws no link where the origin country has no storefront we have loaded', () => {
    render(
      <FlightTable
        snapshots={[SNAPSHOT]}
        granularity="day"
        departure="09/03/2027"
        leg={{ origin: 'LIM', destination: 'SCL', originCountry: 'Brazil' }}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
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
