import { describe, expect, it } from 'vitest';

import {
  byAirline,
  cheapestDeparture,
  cheapestOffer,
  cheapestSeries,
  daysBeforeDeparture,
  departureClock,
  departureDay,
  formatDuration,
  formatStamp,
  latestPerDeparture,
  median,
  priceStats,
  snapshotsFor,
} from '@/features/airfare/lib/series';
import type { FareOffer, FareSnapshot } from '@/shared/api/fares';

function offer(price: number, over: Partial<FareOffer> = {}): FareOffer {
  return {
    airline: 'LA',
    airlineName: 'LATAM',
    flightNumber: '529',
    departureAt: '2026-10-16T00:15',
    arrivalAt: '2026-10-16T05:50',
    transfers: 0,
    durationMinutes: 215,
    price,
    currency: 'USD',
    ...over,
  };
}

function snapshot(
  capturedAt: string,
  prices: number[],
  over: Partial<FareSnapshot> = {},
): FareSnapshot {
  return {
    capturedAt,
    source: 'google-flights',
    origin: 'LIM',
    destination: 'SCL',
    flightDate: '2026-10-16',
    returnDate: null,
    insights: null,
    currency: 'USD',
    offers: prices.map((price) => offer(price)),
    ...over,
  };
}

describe('snapshotsFor', () => {
  it('separates two watched months that share one archive file', () => {
    const all = [
      snapshot('2026-08-17T12:00:00+00:00', [125]),
      snapshot('2026-08-17T12:00:00+00:00', [640], { flightDate: '2026-12-20' }),
    ];
    // Shown together, the step between an October fare and a December one
    // would read as a price movement.
    expect(snapshotsFor(all, '2026-10')).toHaveLength(1);
    expect(snapshotsFor(all, '2026-12')[0].offers[0].price).toBe(640);
  });

  it('keeps every departure inside the month, which is what the watch now is', () => {
    const all = [
      snapshot('2026-08-17T12:00:00+00:00', [125], { flightDate: '2026-10-16' }),
      snapshot('2026-08-17T12:00:00+00:00', [190], { flightDate: '2026-10-17' }),
      snapshot('2026-08-17T12:00:00+00:00', [640], { flightDate: '2026-11-01' }),
    ];
    expect(snapshotsFor(all, '2026-10')).toHaveLength(2);
  });

  it('narrows onto one departure when handed a focused day instead of a month', () => {
    /*
     * The whole of what a focus date does to the read side — 12.131. It is the
     * same filter and the same call; only the prefix is a character longer,
     * because `2026-10-17` starts with `2026-10` the way the calendar says it
     * should. Everything downstream — the detail panel's board, the chart, the
     * flight table — follows without knowing a focus exists.
     */
    const all = [
      snapshot('2026-08-17T12:00:00+00:00', [125], { flightDate: '2026-10-16' }),
      snapshot('2026-08-17T12:00:00+00:00', [190], { flightDate: '2026-10-17' }),
      snapshot('2026-08-17T12:00:00+00:00', [640], { flightDate: '2026-11-01' }),
    ];
    const focused = snapshotsFor(all, '2026-10-17');
    expect(focused).toHaveLength(1);
    expect(focused[0].offers[0].price).toBe(190);
  });
});

describe('latestPerDeparture', () => {
  it('takes the newest look at each day rather than the newest look overall', () => {
    /*
     * A month is polled one departure at a time, so the newest snapshot in the
     * file belongs to whichever day the pass reached last — a fact about the
     * pacing, not about the fares.
     */
    const latest = latestPerDeparture([
      snapshot('2026-08-17T12:00:00+00:00', [125], { flightDate: '2026-10-16' }),
      snapshot('2026-08-19T12:00:00+00:00', [140], { flightDate: '2026-10-16' }),
      snapshot('2026-08-18T12:00:00+00:00', [190], { flightDate: '2026-10-17' }),
    ]);
    expect(latest.map((one) => [one.flightDate, one.offers[0].price])).toEqual([
      ['2026-10-16', 140],
      ['2026-10-17', 190],
    ]);
  });
});

describe('cheapestDeparture', () => {
  it('finds the day of the month the fare is lowest on, as it was last seen', () => {
    const best = cheapestDeparture([
      snapshot('2026-08-17T12:00:00+00:00', [125], { flightDate: '2026-10-16' }),
      // The 16th went up after that first look, so the 17th is now the cheap
      // day — reading only the first observation would name the wrong one.
      snapshot('2026-08-19T12:00:00+00:00', [260], { flightDate: '2026-10-16' }),
      snapshot('2026-08-19T12:00:00+00:00', [190], { flightDate: '2026-10-17' }),
    ]);
    expect(best?.flightDate).toBe('2026-10-17');
  });

  it('will not name a day with no flights on it as the cheapest', () => {
    // An empty board is not a bargain, and a cheapest of nothing rendered as
    // zero would be the best fare ever found.
    const best = cheapestDeparture([
      snapshot('2026-08-19T12:00:00+00:00', [], { flightDate: '2026-10-16' }),
      snapshot('2026-08-19T12:00:00+00:00', [190], { flightDate: '2026-10-17' }),
    ]);
    expect(best?.flightDate).toBe('2026-10-17');
    expect(cheapestDeparture([])).toBeNull();
  });
});

