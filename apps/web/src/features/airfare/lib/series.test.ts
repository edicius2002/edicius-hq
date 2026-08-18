import { describe, expect, it } from 'vitest';

import {
  byAirline,
  cheapestOffer,
  cheapestSeries,
  daysBeforeDeparture,
  departureClock,
  departureDay,
  formatDuration,
  latestSnapshot,
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
    currency: 'USD',
    offers: prices.map((price) => offer(price)),
    ...over,
  };
}

describe('snapshotsFor', () => {
  it('separates two departure dates that share one archive file', () => {
    const all = [
      snapshot('2026-08-17T12:00:00+00:00', [125]),
      snapshot('2026-08-17T12:00:00+00:00', [640], { flightDate: '2026-12-20' }),
    ];
    // Charted together, the step between an October fare and a December one
    // would be drawn as a price movement.
    expect(snapshotsFor(all, '2026-10-16')).toHaveLength(1);
    expect(snapshotsFor(all, '2026-12-20')[0].offers[0].price).toBe(640);
  });

  it('treats a one-way and a return on the same departure as different watches', () => {
    const all = [
      snapshot('2026-08-17T12:00:00+00:00', [125]),
      snapshot('2026-08-17T12:00:00+00:00', [230], { returnDate: '2026-10-23' }),
    ];
    expect(snapshotsFor(all, '2026-10-16', null)).toHaveLength(1);
    expect(snapshotsFor(all, '2026-10-16', '2026-10-23')[0].offers[0].price).toBe(230);
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

describe('cheapestOffer and latestSnapshot', () => {
  it('pick the lowest price and the most recent observation', () => {
    expect(cheapestOffer(snapshot('2026-08-17T12:00:00+00:00', [200, 125, 180]))?.price).toBe(125);
    expect(cheapestOffer(snapshot('2026-08-17T12:00:00+00:00', []))).toBeNull();
    expect(
      latestSnapshot([
        snapshot('2026-08-17T12:00:00+00:00', [125]),
        snapshot('2026-08-19T12:00:00+00:00', [150]),
        snapshot('2026-08-18T12:00:00+00:00', [140]),
      ])?.capturedAt,
    ).toBe('2026-08-19T12:00:00+00:00');
    expect(latestSnapshot([])).toBeNull();
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
