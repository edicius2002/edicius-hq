import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SORT,
  NO_FILTERS,
  PAGE_SIZE,
  departureHour,
  facetsOf,
  filterRows,
  isFiltered,
  nextSort,
  observationWindow,
  pageOf,
  shortAirline,
  sortRows,
  tableRows,
  tableSummary,
  windowLabel,
  type ChangeCategory,
  type FlightRow,
} from '@/features/airfare/lib/flightTable';
import type { FareOffer, FareSnapshot } from '@/shared/api/fares';

/**
 * The table's arithmetic, without a browser.
 *
 * The rules worth pinning here are the ones a reader would never catch by
 * looking: that the period is the chart's own bucket rather than a rolling
 * seven days, that a fare which never moved is still on this week's board, and
 * that reversing a sort does not promote the rows with nothing to say.
 */

function offer(overrides: Partial<FareOffer> = {}): FareOffer {
  return {
    airline: 'LA',
    airlineName: 'LATAM',
    flightNumber: '529',
    departureAt: '2026-10-16T08:15',
    arrivalAt: '2026-10-16T11:50',
    transfers: 0,
    durationMinutes: 215,
    price: 125,
    currency: 'USD',
    ...overrides,
  };
}

function snapshot(capturedAt: string, offers: FareOffer[]): FareSnapshot {
  return {
    capturedAt,
    source: 'google-flights',
    origin: 'LIM',
    destination: 'SCL',
    flightDate: '2026-10-16',
    returnDate: null,
    currency: 'USD',
    insights: null,
    offers,
  };
}

/** Distinct flights, one per hour of the departure board. */
function board(count: number, from = 0): FareOffer[] {
  return Array.from({ length: count }, (_, index) =>
    offer({
      airline: 'LA',
      flightNumber: String(500 + from + index),
      departureAt: `2026-10-16T${String((from + index) % 24).padStart(2, '0')}:00`,
      price: 100 + index,
    }),
  );
}

/* -------------------------------------------------------------- the period -- */

describe('observationWindow', () => {
  const snapshots = [
    snapshot('2026-08-16T12:00:00+00:00', [offer()]),
    snapshot('2026-08-17T12:00:00+00:00', [offer()]),
    snapshot('2026-08-18T09:00:00+00:00', [offer()]),
    snapshot('2026-08-18T21:00:00+00:00', [offer()]),
  ];

  it('is the newest day the collector actually looked in, not today', () => {
    // "Today" is a fact about the reader's clock; the table can only speak for
    // days the archive has something in.
    expect(observationWindow(snapshots, 'day')).toEqual({
      key: '2026-08-18',
      from: '2026-08-18T00:00',
      to: '2026-08-18T23:59',
    });
  });

  it('runs a week from its Monday to its Sunday, past the last thing seen in it', () => {
    // 2026-08-16 is a Sunday and belongs to the week before 2026-W34, so the
    // window opens on Monday the 17th. It closes on Sunday the 23rd even though
    // nothing was observed after the 18th: the rows underneath are everything
    // the whole week saw, and a window that stopped at the last observation
    // would describe a narrower set than the one being counted.
    expect(observationWindow(snapshots, 'week')).toEqual({
      key: '2026-W34',
      from: '2026-08-17T00:00',
      to: '2026-08-23T23:59',
    });
  });

  it('takes a month as the whole calendar month, first day to last', () => {
    expect(observationWindow(snapshots, 'month')).toEqual({
      key: '2026-08',
      from: '2026-08-01T00:00',
      to: '2026-08-31T23:59',
    });
  });

  it('has nothing to say about a route nobody has looked at', () => {
    expect(observationWindow([], 'day')).toBeNull();
  });
});

describe('windowLabel', () => {
  it('writes one day as a day and a stretch as a stretch, both with their clocks', () => {
    expect(
      windowLabel({ key: '2026-08-18', from: '2026-08-18T00:00', to: '2026-08-18T23:59' }),
    ).toBe('on 18/08/2026, 00:00 to 23:59');
    expect(windowLabel({ key: '2026-W34', from: '2026-08-17T00:00', to: '2026-08-23T23:59' })).toBe(
      'between 17/08/2026 00:00 and 23/08/2026 23:59',
    );
  });
});

