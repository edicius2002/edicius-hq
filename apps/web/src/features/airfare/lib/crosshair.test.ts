import { describe, expect, it } from 'vitest';

import { calendarAxis, type Bucket } from '@/features/airfare/lib/buckets';
import {
  TAG_CHAR_WIDTH,
  TAG_PADDING,
  clampToTrack,
  labelSpan,
  marginForPrices,
  nearestBucket,
  priceAxisTag,
  readingAt,
  readingSentence,
  tagHoldsLabel,
  tagWidth,
  timeAxisTag,
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
    expect(readingAt('2026-08-18', ours, baseline, calendarAxis('day'))).toEqual({
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
    const reading = readingAt('2026-08-17', ours, baseline, calendarAxis('day'));
    expect(reading?.baseline).toBeNull();
    expect(reading?.ours?.middle).toBe(125);
  });

  it('still reports a period only the provider reached', () => {
    const reading = readingAt('2026-08-16', ours, baseline, calendarAxis('day'));
    expect(reading?.ours).toBeNull();
    expect(reading?.baseline).toBe(90);
  });

  it('has nothing to say about a period neither series drew', () => {
    expect(readingAt('2026-08-19', ours, baseline, calendarAxis('day'))).toBeNull();
  });

  it('spells a week out as its Monday to its Sunday, the same rule the table uses', () => {
    const week = [{ ...bucket('2026-W34', 118, 160, 132, 5), label: '2026 wk 34' }];
    expect(readingAt('2026-W34', week, [], calendarAxis('week'))?.period).toBe(
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
      calendarAxis('day'),
    );
    expect(readingSentence(reading!, 'USD')).toBe(
      '08-18, on 18/08/2026, 00:00 to 23:59. $130.00 to $160.00, median $139.00, across 2 observations. provider baseline $96.00.',
    );
  });

  it('names a missing baseline instead of leaving the clause out', () => {
    // A period the provider's sixty days never reached is a fact about the
    // baseline, and a sentence that simply stopped would read as though the
    // two series agreed.
    const reading = readingAt(
      '2026-08-18',
      [bucket('2026-08-18', 130, 160, 139, 1)],
      [],
      calendarAxis('day'),
    );
    expect(readingSentence(reading!, 'USD')).toContain('provider baseline —.');
    expect(readingSentence(reading!, 'USD')).toContain('across 1 observation.');
  });

  it('says so when only the provider has a figure for the period', () => {
    const reading = readingAt(
      '2026-08-18',
      [],
      [bucket('2026-08-18', 96, 96, 96, 1)],
      calendarAxis('day'),
    );
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

/* ---------------------------------------------------------------- the tags -- */

/**
 * The glyph width the plate is sized for. jsdom has no `getBBox`, so the drawn
 * box cannot be measured here — but the estimate is what the placement is built
 * on, and it was checked against a real browser: `07-27` is predicted at 30
 * units and measures 29.5.
 */
function estimatedText(label: string): number {
  return label.length * TAG_CHAR_WIDTH;
}

describe('timeAxisTag', () => {
  const TRACK = { start: 84, end: 744 };
  const LABELS = ['08-18', '2026 wk 34', '2026-08', '07-27', '01-01'];

  it('holds its label on its plate, wherever along the axis it sits', () => {
    // The bug this pins: the plate was placed for a centred label while the
    // label was drawn end-anchored, so the leading `0` of `07-27` fell nine
    // units outside the plate onto the dark plot and was invisible. Measured in
    // the live SVG at plate 466.9-506.9 against glyphs 457.6-487.1.
    for (const label of LABELS) {
      for (const centre of [84, 100, 300, 486.9, 700, 744]) {
        const tag = timeAxisTag(centre, label, TRACK.start, TRACK.end);
        expect(tagHoldsLabel(tag, estimatedText(label))).toBe(true);
      }
    }
  });

  it('centres the plate on the hairline and the label in the plate', () => {
    const tag = timeAxisTag(486.9, '07-27', TRACK.start, TRACK.end);
    expect(tag).toEqual({ x: 466.9, width: 40, textX: 486.9, anchor: 'middle' });
    expect(labelSpan(tag, estimatedText('07-27'))).toEqual({ from: 471.9, to: 501.9 });
  });

  it('would put the label off its plate if it were drawn end-anchored', () => {
    // Which is exactly what a `text-anchor: end` in the stylesheet did to the
    // `textAnchor="middle"` on the element — a CSS declaration beats a
    // presentation attribute whatever its specificity. The anchor now travels
    // with the plate so the two cannot disagree.
    const tag = timeAxisTag(486.9, '07-27', TRACK.start, TRACK.end);
    expect(tagHoldsLabel({ ...tag, anchor: 'end' }, estimatedText('07-27'))).toBe(false);
    expect(labelSpan({ ...tag, anchor: 'end' }, estimatedText('07-27')).from).toBeCloseTo(456.9, 5);
  });

  it('keeps the whole tag on the plot at either end of the series', () => {
    const first = timeAxisTag(TRACK.start, '2026 wk 34', TRACK.start, TRACK.end);
    expect(first.x).toBe(TRACK.start);
    expect(first.x + first.width).toBeLessThanOrEqual(TRACK.end);

    const last = timeAxisTag(TRACK.end, '2026 wk 34', TRACK.start, TRACK.end);
    expect(last.x).toBeGreaterThanOrEqual(TRACK.start);
    expect(last.x + last.width).toBe(TRACK.end);
  });
});

describe('tagWidth', () => {
  it('sizes the plate from the label, because the granularities write different things', () => {
    // `08-18` against `2026 wk 34`: a plate sized for the longest sits visibly
    // oversized under the shortest.
    expect(tagWidth('07-27')).toBe(5 * TAG_CHAR_WIDTH + TAG_PADDING);
    expect(tagWidth('2026 wk 34')).toBe(10 * TAG_CHAR_WIDTH + TAG_PADDING);
  });

  it('never goes below a floor, so a short label still gets a plate', () => {
    expect(tagWidth('8')).toBe(40);
  });
});

describe('priceAxisTag', () => {
  /** The right edge of the margin the chart actually gives it. */
  const RIGHT = marginForPrices(8) - 8;

  it('right-aligns against the axis, and holds every figure this app can print', () => {
    // The margin used to be 62 units wide and this is what that cost: a
    // long-haul fare in soles — the currency of this app's default origin —
    // needs 70, so its leading `S` was drawn outside the viewBox entirely. The
    // same defect as the time tag's, reached from the other direction.
    for (const label of ['$139.00', '$1,458.00', 'S/4,580.00', 'S/12,458.00', 'PEN 980.00']) {
      const tag = priceAxisTag(RIGHT, label);
      expect(tagHoldsLabel(tag, estimatedText(label))).toBe(true);
      expect(tag.x).toBeGreaterThanOrEqual(0);
    }
  });

  it('fills the margin from the right, because it never travels sideways', () => {
    // This tag survived the anchor mix-up that broke the time one precisely
    // because it sits at a fixed edge rather than at an arbitrary point along
    // its axis.
    const tag = priceAxisTag(76, '$139.00');
    expect(tag).toEqual({ x: 24, width: 52, textX: 74, anchor: 'end' });
  });

  it('never asks for more room than the margin has', () => {
    const tag = priceAxisTag(50, 'S/12,458.00');
    expect(tag.x).toBe(0);
    expect(tag.width).toBe(50);
  });
});

describe('marginForPrices', () => {
  it('is measured from the widest figure rather than chosen', () => {
    // 62 was chosen, and it was too small. This is `S/12,458.00` plus the gap.
    expect(marginForPrices(8)).toBe(84);
  });
});
