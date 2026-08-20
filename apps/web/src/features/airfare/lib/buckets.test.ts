import { describe, expect, it } from 'vitest';

import {
  boundsLabel,
  bucketBaseline,
  bucketKey,
  bucketSnapshots,
  calendarAxis,
  contiguousRuns,
  dayNumber,
  isoWeekKey,
  periodBounds,
  spanOf,
  unsoldPeriods,
  type Bucket,
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

describe('periodBounds', () => {
  it('gives a day both of its ends, midnight to one minute short of the next', () => {
    expect(periodBounds('2026-08-18', 'day')).toEqual({
      from: '2026-08-18T00:00',
      to: '2026-08-18T23:59',
    });
  });

  it('runs a week from its Monday to its Sunday', () => {
    expect(periodBounds('2026-W34', 'week')).toEqual({
      from: '2026-08-17T00:00',
      to: '2026-08-23T23:59',
    });
  });

  it('is the exact inverse of the key the chart bucketed by, week after week', () => {
    // The point of the pair. If these ever disagree the table names a stretch
    // the chart did not draw, which is the bug the calendar-exact window was
    // written to remove.
    for (let week = 1; week <= 53; week += 1) {
      const key = `2026-W${String(week).padStart(2, '0')}`;
      const { from, to } = periodBounds(key, 'week');
      expect(isoWeekKey(from.slice(0, 10))).toBe(key);
      expect(isoWeekKey(to.slice(0, 10))).toBe(key);
    }
  });

  it('asks the calendar how long a month is rather than a table of twelve numbers', () => {
    expect(periodBounds('2026-02', 'month').to).toBe('2026-02-28T23:59');
    expect(periodBounds('2028-02', 'month').to).toBe('2028-02-29T23:59'); // a leap year
    expect(periodBounds('2026-12', 'month')).toEqual({
      from: '2026-12-01T00:00',
      to: '2026-12-31T23:59',
    });
  });

  it('crosses the new year without moving the week off its Monday', () => {
    // 2027-W01 begins on Monday 4 January 2027, and the days before it belong
    // to 2026-W53 — the case a naive "first of January plus seven days a week"
    // gets wrong.
    expect(periodBounds('2027-W01', 'week').from).toBe('2027-01-04T00:00');
    expect(periodBounds('2026-W53', 'week')).toEqual({
      from: '2026-12-28T00:00',
      to: '2027-01-03T23:59',
    });
  });
});

describe('boundsLabel', () => {
  it('states both ends with their clocks, so the window is not left to inference', () => {
    expect(boundsLabel({ from: '2026-08-18T00:00', to: '2026-08-18T23:59' })).toBe(
      'on 18/08/2026, 00:00 to 23:59',
    );
    expect(boundsLabel({ from: '2026-08-17T00:00', to: '2026-08-23T23:59' })).toBe(
      'between 17/08/2026 00:00 and 23/08/2026 23:59',
    );
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
  // Every row carries the departure it priced — 12.171 — and this axis ignores
  // it: the calendar chart is drawn on when the price was *observed*, whichever
  // of the month's thirty-one departures it was quoted for.
  const points = [
    { flightDate: '2027-03-09', date: '2026-08-17', price: 46 },
    { flightDate: '2027-03-09', date: '2026-08-18', price: 60 },
    { flightDate: '2027-03-09', date: '2026-09-01', price: 52 },
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
    const theirs = bucketBaseline(
      [{ flightDate: '2027-03-09', date: '2026-08-18', price: 300 }],
      'day',
    );
    expect(spanOf(ours, theirs)).toEqual({ low: 100, high: 300 });
  });

  it('is null when there is nothing to scale to', () => {
    expect(spanOf([], [])).toBeNull();
  });
});

describe('contiguousRuns', () => {
  const band = (key: string): Bucket => ({
    key,
    label: key,
    low: 1,
    high: 2,
    middle: 1.5,
    count: 1,
  });

  it('is one run while nothing on the axis is missing from the series', () => {
    const keys = ['a', 'b', 'c'];
    expect(contiguousRuns(keys, keys.map(band)).map((run) => run.map((b) => b.key))).toEqual([
      ['a', 'b', 'c'],
    ]);
  });

  it('breaks where a period on the axis has nothing of ours in it', () => {
    // Drawn as one path, a series with a hole in it is a straight line across
    // the hole — a claim that the fare moved evenly through a period nobody
    // looked at. Two runs leave the hole a hole.
    const keys = ['a', 'b', 'c', 'd'];
    expect(
      contiguousRuns(keys, [band('a'), band('c'), band('d')]).map((run) => run.map((b) => b.key)),
    ).toEqual([['a'], ['c', 'd']]);
  });

  it('is a run of one where a bucket has no neighbour at all', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    expect(contiguousRuns(keys, [band('b'), band('d')])).toHaveLength(2);
  });

  it('ignores a bucket the axis never gave a place to', () => {
    expect(contiguousRuns(['a', 'b'], [band('a'), band('z')])).toEqual([[band('a')]]);
  });
});

describe('a period we looked at and found nothing on sale in', () => {
  it('is counted rather than dropped with the snapshot it came on', () => {
    // `bucketSnapshots` skips these, and rightly — zero is a price and a chart
    // would draw it as the best deal ever found. What went with them was the
    // fact that we asked at all.
    const snapshots = [
      snapshot('2026-08-18T04:00:00+00:00', 96),
      snapshot('2026-08-18T16:00:00+00:00'),
      snapshot('2026-08-19T04:00:00+00:00'),
    ];
    expect(bucketSnapshots(snapshots, 'day').map((entry) => entry.key)).toEqual(['2026-08-18']);
    expect(unsoldPeriods(snapshots, 'day')).toEqual([
      { key: '2026-08-18', label: '08-18', count: 1 },
      { key: '2026-08-19', label: '08-19', count: 1 },
    ]);
  });

  it('gathers into the same periods the priced snapshots gather into', () => {
    const week = unsoldPeriods(
      [snapshot('2026-08-18T04:00:00+00:00'), snapshot('2026-08-19T04:00:00+00:00')],
      'week',
    );
    expect(week).toEqual([{ key: '2026-W34', label: '2026 wk 34', count: 2 }]);
  });

  it('has nothing to say where every board came back with something on it', () => {
    expect(unsoldPeriods([snapshot('2026-08-18T04:00:00+00:00', 96)], 'day')).toEqual([]);
  });
});

describe('where a key sits on the axis', () => {
  it('is the day the period starts, so a fortnight is a fortnight wide', () => {
    const axis = calendarAxis('day');
    // Two days apart is two, and a fortnight is fourteen — the distances an
    // axis spaced by index flattened to one step each.
    expect(axis.position('2026-08-19') - axis.position('2026-08-17')).toBe(2);
    expect(axis.position('2026-08-31') - axis.position('2026-08-17')).toBe(14);
  });

  it('places a week at its own Monday and a month at its first', () => {
    expect(calendarAxis('week').position('2026-W34')).toBe(dayNumber('2026-08-17'));
    expect(calendarAxis('month').position('2026-08')).toBe(dayNumber('2026-08-01'));
  });

  it('counts whole days from the epoch without going through a local Date', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('1970-01-02')).toBe(1);
    expect(dayNumber('2026-08-17')).toBe(20682);
  });
});

describe('calendarAxis', () => {
  it('runs oldest to newest, which is ascending on a calendar key', () => {
    expect(['2026-08-19', '2026-08-17'].sort(calendarAxis('day').order)).toEqual([
      '2026-08-17',
      '2026-08-19',
    ]);
  });

  it('spells a period out with both its clocks, exactly as the table captions it', () => {
    expect(calendarAxis('day').spell('2026-08-18')).toBe('on 18/08/2026, 00:00 to 23:59');
    expect(calendarAxis('week').unit).toEqual({ one: 'week', many: 'weeks' });
  });
});
