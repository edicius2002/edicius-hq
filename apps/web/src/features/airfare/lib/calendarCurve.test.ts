import { describe, expect, it } from 'vitest';

import { spanOf } from '@/features/airfare/lib/buckets';
import {
  absenceNote,
  calendarBuckets,
  calendarPeriods,
  calendarReading,
  calendarSentence,
  departureRange,
  eachDate,
  periodLabel,
} from '@/features/airfare/lib/calendarCurve';
import type { CalendarCurve, CalendarPoint } from '@/shared/api/fares';

/**
 * The booking horizon, turned into something drawable.
 *
 * The distinction this file exists to hold is 12.154's: a departure date the
 * provider answered about and had nothing to sell is not the same fact as a
 * departure date no answer ever came back for, and neither is a zero. Every
 * other test here is about the axis being a calendar — that a period with no
 * price still takes its place on it, and that the domain comes from the row's
 * own window rather than from a clock.
 */

function curve(
  from: string,
  to: string,
  prices: CalendarPoint[],
  overrides: Partial<CalendarCurve> = {},
): CalendarCurve {
  return {
    capturedAt: '2026-08-19T15:49:46+00:00',
    source: 'google-flights',
    currency: 'USD',
    fromDate: from,
    toDate: to,
    prices,
    ...overrides,
  };
}

function priced(date: string, price: number | null): CalendarPoint {
  return { departureDate: date, price };
}