describe('departureHour', () => {
  it('reads the hour off the stamp rather than through a Date', () => {
    expect(departureHour('2026-10-16T00:15')).toBe(0);
    expect(departureHour('2026-10-16T23:59')).toBe(23);
  });

  it('answers nothing when the stamp carries no clock at all', () => {
    // `Number('')` is zero, and a zero here would file an unknown departure
    // under "night" and let the band filter claim it knew.
    expect(departureHour('2026-10-16')).toBeNull();
  });
});

/* ---------------------------------------------------------------- the rows -- */

const MORNING = offer({ airline: 'LA', flightNumber: '529', departureAt: '2026-10-16T08:15' });
const EVENING = offer({
  airline: 'AV',
  airlineName: 'Avianca',
  flightNumber: '812',
  departureAt: '2026-10-16T19:35',
  transfers: 1,
  durationMinutes: 425,
  price: 291,
});

describe('tableRows', () => {
  it('lists only the flights the newest day of watching actually saw', () => {
    const { rows, tracked } = tableRows(
      [
        snapshot('2026-08-17T12:00:00+00:00', [MORNING, EVENING]),
        snapshot('2026-08-18T12:00:00+00:00', [MORNING]),
      ],
      'day',
    );

    expect(rows.map((row) => row.track.flightNumber)).toEqual(['529']);
    // The one it dropped is still counted, so the caption can say so.
    expect(tracked).toBe(2);
  });

  it('will not call a flight it has seen once a flight whose price did not move', () => {
    /*
     * The regression 12.254 exists for, and it needs a poll that spans more
     * than one departure to show itself: a watched month is collected one day
     * at a time, so the newest `capturedAt` on the route belongs to whichever
     * departure the pass happened to reach last. The old rule asked whether a
     * flight's first observation carried that stamp, which made "we have only
     * looked at this once" true for the last departure polled and false for
     * every other one — on the real ARI-SCL archive, 101 of 103 flights seen
     * exactly once were reported as "Unchanged".
     */
    const early = { ...snapshot('2026-08-19T14:41:41+00:00', [MORNING]), flightDate: '2027-03-01' };
    const late = { ...snapshot('2026-08-19T14:45:01+00:00', [EVENING]), flightDate: '2027-03-02' };

    const { rows } = tableRows([early, late], 'day');

    expect(rows.map((row) => row.category)).toEqual(['first', 'first']);
    expect(rows.every((row) => row.change === null)).toBe(true);
  });

  it('keeps a fare that has sat unmoved all week on the newest day of the board', () => {
    /*
     * The regression this exists for: `trackFlights` records a price only when
     * it differs from the one before, so a flight seen daily at $125 has its
     * last observation stamped on the first of those days. Deciding membership
     * from a track's observations would drop it from every later period, and
     * the board would look as though it had lost a flight nobody removed.
     */
    const { rows } = tableRows(
      [
        snapshot('2026-08-16T12:00:00+00:00', [MORNING]),
        snapshot('2026-08-17T12:00:00+00:00', [MORNING]),
        snapshot('2026-08-18T12:00:00+00:00', [MORNING]),
      ],
      'day',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].track.observations).toHaveLength(1);
    expect(rows[0].category).toBe('unchanged');
    // Three looks at $125 is a measurement, so it prints as one rather than as
    // the dash a flight nobody has compared gets.
    expect(rows[0].change).toBe(0);
  });

  it('measures the change against the whole archive, not against the period', () => {
    /*
     * A day usually holds one or two collections. Rebuilding the tracks from
     * the day's snapshots alone would report a fare that fell 20% over the
     * week as having never moved, which is the opposite of what the column is
     * for.
     */
    const { rows } = tableRows(
      [
        snapshot('2026-08-17T12:00:00+00:00', [MORNING]),
        snapshot('2026-08-18T12:00:00+00:00', [offer({ ...MORNING, price: 100 })]),
      ],
      'day',
    );

    expect(rows[0].change).toBeCloseTo(-20, 5);
    expect(rows[0].category).toBe('fell');
  });

  it('tells a flight nobody has seen before from one that simply never moved', () => {
    const { rows } = tableRows(
      [
        snapshot('2026-08-17T12:00:00+00:00', [MORNING]),
        snapshot('2026-08-18T12:00:00+00:00', [MORNING, EVENING]),
      ],
      'day',
    );

    const categories = Object.fromEntries(rows.map((row) => [row.track.airline, row.category]));
    expect(categories).toEqual({ LA: 'unchanged', AV: 'first' });
  });

  it('keeps a flight that has left the board, and says that is what happened', () => {
    const { rows } = tableRows(
      [
        snapshot('2026-08-18T09:00:00+00:00', [MORNING, EVENING]),
        snapshot('2026-08-18T21:00:00+00:00', [MORNING]),
      ],
      'day',
    );

    const gone = rows.find((row) => row.track.airline === 'AV');
    expect(gone?.category).toBe('gone');
    expect(gone?.track.present).toBe(false);
    // No percentage for a flight that is not on offer: the column asks what a
    // fare has done since the last look, and this one is not there to have
    // done anything.
    expect(gone?.change).toBeNull();
  });
});

