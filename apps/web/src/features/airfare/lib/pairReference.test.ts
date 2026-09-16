import { describe, expect, it } from 'vitest';

import {
  pairReference,
  referenceFall,
  referenceLegend,
  referenceSentence,
  referenceY,
  shortDay,
} from '@/features/airfare/lib/pairReference';

/**
 * The backend owns the whole-pair calculation. This module only makes that
 * summary displayable beside the reader's local calendar date.
 */

describe('pairReference', () => {
  it('adds the reader date to the server-owned whole-pair summary unchanged', () => {
    expect(pairReference({ value: 147.69, dates: 31 }, '2026-09-15')).toEqual({
      value: 147.69,
      dates: 31,
      asOf: '2026-09-15',
    });
  });

  it('keeps an unpriced server summary absent', () => {
    expect(pairReference(null, '2026-09-15')).toBeNull();
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
