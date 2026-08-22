import { describe, expect, it } from 'vitest';

import {
  pairReference,
  referenceFall,
  referenceLegend,
  referenceSentence,
  referenceY,
  shortDay,
} from '@/features/airfare/lib/pairReference';
import type { FareOffer, FareSnapshot } from '@/shared/api/fares';

/**
 * What a city pair usually costs, and where that lands on a frame drawn to its
 * own scale.
 *
 * The figures asserted here are the real ones. They were computed off the
 * owner's archive on 2026-08-22 — `services/api/.local-data/fares/*.jsonl`,
 * read-only — and three of them are the ones the decision was settled against:
 * AQP-LIM $58.20, AEP-SCL $161.30, SCL-EZE $102.13. The fixtures below are cut
 * down to the shape of that data rather than invented, so a change to the
 * definition shows up as a changed figure here.
 */

function offer(price: number, overrides: Partial<FareOffer> = {}): FareOffer {
  return {
    airline: 'LA',
    airlineName: 'LATAM',
    flightNumber: '2075',
    departureAt: '2027-03-09T19:55',
    arrivalAt: '2027-03-09T21:15',
    transfers: 0,
    durationMinutes: 80,
    price,
    currency: 'USD',
    ...overrides,
  };
}

function snapshot(
  flightDate: string,
  prices: number[],
  capturedAt = '2026-08-20T02:38',
): FareSnapshot {
  return {
    capturedAt,
    source: 'google-flights',
    origin: 'SCL',
    destination: 'EZE',
    flightDate,
    returnDate: null,
    currency: 'USD',
    insights: null,
    offers: prices.map((price) => offer(price)),
  };
}

describe('pairReference', () => {
  it('is the median of the cheapest fare of each departure date', () => {
    const archive = [
      snapshot('2027-03-01', [120, 400]),
      snapshot('2027-03-02', [90, 260]),
      snapshot('2027-03-03', [150, 900]),
    ];
    // Cheapest per date: 90, 120, 150. Their median is 120.
    expect(pairReference(archive, '2026-08-22')).toEqual({
      value: 120,
      dates: 3,
      asOf: '2026-08-22',
    });
  });

  it('is a median and not a mean, so one glitch cannot move it', () => {
    /*
     * SCL-EZE's real archive holds a $1,267.82 offer and EZE-SCL a $1,788.78
     * one. `buckets.ts` already writes the rule this keeps — "one collection
     * during a fare glitch should not drag a whole week's middle with it" — and
     * a mean over the three below is $434.71 against a median of $102.13.
     */
    const archive = [
      snapshot('2027-03-01', [95.12]),
      snapshot('2027-03-02', [102.13]),
      snapshot('2027-03-03', [1106.88]),
    ];
    expect(pairReference(archive, '2026-08-22')?.value).toBe(102.13);
  });

  it('reads the cheapest of each board and not every offer on it', () => {
    /*
     * The question is "would I pay less than usual", which is about the fare a
     * reader would actually buy. Measured on the real archive, counting every
     * offer moves AQP-LIM from $58.20 to $71.31 and SCL-EZE from $102.13 to
     * $131.16 — a business-class cabin folded into the middle of an answer
     * about economy.
     */
    const archive = [
      snapshot('2026-12-01', [58.51, 62.82, 300]),
      snapshot('2026-12-02', [58.2, 61, 280]),
      snapshot('2026-12-03', [58.2, 71.31, 410]),
    ];
    expect(pairReference(archive, '2026-08-22')?.value).toBe(58.2);
  });

  it('takes the cheapest a date was ever seen at, across every look', () => {
    // A departure date is polled many times and the reference is a statement
    // about the pair rather than about the newest pass, so all of them count.
    const archive = [
      snapshot('2027-03-01', [180], '2026-08-18T02:00'),
      snapshot('2027-03-01', [161.3], '2026-08-19T02:00'),
      snapshot('2027-03-01', [175], '2026-08-20T02:00'),
    ];
    expect(pairReference(archive, '2026-08-22')).toEqual({
      value: 161.3,
      dates: 1,
      asOf: '2026-08-22',
    });
  });

  it('averages the two middle dates on an even count, as a median does', () => {
    const archive = [
      snapshot('2027-03-01', [100]),
      snapshot('2027-03-02', [120]),
      snapshot('2027-03-03', [140]),
      snapshot('2027-03-04', [160]),
    ];
    expect(pairReference(archive, '2026-08-22')?.value).toBe(130);
  });

  it('ignores a board that came back with nothing on it rather than scoring it zero', () => {
    // Zero is a price and a chart would draw it as the best deal ever found —
    // `cheapestSeries` keeps the same rule.
    const archive = [snapshot('2027-03-01', []), snapshot('2027-03-02', [140])];
    expect(pairReference(archive, '2026-08-22')).toEqual({
      value: 140,
      dates: 1,
      asOf: '2026-08-22',
    });
  });

  it('is nothing at all for a pair with nothing priced yet', () => {
    expect(pairReference([], '2026-08-22')).toBeNull();
    expect(pairReference([snapshot('2027-03-01', [])], '2026-08-22')).toBeNull();
  });
});