/* -------------------------------------------------------------- the facets -- */

function rowsFor(offers: FareOffer[]): FlightRow[] {
  return tableRows([snapshot('2026-08-18T12:00:00+00:00', offers)], 'day').rows;
}

describe('facetsOf', () => {
  it('offers the airlines on this board and no others', () => {
    const facets = facetsOf(rowsFor([MORNING, EVENING]));
    expect(facets.airlines).toEqual([
      { value: 'AV', label: 'Avianca' },
      { value: 'LA', label: 'LATAM' },
    ]);
  });

  it('offers the prices, stops and durations the table really holds', () => {
    const facets = facetsOf(rowsFor([MORNING, EVENING]));
    expect(facets.price).toEqual({ low: 125, high: 291 });
    expect(facets.stops).toEqual([0, 1]);
    expect(facets.durations).toEqual([215, 425]);
  });

  it('offers only the times of day something leaves at', () => {
    // A board with a morning and an evening departure must not offer to filter
    // for the red-eye it does not have.
    expect(facetsOf(rowsFor([MORNING, EVENING])).bands).toEqual(['morning', 'evening']);
  });

  it('has nothing to offer for an empty board', () => {
    const facets = facetsOf([]);
    expect(facets.price).toBeNull();
    expect(facets.airlines).toEqual([]);
    expect(facets.categories).toEqual([]);
  });
});

/* ------------------------------------------------------------- the filters -- */

describe('filterRows', () => {
  const rows = rowsFor([MORNING, EVENING]);

  it('takes a price range inclusively at both ends', () => {
    expect(filterRows(rows, { ...NO_FILTERS, minPrice: 125, maxPrice: 125 })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, maxPrice: 124 })).toHaveLength(0);
    expect(filterRows(rows, { ...NO_FILTERS, maxPrice: 291 })).toHaveLength(2);
  });

  it('filters by the carrier code, which outlives the printed name', () => {
    const kept = filterRows(rows, { ...NO_FILTERS, airline: 'AV' });
    expect(kept.map((row) => row.track.flightNumber)).toEqual(['812']);
  });

  it('keeps the flights that leave in the band that was asked for', () => {
    expect(filterRows(rows, { ...NO_FILTERS, band: 'morning' })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, band: 'night' })).toHaveLength(0);
  });

  it('counts stops and lengths as the board reports them', () => {
    expect(filterRows(rows, { ...NO_FILTERS, stops: 0 })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, maxDuration: 215 })).toHaveLength(1);
  });

  it('drops a flight whose length is unknown rather than letting it pass', () => {
    // "Under four hours" is a claim, and a flight with no duration cannot
    // support it. Dropped here, counted in the caption above the table.
    const unknown = rowsFor([offer({ flightNumber: '900', durationMinutes: null })]);
    expect(filterRows(unknown, { ...NO_FILTERS, maxDuration: 600 })).toHaveLength(0);
    expect(filterRows(unknown, NO_FILTERS)).toHaveLength(1);
  });

  it('filters by what a flight did, in words', () => {
    expect(filterRows(rows, { ...NO_FILTERS, change: 'first' })).toHaveLength(2);
    expect(filterRows(rows, { ...NO_FILTERS, change: 'rose' })).toHaveLength(0);
  });

  it('selects exactly the rows whose Change cell shows what the filter says', () => {
    /*
     * The filter and the column have to be the same claim, or one of them is
     * lying. Four flights, one of each thing that can happen, and every
     * category picks out its own row and no other.
     */
    const held = offer({ flightNumber: '600', departureAt: '2026-10-16T06:00', price: 200 });
    const left = offer({ flightNumber: '700', departureAt: '2026-10-16T07:00', price: 300 });
    const mixed = tableRows(
      [
        snapshot('2026-08-18T09:00:00+00:00', [MORNING, held, left]),
        snapshot('2026-08-18T21:00:00+00:00', [offer({ ...MORNING, price: 150 }), held, EVENING]),
      ],
      'day',
    ).rows;

    const picked = (change: ChangeCategory) =>
      filterRows(mixed, { ...NO_FILTERS, change }).map((row) => row.track.flightNumber);
    expect(picked('rose')).toEqual(['529']);
    expect(picked('unchanged')).toEqual(['600']);
    expect(picked('first')).toEqual(['812']);
    expect(picked('gone')).toEqual(['700']);
    expect(picked('fell')).toEqual([]);
    expect(mixed).toHaveLength(4);
  });
});

