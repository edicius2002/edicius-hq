import { describe, expect, it } from 'vitest';

import { collectedAtLabel, eachDate } from '@/features/airfare/lib/calendarCurve';

/**
 * What is left of the booking horizon's own module once the chart that folded
 * it into weeks and months is gone.
 *
 * The folding went with the zoom: a curve date is drawn as itself now, beside
 * the boards, so there is no aggregate to build and nothing to describe. What
 * these two functions still have to get right is the pair of things that were
 * never about periods — which dates a stated window covers, and how old the
 * curve on screen is. Both are about not letting a `Date` shift a day: this
 * app's default reader is in Lima, and `new Date('2026-08-19')` is the 18th
 * there.
 */

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

  it('walks a leap day rather than skipping it', () => {
    expect(eachDate('2028-02-28', '2028-03-01')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('returns nothing when the window runs backwards', () => {
    expect(eachDate('2026-08-22', '2026-08-19')).toEqual([]);
  });

  it('returns nothing at all rather than a guess when the ends are not dates', () => {
    expect(eachDate('not-a-date', '2026-08-19')).toEqual([]);
  });
});

describe('collectedAtLabel', () => {
  it('keeps the clock the collector wrote rather than reading it in the browser zone', () => {
    expect(collectedAtLabel('2026-08-19T15:49:46+00:00')).toBe('19/08/2026 15:49');
  });

  it('says the date alone where the stamp carries no clock', () => {
    expect(collectedAtLabel('2026-08-19')).toBe('19/08/2026');
  });

  it('hands back anything it cannot read, so a reader can puzzle over it', () => {
    expect(collectedAtLabel('whenever')).toBe('whenever');
  });
});