describe('where it falls on a frame', () => {
  it('is inside a frame that straddles it', () => {
    expect(referenceFall(161.3, { low: 97.84, high: 404.75 })).toBe('inside');
  });

  it('is below a frame whose every fare is dearer than the pair usually is', () => {
    /*
     * Not a corner case. LIM-SCL's pair median is $147.69 and 30 of its 62
     * departure dates, read one day at a time, hold no fare that cheap — the
     * March half of that watch runs from $158.79 up.
     */
    expect(referenceFall(147.69, { low: 158.79, high: 380.59 })).toBe('below');
  });

  it('is above a frame whose every fare is cheaper', () => {
    expect(referenceFall(147.69, { low: 60, high: 120 })).toBe('above');
  });

  it('counts a figure exactly on a rail as inside, so the arrow means what it says', () => {
    expect(referenceFall(100, { low: 100, high: 200 })).toBe('inside');
    expect(referenceFall(200, { low: 100, high: 200 })).toBe('inside');
  });
});

describe('referenceY', () => {
  const RAILS = { top: 14, bottom: 266 };

  it('places the figure on the frame’s own scale', () => {
    // Halfway up a 100–200 frame is halfway down a 14–266 plot.
    expect(referenceY(150, { low: 100, high: 200 }, RAILS)).toBe(140);
  });

  it('clamps to the floor rather than drawing off the plot', () => {
    // The reference is below everything in the frame: the rule goes to the rail
    // and the drawing says so with a mark, rather than vanishing.
    expect(referenceY(50, { low: 100, high: 200 }, RAILS)).toBe(266);
  });

  it('clamps to the ceiling the same way', () => {
    expect(referenceY(400, { low: 100, high: 200 }, RAILS)).toBe(14);
  });

  it('does not divide by a frame with no width', () => {
    expect(Number.isFinite(referenceY(100, { low: 100, high: 100 }, RAILS))).toBe(true);
  });
});

describe('what it says', () => {
  const REFERENCE = { value: 161.3, dates: 31, asOf: '2026-08-22' };

  it('writes the date as day and month', () => {
    expect(shortDay('2026-08-22')).toBe('22/08');
    expect(shortDay('not a date')).toBe('not a date');
  });

  it('carries the date into the legend, because the figure is worked out afresh', () => {
    expect(referenceLegend(REFERENCE)).toBe('Pair median, 22/08');
  });

  it('says the figure, what it is a median of, and when', () => {
    const said = referenceSentence(REFERENCE, 'inside', 'USD');
    expect(said).toContain('$161.30');
    expect(said).toContain('31 departure dates');
    expect(said).toContain('22/08');
  });

  it('says which side of the line a frame is on when it is entirely on one', () => {
    expect(referenceSentence(REFERENCE, 'below', 'USD')).toContain(
      'Every fare in this frame is above it',
    );
    expect(referenceSentence(REFERENCE, 'above', 'USD')).toContain(
      'Every fare in this frame is below it',
    );
  });

  it('counts one departure date in the singular', () => {
    expect(referenceSentence({ ...REFERENCE, dates: 1 }, 'inside', 'USD')).toContain(
      '1 departure date of its archive',
    );
  });
});