describe('shortAirline', () => {
  it('leaves every carrier this archive holds alone but the one that will not fit', () => {
    // 12.258. Eight characters is `JetSMART` exactly, and LATAM, Avianca and
    // JetSMART carry 1256 of the archive's 1275 offers between them.
    expect(shortAirline('LATAM')).toBe('LATAM');
    expect(shortAirline('Avianca')).toBe('Avianca');
    expect(shortAirline('JetSMART')).toBe('JetSMART');
    expect(shortAirline('Aerolineas Argentinas')).toBe('Aerolin…');
  });

  it('says it has cut a name rather than cutting it silently', () => {
    // A `max-width` on the select clips the glyphs and says nothing, which
    // leaves a shortened name looking like the carrier's actual name. The cut
    // is one character and the mark for it is the other.
    const cut = shortAirline('Aerolineas Argentinas');
    expect(cut).toHaveLength(8);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('does not leave a space stranded in front of the ellipsis', () => {
    expect(shortAirline('Air Canada')).toBe('Air Can…');
    expect(shortAirline('Sky Airline')).toBe('Sky Air…');
    expect(shortAirline('Air Europa', 5)).toBe('Air…');
  });
});

describe('isFiltered', () => {
  it('knows the difference between an untouched bar and a cleared one', () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, stops: 0 })).toBe(true);
  });
});

/* ------------------------------------------------------------- the sorting -- */

describe('nextSort', () => {
  it('starts a fresh column ascending and turns the one already in force', () => {
    expect(nextSort(DEFAULT_SORT, 'price')).toEqual({ column: 'price', direction: 'asc' });
    expect(nextSort({ column: 'price', direction: 'asc' }, 'price')).toEqual({
      column: 'price',
      direction: 'desc',
    });
  });
});

