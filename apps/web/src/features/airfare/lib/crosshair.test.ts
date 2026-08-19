import { describe, expect, it } from 'vitest';

import type { Bucket } from '@/features/airfare/lib/buckets';
import {
  clampToTrack,
  nearestBucket,
  readingAt,
  readingSentence,
} from '@/features/airfare/lib/crosshair';

/**
 * The crosshair's arithmetic, without a browser.
 *
 * What is worth pinning here is what a reader could never check by looking:
 * that the readout belongs to the period it names even when the two series are
 * different lengths, that a pointer between two periods lands on one of them
 * rather than between, and that a label at the edge of the chart is still a
 * label rather than half of one.
 */

function bucket(key: string, low: number, high: number, middle: number, count = 3): Bucket {
  return { key, label: key.slice(5), low, high, middle, count };
}

describe('nearestBucket', () => {
  const positions = [62, 200, 400, 682];

  it('snaps to the nearest period rather than reading between two of them', () => {
    // The series has gaps — a collector that missed two days leaves no bucket
    // at all for them — so a readout that interpolated would print a price for
    // a day nobody looked at.
    expect(nearestBucket(positions, 210)).toBe(1);
    expect(nearestBucket(positions, 399)).toBe(2);
  });

  it('reaches past the ends, so the first and last periods are not unreadable', () => {
    expect(nearestBucket(positions, -40)).toBe(0);
    expect(nearestBucket(positions, 5000)).toBe(3);
  });

  it('settles on the earlier period when the pointer is exactly between two', () => {
    // Strictly nearer wins. A tie broken the other way flickers between the two
    // as the hand shakes across the midpoint.
    expect(nearestBucket(positions, 300)).toBe(1);
  });

  it('has nothing to point at on a chart with no periods', () => {
    expect(nearestBucket([], 120)).toBeNull();
  });
});

describe('readingAt', () => {
  const ours = [bucket('2026-08-17', 118, 142, 125), bucket('2026-08-18', 130, 160, 139, 2)];
  const baseline = [bucket('2026-08-16', 90, 90, 90, 1), bucket('2026-08-18', 96, 96, 96, 1)];

  it('reports both series at one period, and says which whole day it is', () => {
    expect(readingAt('2026-08-18', ours, baseline, 'day')).toEqual({
      key: '2026-08-18',
      label: '08-18',
      period: 'on 18/08/2026, 00:00 to 23:59',
      ours: { low: 130, high: 160, middle: 139, count: 2 },
      baseline: 96,
    });
  });

  it('matches the two series by key, never by position', () => {
    // The provider ships sixty days of history and our own archive starts the
    // day the route was added, so index 0 of one is not index 0 of the other.
    // Read by position, this period would borrow the provider's 16 August
    // figure and attach it to the 17th.
    const reading = readingAt('2026-08-17', ours, baseline, 'day');
    expect(reading?.baseline).toBeNull();
    expect(reading?.ours?.middle).toBe(125);
  });

  it('still reports a period only the provider reached', () => {
    const reading = readingAt('2026-08-16', ours, baseline, 'day');
    expect(reading?.ours).toBeNull();
    expect(reading?.baseline).toBe(90);
  });

  it('has nothing to say about a period neither series drew', () => {
    expect(readingAt('2026-08-19', ours, baseline, 'day')).toBeNull();
  });

  it('spells a week out as its Monday to its Sunday, the same rule the table uses', () => {
    const week = [{ ...bucket('2026-W34', 118, 160, 132, 5), label: '2026 wk 34' }];
    expect(readingAt('2026-W34', week, [], 'week')?.period).toBe(
      'between 17/08/2026 00:00 and 23/08/2026 23:59',
    );
  });
});

describe('readingSentence', () => {
  it('reads out every number the chart drew at that period', () => {
    const reading = readingAt(
      '2026-08-18',
      [bucket('2026-08-18', 130, 160, 139, 2)],
      [bucket('2026-08-18', 96, 96, 96, 1)],
      'day',
    );
    expect(readingSentence(reading!, 'USD')).toBe(
      '08-18, on 18/08/2026, 00:00 to 23:59. $130.00 to $160.00, median $139.00, across 2 observations. provider baseline $96.00.',
    );
  });

  it('names a missing baseline instead of leaving the clause out', () => {
    // A period the provider's sixty days never reached is a fact about the
    // baseline, and a sentence that simply stopped would read as though the
    // two series agreed.
    const reading = readingAt('2026-08-18', [bucket('2026-08-18', 130, 160, 139, 1)], [], 'day');
    expect(readingSentence(reading!, 'USD')).toContain('provider baseline —.');
    expect(readingSentence(reading!, 'USD')).toContain('across 1 observation.');
  });

  it('says so when only the provider has a figure for the period', () => {
    const reading = readingAt('2026-08-18', [], [bucket('2026-08-18', 96, 96, 96, 1)], 'day');
    expect(readingSentence(reading!, 'USD')).toContain('nothing of our own observed');
  });
});

describe('clampToTrack', () => {
  it('centres a label on its hairline while there is room for it', () => {
    expect(clampToTrack(300, 40, 62, 744)).toBe(280);
  });

  it('holds the label inside the plot at either end', () => {
    // The first period on the axis is exactly the one whose label would
    // otherwise be cut in half by the edge of the chart.
    expect(clampToTrack(62, 40, 62, 744)).toBe(62);
    expect(clampToTrack(744, 40, 62, 744)).toBe(704);
  });

  it('gives up on the start rather than a negative offset when the track is too short', () => {
    expect(clampToTrack(50, 120, 40, 100)).toBe(40);
  });
});
