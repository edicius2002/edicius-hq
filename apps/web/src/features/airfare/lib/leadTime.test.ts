import { describe, expect, it } from 'vitest';

import {
  LEAD_DAYS,
  leadAxis,
  leadBaseline,
  leadKey,
  leadLabel,
  leadPeriod,
  leadSnapshots,
  leadSpan,
} from '@/features/airfare/lib/leadTime';
import type { FareOffer, FarePricePoint, FareSnapshot } from '@/shared/api/fares';

/**
 * The lead-time axis, without a browser.
 *
 * What is worth pinning is everything a reader could not check by looking: that
 * a bucket covers the days it says it covers, that the axis runs towards
 * departure rather than away from it, and that the two series are gathered
 * against the same ruler so a figure read off one can be compared with the
 * other.
 *
 * The dates here are the shape of the real archive rather than round numbers —
 * ARI–SCL is watched for March 2027 and was collected on 19 August 2026, which
 * is 194 to 224 days ahead depending on the day of the month being flown.
 */

function offer(price: number): FareOffer {
  return {
    airline: 'JA',
    airlineName: 'JetSMART',
    flightNumber: '7029',
    departureAt: '2027-03-01T19:55',
    arrivalAt: null,
    transfers: 0,
    durationMinutes: 80,
    price,
    currency: 'USD',
  };
}

function snapshot(capturedAt: string, flightDate: string, price: number): FareSnapshot {
  return {
    capturedAt,
    source: 'google-flights',
    origin: 'ARI',
    destination: 'SCL',
    flightDate,
    returnDate: null,
    currency: 'USD',
    insights: null,
    offers: [offer(price)],
  };
}

function point(date: string, flightDate: string, price: number): FarePricePoint {
  return { flightDate, date, price };
}

describe('leadKey', () => {
  it('gathers a lead time into a bucket of one, seven or thirty days', () => {
    expect(LEAD_DAYS).toEqual({ day: 1, week: 7, month: 30 });
    expect(leadKey(194, 'day')).toBe('lead-0194');
    expect(leadKey(194, 'week')).toBe('lead-0189');
    expect(leadKey(194, 'month')).toBe('lead-0180');
  });

  it('pads the key so a year out still sorts behind three months out', () => {
    // The key is compared as a string, and an unpadded `lead-96` beside
    // `lead-330` would put the year-out bucket nearer the departure.
    expect([leadKey(330, 'day'), leadKey(96, 'day')].sort()).toEqual(['lead-0096', 'lead-0330']);
  });

  it('has no bucket for a price seen on or after the day of the flight', () => {
    // Not a point on this axis: it means the collector reached a departure
    // that had already gone, which is a fact about the collector. The
    // observation is still on the calendar axis, where it belongs.
    expect(leadKey(0, 'day')).toBe('lead-0000');
    expect(leadKey(-1, 'day')).toBeNull();
    expect(leadKey(-9, 'week')).toBeNull();
  });
});

describe('what a bucket covers', () => {
  it('names the whole bucket, not the part of it that happened to be observed', () => {
    // 12.60's rule carried across: a seven-day bucket holding two lead days is
    // still the seven-day bucket, and captioning it by what landed in it would
    // state a narrower window than the one being counted.
    expect(leadSpan('lead-0189', 'week')).toEqual({ near: 189, far: 195 });
    expect(leadSpan('lead-0180', 'month')).toEqual({ near: 180, far: 209 });
  });

  it('writes every axis label with its unit, so none of them can be read as a date', () => {
    expect(leadLabel('lead-0194', 'day')).toBe('194d ahead');
    expect(leadLabel('lead-0189', 'week')).toBe('189–195d ahead');
    expect(leadLabel('lead-0180', 'month')).toBe('180–209d ahead');
  });

  it('spells the same bucket out in words for the readout', () => {
    expect(leadPeriod('lead-0194', 'day')).toBe('194 days before departure');
    expect(leadPeriod('lead-0189', 'week')).toBe('189 to 195 days before departure');
  });
});