describe('sortRows', () => {
  // Three flights that differ in every sortable column, so a reversal can be
  // checked as a reversal rather than as "the tiebreak held".
  const DAWN = offer({
    airline: 'JA',
    airlineName: 'JetSMART',
    flightNumber: '77',
    departureAt: '2026-10-16T05:30',
    transfers: 2,
    durationMinutes: 300,
    price: 60,
  });
  const rows = rowsFor([MORNING, EVENING, DAWN]);

  it('sorts every column both ways', () => {
    const columns = ['departs', 'airline', 'flight', 'stops', 'duration', 'price'] as const;
    for (const column of columns) {
      const up = sortRows(rows, { column, direction: 'asc' }).map((row) => row.track.key);
      const down = sortRows(rows, { column, direction: 'desc' }).map((row) => row.track.key);
      expect(up).toHaveLength(rows.length);
      expect(down).toEqual([...up].reverse());
    }
  });

  it('puts the rows with nothing to say last, whichever way the column points', () => {
    /*
     * Three rows that have been measured — one that rose, one that held at
     * zero — and one nobody has compared at all. Descending must not float the
     * em dash to the top and call it the biggest mover; only the row with no
     * number goes to the bottom, and it goes there both ways.
     */
    const mixed = tableRows(
      [
        snapshot('2026-08-17T12:00:00+00:00', [MORNING, EVENING]),
        snapshot('2026-08-18T12:00:00+00:00', [
          offer({ ...MORNING, price: 150 }),
          EVENING,
          offer({ flightNumber: '77', price: 60 }),
        ]),
      ],
      'day',
    ).rows;

    for (const direction of ['asc', 'desc'] as const) {
      const sorted = sortRows(mixed, { column: 'change', direction });
      expect(sorted.slice(0, 2).every((row) => row.change !== null)).toBe(true);
      expect(sorted.at(-1)?.change).toBeNull();
      expect(sorted.at(-1)?.category).toBe('first');
    }
  });

  it('does the same with a duration nobody reported', () => {
    const mixed = rowsFor([MORNING, offer({ flightNumber: '900', durationMinutes: null })]);
    for (const direction of ['asc', 'desc'] as const) {
      const sorted = sortRows(mixed, { column: 'duration', direction });
      expect(sorted[1].track.durationMinutes).toBeNull();
    }
  });

  it('breaks a tie the same way every time, so rows do not shuffle', () => {
    const tied = rowsFor([
      offer({ flightNumber: '100', departureAt: '2026-10-16T06:00', price: 90 }),
      offer({ flightNumber: '200', departureAt: '2026-10-16T05:00', price: 90 }),
    ]);
    const once = sortRows(tied, { column: 'price', direction: 'asc' });
    const twice = sortRows(tied, { column: 'price', direction: 'desc' });
    expect(once.map((row) => row.track.flightNumber)).toEqual(['200', '100']);
    expect(twice.map((row) => row.track.flightNumber)).toEqual(['200', '100']);
  });

  it('leaves the rows it was given alone', () => {
    const before = rows.map((row) => row.track.key);
    sortRows(rows, { column: 'price', direction: 'desc' });
    expect(rows.map((row) => row.track.key)).toEqual(before);
  });
});

/* ---------------------------------------------------------- the pagination -- */

describe('pageOf', () => {
  const rows = rowsFor(board(23));

  it('cuts the table into pages of ten', () => {
    expect(PAGE_SIZE).toBe(10);
    expect(pageOf(rows, 1).rows).toHaveLength(10);
    expect(pageOf(rows, 3).rows).toHaveLength(3);
    expect(pageOf(rows, 1).pageCount).toBe(3);
  });

  it('clamps a page number that no longer has anything behind it', () => {
    // A filter applied on page four leaves a number pointing past the end, and
    // an empty table with a working "previous" button is the worse answer.
    expect(pageOf(rows, 9).page).toBe(3);
    expect(pageOf(rows, 0).page).toBe(1);
    expect(pageOf(rows, -2).page).toBe(1);
  });

  it('reports one page for an empty table rather than none', () => {
    expect(pageOf([], 1)).toEqual({ page: 1, pageCount: 1, rows: [] });
  });
});

/* ---------------------------------------------------------- what is hidden -- */

describe('tableSummary', () => {
  const period = { key: '2026-W34', from: '2026-08-17T00:00', to: '2026-08-23T23:59' };

  it('states the period, and how much of the archive it leaves out', () => {
    expect(tableSummary({ period, inPeriod: 13, shown: 13, tracked: 41 })).toBe(
      '13 flights seen between 17/08/2026 00:00 and 23/08/2026 23:59, of 41 ever observed on this route.',
    );
  });

  it('says what the filters took, because a filtered count reads as the board', () => {
    expect(tableSummary({ period, inPeriod: 13, shown: 3, tracked: 13 })).toBe(
      '13 flights seen between 17/08/2026 00:00 and 23/08/2026 23:59. 3 shown, 10 hidden by filters.',
    );
  });

  it('says nothing about an archive it is already showing all of', () => {
    expect(tableSummary({ period, inPeriod: 1, shown: 1, tracked: 1 })).toBe(
      '1 flight seen between 17/08/2026 00:00 and 23/08/2026 23:59.',
    );
  });

  it('leaves the page number to the pager, which has always printed one too', () => {
    // 12.253: the caption said `Page 1 of 2` and so did the control beside the
    // next-page button, three lines apart. One page number, in the place a
    // reader who wants a different page is already looking.
    expect(tableSummary({ period, inPeriod: 13, shown: 13, tracked: 13 })).not.toMatch(/Page/);
  });
});