describe('cheapestSeries', () => {
  it('takes one point per observation and sorts by when it was observed', () => {
    const points = cheapestSeries([
      snapshot('2026-08-19T12:00:00+00:00', [180, 150]),
      snapshot('2026-08-17T12:00:00+00:00', [125, 200]),
    ]);
    expect(points.map((point) => point.price)).toEqual([125, 150]);
  });

  it('skips an observation with no offers instead of charting a zero', () => {
    // Zero is a price, and a chart would draw it as the best deal ever found.
    const points = cheapestSeries([
      snapshot('2026-08-17T12:00:00+00:00', [125]),
      snapshot('2026-08-18T12:00:00+00:00', []),
    ]);
    expect(points).toHaveLength(1);
  });
});

describe('priceStats', () => {
  it('summarises a series against its own median', () => {
    const points = cheapestSeries([
      snapshot('2026-08-17T12:00:00+00:00', [100]),
      snapshot('2026-08-18T12:00:00+00:00', [200]),
      snapshot('2026-08-19T12:00:00+00:00', [150]),
    ]);
    const stats = priceStats(points);
    expect(stats).toMatchObject({
      latest: 150,
      lowest: 100,
      highest: 200,
      median: 150,
      deltaVsMedian: 0,
      observations: 3,
    });
  });

  it('withholds the median comparison until there is something to compare with', () => {
    // One observation is its own median, so the delta would read a confident
    // zero from a single data point.
    const points = cheapestSeries([snapshot('2026-08-17T12:00:00+00:00', [125])]);
    expect(priceStats(points)?.deltaVsMedian).toBeNull();
  });

  it('is null for an empty series', () => {
    expect(priceStats([])).toBeNull();
  });
});

describe('median', () => {
  it('averages the middle pair on an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBe(0);
  });
});

describe('byAirline', () => {
  it('groups a snapshot by carrier, cheapest carrier first', () => {
    const grouped = byAirline(
      snapshot('2026-08-17T12:00:00+00:00', [], {
        offers: [
          offer(300, { airline: 'AV', airlineName: 'Avianca' }),
          offer(125),
          offer(140),
          offer(280, { airline: 'AV', airlineName: 'Avianca' }),
        ],
      }),
    );
    expect(grouped).toEqual([
      { airline: 'LA', airlineName: 'LATAM', cheapest: 125, offers: 2 },
      { airline: 'AV', airlineName: 'Avianca', cheapest: 280, offers: 2 },
    ]);
  });

  it('is empty for no snapshot', () => {
    expect(byAirline(null)).toEqual([]);
  });
});

describe('cheapestOffer', () => {
  it('picks the lowest price on a board and nothing at all off an empty one', () => {
    expect(cheapestOffer(snapshot('2026-08-17T12:00:00+00:00', [200, 125, 180]))?.price).toBe(125);
    expect(cheapestOffer(snapshot('2026-08-17T12:00:00+00:00', []))).toBeNull();
  });
});

describe('departureClock', () => {
  it('reads the wall clock as written, whatever zone the reader is in', () => {
    // `departureAt` carries no offset. Going through `Date` here would move a
    // 00:15 Lima departure by the reader's own distance from Lima.
    expect(departureClock('2026-10-16T00:15')).toBe('00:15');
    expect(departureClock('2026-10-16T23:05')).toBe('23:05');
    expect(departureDay('2026-10-16T00:15')).toBe('2026-10-16');
    expect(departureClock('nonsense')).toBe('');
  });
});

describe('formatDuration', () => {
  it('writes minutes the way a flight is described', () => {
    expect(formatDuration(215)).toBe('3h 35m');
    expect(formatDuration(120)).toBe('2h');
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('—');
  });
});

describe('daysBeforeDeparture', () => {
  it('counts whole days from the observation to the flight', () => {
    expect(daysBeforeDeparture('2026-08-17T12:00:00+00:00', '2026-10-16')).toBe(60);
    expect(daysBeforeDeparture('2026-10-16T06:00:00+00:00', '2026-10-16')).toBe(0);
    expect(daysBeforeDeparture('nope', '2026-10-16')).toBeNull();
  });
});

describe('formatStamp', () => {
  it('writes an observation the way this reader writes a date', () => {
    // The same view was showing `17/10/2026` beside `2026-08-18 19:45`, which
    // is two conventions for the same kind of thing.
    expect(formatStamp('2026-08-18T19:45:03')).toBe('18/08/2026 19:45');
  });

  it('does not shift the clock into the reader’s own zone', () => {
    /*
     * A string split, not a `Date`. These stamps are wall clock; parsing
     * `2026-01-01T00:15` and rendering it in Lima would move it to the 31st of
     * December at 19:15.
     */
    expect(formatStamp('2026-01-01T00:15:00')).toBe('01/01/2026 00:15');
    expect(formatStamp('2026-12-31T23:50:00')).toBe('31/12/2026 23:50');
  });

  it('copes with a bare date, and with a stamp carrying an offset', () => {
    expect(formatStamp('2026-08-18')).toBe('18/08/2026');
    expect(formatStamp('2026-08-18T19:45:03-05:00')).toBe('18/08/2026 19:45');
  });

  it('hands back anything it cannot read, untouched', () => {
    for (const odd of ['', 'yesterday', '18/08/2026']) expect(formatStamp(odd)).toBe(odd);
  });
});
