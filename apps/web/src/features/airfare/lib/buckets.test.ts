import { describe, expect, it } from 'vitest';

import {
  bucketBaseline,
  bucketKey,
  bucketSnapshots,
  isoWeekKey,
  spanOf,
} from '@/features/airfare/lib/buckets';
import type { FareOffer, FareSnapshot } from '@/shared/api/fares';

function offer(price: number): FareOffer {
  return {
    airline: 'JA',
    airlineName: 'JetSMART',
    flightNumber: '7029',
    departureAt: '2026-10-17T19:55',
    arrivalAt: null,
    transfers: 0,
    durationMinutes: 80,
    price,
    currency: 'USD',
  };
}

function snapshot(capturedAt: string, ...prices: number[]): FareSnapshot {
  return {
    capturedAt,
    source: 'google-flights',
    origin: 'LIM',
    destination: 'CUZ',
    flightDate: '2026-10-17',
    returnDate: null,
    currency: 'USD',
    insights: null,
    offers: prices.map(offer),
  };
}

describe('isoWeekKey', () => {
  it('numbers weeks the way the rest of the world does', () => {
    // A week that begins on Sunday here and Monday there is not a unit anyone
    // can compare, so this follows ISO 8601: weeks start Monday, and week 1 is
    // the one containing the first Thursday.
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
    expect(isoWeekKey('2026-08-18')).toBe('2026-W34');
    expect(isoWeekKey('2026-08-16')).toBe('2026-W33'); // Sunday belongs to the week before
    expect(isoWeekKey('2026-08-17')).toBe('2026-W34'); // Monday starts the next
  });

  it('gives back what it got when the date is unreadable', () => {
    expect(isoWeekKey('not-a-date')).toBe('not-a-date');
  });
});

describe('bucketKey', () => {
  it('cuts on the date only, never on local time', () => {
    // `capturedAt` carries an offset. Re-parsing it into the reader's own zone
    // would shuffle observations near midnight into the neighbouring day for
    // anyone far enough from Greenwich.
    expect(bucketKey('2026-08-18T23:50:00+00:00', 'day')).toBe('2026-08-18');
    expect(bucketKey('2026-08-18T00:10:00+00:00', 'day')).toBe('2026-08-18');
    expect(bucketKey('2026-08-18T12:00:00+00:00', 'month')).toBe('2026-08');
    expect(bucketKey('2026-08-18T12:00:00+00:00', 'week')).toBe('2026-W34');
  });
});

describe('bucketSnapshots', () => {
  const day = [
    snapshot('2026-08-18T04:00:00+00:00', 96, 200),
    snapshot('2026-08-18T16:00:00+00:00', 87, 210),
    snapshot('2026-08-19T04:00:00+00:00', 120, 240),
  ];

  it('reports a band and a middle, not just a minimum', () => {
    // The whole reason for a band: a day where the expensive itineraries sold
    // out looks identical to a quiet day if all you plot is the cheapest.
    const [first] = bucketSnapshots(day, 'day');
    expect(first.key).toBe('2026-08-18');
    expect(first.low).toBe(87);
    expect(first.high).toBe(96);
    expect(first.count).toBe(2);
  });

  it('takes the cheapest offer of each snapshot, not every itinerary', () => {
    const [first] = bucketSnapshots(day, 'day');
    // 200 and 210 were on the board and are deliberately not in the band.
    expect(first.high).toBeLessThan(200);
  });

  it('uses the median so one glitch does not drag the middle', () => {
    const spiky = [
      snapshot('2026-08-18T01:00:00+00:00', 100),
      snapshot('2026-08-18T02:00:00+00:00', 102),
      snapshot('2026-08-18T03:00:00+00:00', 4),
    ];
    expect(bucketSnapshots(spiky, 'day')[0].middle).toBe(100);
  });

  it('collapses a month of observations into one period', () => {
    expect(bucketSnapshots(day, 'month')).toHaveLength(1);
    expect(bucketSnapshots(day, 'month')[0].count).toBe(3);
  });

  it('comes back in chronological order whatever order it was given', () => {
    const shuffled = [day[2], day[0], day[1]];
    expect(bucketSnapshots(shuffled, 'day').map((b) => b.key)).toEqual([
      '2026-08-18',
      '2026-08-19',
    ]);
  });

  it('skips a snapshot with nothing on the board rather than charting a zero', () => {
    expect(bucketSnapshots([snapshot('2026-08-18T04:00:00+00:00')], 'day')).toEqual([]);
  });
});

describe('bucketBaseline', () => {
  const points = [
    { date: '2026-08-17', price: 46 },
    { date: '2026-08-18', price: 60 },
    { date: '2026-09-01', price: 52 },
  ];

  it('is a line at day granularity, because one value has no band', () => {
    const [first] = bucketBaseline(points, 'day');
    expect(first.low).toBe(first.high);
    expect(first.low).toBe(46);
  });

  it('does gain a band once a period holds more than one day', () => {
    const [august] = bucketBaseline(points, 'month');
    expect(august.low).toBe(46);
    expect(august.high).toBe(60);
  });
});

describe('spanOf', () => {
  it('covers both series so the provider line cannot run off the top', () => {
    const ours = bucketSnapshots([snapshot('2026-08-18T04:00:00+00:00', 100)], 'day');
    const theirs = bucketBaseline([{ date: '2026-08-18', price: 300 }], 'day');
    expect(spanOf(ours, theirs)).toEqual({ low: 100, high: 300 });
  });

  it('is null when there is nothing to scale to', () => {
    expect(spanOf([], [])).toBeNull();
  });
});