describe('eachDate', () => {
  it('walks every calendar date between the two ends, inclusive', () => {
    expect(eachDate('2026-08-19', '2026-08-22')).toEqual([
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
    ]);
  });

  it('crosses a month boundary without losing the last day of the shorter month', () => {
    expect(eachDate('2026-02-27', '2026-03-01')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
  });

  it('returns nothing when the window runs backwards', () => {
    expect(eachDate('2026-08-22', '2026-08-19')).toEqual([]);
  });
});

describe('calendarPeriods at day granularity', () => {
  it('gives every departure date its own period, in order', () => {
    const periods = calendarPeriods(
      curve('2026-08-19', '2026-08-21', [
        priced('2026-08-19', 164.88),
        priced('2026-08-20', 119.5),
        priced('2026-08-21', 96.2),
      ]),
      'day',
    );

    expect(periods.map((period) => period.key)).toEqual(['2026-08-19', '2026-08-20', '2026-08-21']);
    expect(periods[0].bucket).toMatchObject({
      low: 164.88,
      high: 164.88,
      middle: 164.88,
      count: 1,
    });
  });

  it('takes its domain from the row and not from a clock', () => {
    // A curve collected long ago still draws the eleven months it priced: the
    // window is stated by the row, and inventing it from today would slide the
    // whole horizon a day every midnight.
    const periods = calendarPeriods(
      curve('2020-01-01', '2020-01-03', [priced('2020-01-02', 51)]),
      'day',
    );
    expect(periods).toHaveLength(3);
    expect(periods[0].key).toBe('2020-01-01');
    expect(periods[2].key).toBe('2020-01-03');
  });

  it('ignores a price for a departure date outside the window the row states', () => {
    const periods = calendarPeriods(
      curve('2026-08-19', '2026-08-20', [
        priced('2026-08-19', 100),
        priced('2026-08-20', 110),
        priced('2026-08-25', 120),
      ]),
      'day',
    );
    expect(periods).toHaveLength(2);
    expect(periods.some((period) => period.key === '2026-08-25')).toBe(false);
  });
});

describe('a date with nothing on sale and a date nobody asked about', () => {
  const gappy = curve('2026-08-19', '2026-08-22', [
    priced('2026-08-19', 100),
    // The 20th was answered for and had no seats; the 21st is simply not here.
    priced('2026-08-20', null),
    priced('2026-08-22', 130),
  ]);

  it('reads a null price as answered-and-empty, never as a fare of zero', () => {
    const periods = calendarPeriods(gappy, 'day');
    const twentieth = periods.find((period) => period.key === '2026-08-20')!;

    expect(twentieth.bucket).toBeNull();
    expect(twentieth.unsold).toBe(1);
    expect(twentieth.unanswered).toBe(0);
  });

  it('reads a date missing from the row as never answered for', () => {
    const periods = calendarPeriods(gappy, 'day');
    const twentyFirst = periods.find((period) => period.key === '2026-08-21')!;

    expect(twentyFirst.bucket).toBeNull();
    expect(twentyFirst.unsold).toBe(0);
    expect(twentyFirst.unanswered).toBe(1);
  });

  it('keeps both kinds of empty date on the axis so the calendar does not close up', () => {
    const periods = calendarPeriods(gappy, 'day');
    expect(periods.map((period) => period.key)).toEqual([
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
    ]);
  });

  it('says the two absences in different words', () => {
    const periods = calendarPeriods(gappy, 'day');
    const unsold = absenceNote(calendarReading(periods[1]));
    const unanswered = absenceNote(calendarReading(periods[2]));

    expect(unsold).toBe('nothing on sale');
    expect(unanswered).toBe('no answer collected');
    expect(unsold).not.toBe(unanswered);
  });

  it('counts both kinds separately inside a period that covers several days', () => {
    const [week] = calendarPeriods(gappy, 'week');
    expect(week.bucket?.count).toBe(2);
    expect(week.unsold).toBe(1);
    expect(week.unanswered).toBe(1);
    expect(absenceNote(calendarReading(week))).toBe(
      '1 day with nothing on sale, 1 day never answered for',
    );
  });

  it('leaves a period whose every date is empty with no band to draw', () => {
    const periods = calendarPeriods(
      curve('2026-08-20', '2026-08-21', [priced('2026-08-20', null)]),
      'week',
    );
    expect(periods[0].bucket).toBeNull();
    expect(spanOf(calendarBuckets(periods))).toBeNull();
  });
});

describe('calendarPeriods at week and month', () => {
  const august = curve('2026-08-19', '2026-09-02', [
    priced('2026-08-19', 100),
    priced('2026-08-20', 120),
    priced('2026-08-21', 140),
    priced('2026-08-22', 90),
    priced('2026-08-23', 95),
    priced('2026-08-24', 80),
    priced('2026-08-25', 82),
    priced('2026-08-26', 84),
    priced('2026-08-27', 86),
    priced('2026-08-28', 88),
    priced('2026-08-29', 70),
    priced('2026-08-30', 72),
    priced('2026-08-31', 74),
    priced('2026-09-01', 60),
    priced('2026-09-02', 62),
  ]);

  it('bands a week over the departure dates inside it', () => {
    const weeks = calendarPeriods(august, 'week');
    // 19 August 2026 is a Wednesday, so the first week is five days long.
    expect(weeks[0].key).toBe('2026-W34');
    expect(weeks[0].bucket).toMatchObject({ low: 90, high: 140, middle: 100, count: 5 });
  });

  it('clips the first and last periods to the window rather than to the calendar', () => {
    const weeks = calendarPeriods(august, 'week');
    expect(departureRange(weeks[0])).toBe('departing 19/08/2026 to 23/08/2026');

    const months = calendarPeriods(august, 'month');
    // August is thirteen days here because the curve starts on the 19th, and
    // claiming the whole month would claim eighteen days nobody has a price for.
    expect(departureRange(months[0])).toBe('departing 19/08/2026 to 31/08/2026');
    expect(months[0].bucket?.count).toBe(13);
  });

  it('names a month by its name so it cannot be read as a day — 12.114', () => {
    const months = calendarPeriods(august, 'month');
    expect(months.map((period) => period.label)).toEqual(['August 2026', 'September 2026']);
  });

  it('writes a departure date with its year, because a horizon crosses one', () => {
    expect(periodLabel('2027-01-15', 'day')).toBe('15/01/2027');
    expect(periodLabel('2026-W34', 'week')).toBe('2026 wk 34');
  });

  it('collapses to as many periods as the horizon holds, not as many as were priced', () => {
    expect(calendarPeriods(august, 'day')).toHaveLength(15);
    expect(calendarPeriods(august, 'week')).toHaveLength(3);
    expect(calendarPeriods(august, 'month')).toHaveLength(2);
  });
});

describe('the flat far half', () => {
  /*
   * The real ARI→SCL curve is a dead-flat $62.94 from January onwards, and
   * whether that is a genuinely fixed fare or a provider placeholder is not
   * something the page can know. So it is drawn as it is: a period of identical
   * prices has a band of zero height and a median equal to both ends, and
   * nothing here rounds, smooths or drops it.
   */
  it('reports a period of identical prices as a band of no width', () => {
    const flat = curve('2027-03-01', '2027-03-05', [
      priced('2027-03-01', 62.94),
      priced('2027-03-02', 62.94),
      priced('2027-03-03', 62.94),
      priced('2027-03-04', 62.94),
      priced('2027-03-05', 62.94),
    ]);
    const [month] = calendarPeriods(flat, 'month');
    expect(month.bucket).toMatchObject({ low: 62.94, high: 62.94, middle: 62.94, count: 5 });
    expect(spanOf(calendarBuckets([month]))).toEqual({ low: 62.94, high: 62.94 });
  });
});

describe('calendarSentence', () => {
  it('says one price for one departure date rather than a range of one', () => {
    const [period] = calendarPeriods(
      curve('2026-12-24', '2026-12-24', [priced('2026-12-24', 41.24)]),
      'day',
    );
    expect(calendarSentence(calendarReading(period), 'USD')).toBe(
      'departing 24/12/2026. cheapest fare $41.24.',
    );
  });

  it('says a band, its median and how many departure dates fed it', () => {
    const [period] = calendarPeriods(
      curve('2026-12-01', '2026-12-03', [
        priced('2026-12-01', 41.24),
        priced('2026-12-02', 50),
        priced('2026-12-03', 86.8),
      ]),
      'month',
    );
    expect(calendarSentence(calendarReading(period), 'USD')).toBe(
      'December 2026, departing 01/12/2026 to 03/12/2026. cheapest fare $41.24 to $86.80, median $50.00, across 3 departure dates.',
    );
  });

  it('names an empty departure date without ever printing a price for it', () => {
    const [unsold, unanswered] = calendarPeriods(
      curve('2026-12-01', '2026-12-02', [priced('2026-12-01', null)]),
      'day',
    );
    const first = calendarSentence(calendarReading(unsold), 'USD');
    const second = calendarSentence(calendarReading(unanswered), 'USD');

    expect(first).toContain('nothing on sale');
    expect(second).toContain('no answer collected');
    expect(first).not.toMatch(/\$/);
    expect(second).not.toMatch(/\$/);
  });

  it('writes the fare in whatever currency the curve itself carries', () => {
    const [period] = calendarPeriods(
      curve('2026-12-24', '2026-12-24', [priced('2026-12-24', 4580)], { currency: 'PEN' }),
      'day',
    );
    expect(calendarSentence(calendarReading(period), 'PEN')).toContain('S/4,580.00');
  });
});

describe('calendarPeriods with no curve', () => {
  it('draws nothing at all rather than an empty horizon', () => {
    expect(calendarPeriods(null, 'day')).toEqual([]);
    expect(spanOf(calendarBuckets([]))).toBeNull();
  });
});