describe('leadAxis', () => {
  it('runs furthest ahead on the left and the day of departure on the right', () => {
    // Left to right is time running forwards on every other chart in this
    // feature, and running forwards towards a departure counts the lead down.
    expect(['lead-0007', 'lead-0284', 'lead-0189'].sort(leadAxis('day').order)).toEqual([
      'lead-0284',
      'lead-0189',
      'lead-0007',
    ]);
  });

  it('names its unit so a readout cannot be mistaken for the other chart’s', () => {
    expect(leadAxis('week').unit).toEqual({ one: 'lead week', many: 'lead weeks' });
    expect(leadAxis('day').spell('lead-0194')).toBe('194 days before departure');
  });
});

describe('leadSnapshots', () => {
  // One collection pass over a watched month: the same day's work spread
  // across thirty-one departures is thirty-one different lead times.
  const pass = [
    snapshot('2026-08-19T14:00', '2027-03-01', 65),
    snapshot('2026-08-19T14:02', '2027-03-15', 62),
    snapshot('2026-08-19T14:04', '2027-03-31', 61),
  ];

  it('places one day’s work at as many lead times as it has departures', () => {
    expect(leadSnapshots(pass, 'day').map((bucket) => bucket.key)).toEqual([
      'lead-0224',
      'lead-0208',
      'lead-0194',
    ]);
  });

  it('keeps every observation of a departure, not only the newest board', () => {
    // The point of this axis is that the same departure priced on thirty
    // consecutive days is thirty points at thirty lead times; keeping only the
    // latest would collapse the curve to one point per departure.
    const watched = [
      snapshot('2026-08-17T09:00', '2027-03-01', 65),
      snapshot('2026-08-18T09:00', '2027-03-01', 63),
      snapshot('2026-08-19T09:00', '2027-03-01', 61),
    ];
    expect(leadSnapshots(watched, 'day')).toHaveLength(3);
  });

  it('gathers a lead week into one band with a median through it', () => {
    // 193, 192 and 191 days ahead — all inside the 189-to-195 bucket.
    const watched = [
      snapshot('2026-08-20T09:00', '2027-03-01', 65),
      snapshot('2026-08-21T09:00', '2027-03-01', 63),
      snapshot('2026-08-22T09:00', '2027-03-01', 61),
    ];
    const [week] = leadSnapshots(watched, 'week');
    expect(leadSnapshots(watched, 'week')).toHaveLength(1);
    expect(week.low).toBe(61);
    expect(week.high).toBe(65);
    expect(week.middle).toBe(63);
    expect(week.count).toBe(3);
  });

  it('drops a board with nothing on it rather than pricing it at zero', () => {
    const empty = { ...snapshot('2026-08-19T14:00', '2027-03-01', 65), offers: [] };
    expect(leadSnapshots([empty], 'day')).toEqual([]);
  });
});

describe('leadBaseline', () => {
  it('reads the lead time off the departure the provider priced', () => {
    // The same observation date arrives once per departure, so `date` alone is
    // not a key — the pair is, and their difference is the axis.
    const points = [
      point('2026-08-19', '2027-03-01', 65),
      point('2026-08-19', '2027-03-31', 61),
      point('2026-06-19', '2027-03-31', 64),
    ];
    expect(leadBaseline(points, 'day').map((bucket) => [bucket.key, bucket.middle])).toEqual([
      ['lead-0285', 64],
      ['lead-0224', 61],
      ['lead-0194', 65],
    ]);
  });

  it('stays its own series rather than joining ours', () => {
    // `bucketBaseline`'s reason holds here and is stronger: on this route the
    // provider reaches 91 lead days and our own archive reaches 31 of them, so
    // a merged line would be the provider's shape for two thirds of its length
    // and ours for the last third, with the join reading as a price movement.
    const ours = leadSnapshots([snapshot('2026-08-19T14:00', '2027-03-01', 65)], 'day');
    const theirs = leadBaseline([point('2026-08-19', '2027-03-01', 65)], 'day');
    expect(ours[0].key).toBe(theirs[0].key);
    expect(ours).not.toBe(theirs);
  });
});
