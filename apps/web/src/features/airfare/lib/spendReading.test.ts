import { describe, expect, it } from 'vitest';

import {
  describeKinds,
  describeRemaining,
  formatReset,
  spendMarks,
} from '@/features/airfare/lib/spendReading';

/**
 * The day's spend as a strip draws it, and — mostly — what it declines to draw.
 *
 * Most of these are about the honesty of the picture rather than about its
 * arithmetic. There is no ceiling by default, so on an ordinary day there is no
 * track either — a bar needs an end, and the one number that could pretend to
 * be one is the busiest day on record, which is a measurement of what happened
 * rather than a limit. Where an environment does set a ceiling the mark for
 * that measured day has to be on the track, or the chosen number reads as a
 * safe maximum; a ledger that cannot be read has no bar at all,
 * because the words carry that case and an empty track beside them would be the
 * picture arguing with the sentence; and a timestamp that will not parse draws
 * nothing rather than the words `Invalid Date`.
 */

describe('spendMarks', () => {
  it('puts the fill at the spend and the mark at the busiest real day', () => {
    expect(spendMarks(150, 600, 329)).toEqual({ fill: 0.25, busiest: 329 / 600 });
  });

  it('draws no track at all for a ledger that cannot be read', () => {
    // Not a bar at zero and not a bar at full. The strip says the day cannot be
    // established in words; a track would have to claim one of the two.
    expect(spendMarks(null, 600, 329)).toBeNull();
  });

  it('draws an empty track for a day with nothing on it', () => {
    // Zero is measured — the ledger answers zero for a day whose file does not
    // exist yet — so unlike the case above there is a length to draw.
    expect(spendMarks(0, 600, 329)).toEqual({ fill: 0, busiest: 329 / 600 });
  });

  it('clamps a day that has overrun its ceiling instead of overflowing the track', () => {
    // A ceiling lowered under a day already spent is the ordinary way this
    // happens; the server reports `remaining` as zero and the bar stops at the end.
    expect(spendMarks(900, 600, 329)?.fill).toBe(1);
  });

  it('drops the high-water mark when it would not be inside the track', () => {
    // At a ceiling of 300 the busiest day on record is off the end, and a mark
    // pinned to the last pixel would read as the ceiling rather than as a
    // separate, measured fact.
    expect(spendMarks(20, 300, 329)?.busiest).toBeNull();
    expect(spendMarks(20, 329, 329)?.busiest).toBeNull();
  });

  it('has no scale to draw against a ceiling of nothing', () => {
    expect(spendMarks(0, 0, 329)).toBeNull();
  });

  it('draws no track when there is no ceiling, which is the ordinary case', () => {
    // The tempting substitute is to scale the track to the busiest day on
    // record instead. That is the one thing this must not do: it would turn the
    // strip's single measured fact into the invented safe maximum that the
    // ceiling stopped being, and a day past 329 would sit pinned at the end
    // looking like a day that had run out of something.
    expect(spendMarks(150, null, 329)).toBeNull();
    expect(spendMarks(900, null, 329)).toBeNull();
    expect(spendMarks(0, null, 329)).toBeNull();
  });
});

describe('describeRemaining', () => {
  it('names what is left of a day that has a ceiling', () => {
    expect(describeRemaining(450)).toBe('450 left');
    expect(describeRemaining(0)).toBe('0 left');
  });

  it('says nothing at all when nothing bounds the day', () => {
    // Not "unlimited left", which reads as an allowance too — just an infinite
    // one — when the point is that there is no allowance to have a share of.
    expect(describeRemaining(null)).toBeNull();
  });
});

describe('describeKinds', () => {
  it('names each kind with its count, in the order the server sent them', () => {
    expect(
      describeKinds([
        { kind: 'board', requests: 412 },
        { kind: 'calendar', requests: 29 },
      ]),
    ).toBe('412 boards · 29 calendars');
  });

  it('keeps a single request singular', () => {
    expect(describeKinds([{ kind: 'calendar', requests: 1 }])).toBe('1 calendar');
  });

  it('passes through a kind this build has never heard of', () => {
    // The ledger is an archive of what was written on the day, not a schema
    // this build enforces. An unfamiliar word is a thing to show.
    expect(describeKinds([{ kind: 'seat-map', requests: 2 }])).toBe('2 seat-maps');
  });

  it('says nothing at all when there is nothing to break down', () => {
    expect(describeKinds([])).toBeNull();
    expect(describeKinds([{ kind: 'board', requests: 0 }])).toBeNull();
  });
});

describe('formatReset', () => {
  it('reads an instant into a clock time', () => {
    const label = formatReset('2026-08-22T00:00:00+00:00');
    // Asserted as a shape rather than as a string: the whole point of this
    // function is that it lands in whatever zone the reader is in, and pinning
    // one would pin the machine the suite happens to run on.
    expect(label).toMatch(/^\d{1,2}:\d{2}(\s?[AaPp][Mm])?$/);
  });

  it('moves with the zone the reader is in rather than reporting UTC', () => {
    expect(formatReset('2026-08-22T00:00:00+00:00')).not.toBe(
      formatReset('2026-08-22T07:00:00+00:00'),
    );
  });

  it('draws nothing rather than the words Invalid Date', () => {
    expect(formatReset('not an instant')).toBeNull();
    expect(formatReset('')).toBeNull();
  });
});
