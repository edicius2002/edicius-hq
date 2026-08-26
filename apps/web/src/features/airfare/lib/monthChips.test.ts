import { describe, expect, it } from 'vitest';

import {
  allDeparted,
  beyondHorizon,
  monthChips,
  monthsElsewhere,
  MONTHS_PER_ROW,
  refusalText,
  shortMonth,
  staleText,
} from '@/features/airfare/lib/monthChips';

/**
 * Today throughout, so the two ends of the strip are fixed: August 2026 is the
 * month the reader is standing in, and 330 days out is 2027-07-14.
 */
const TODAY = '2026-08-18';

describe('monthChips', () => {
  it('draws twelve, in calendar order, whatever the horizon reaches', () => {
    // A strip that grew and shrank as the year moved would be a control
    // changing shape under the reader. A month it cannot take is drawn and
    // refused instead.
    const chips = monthChips('2026', [], TODAY);
    expect(chips).toHaveLength(12);
    expect(chips.map((chip) => chip.month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
  });

  it('names each cell with its year, and prints it without one', () => {
    // The year lives in a control beside the strip, so a cell that only said
    // `Jan` out loud would be a month nobody could place.
    const [january] = monthChips('2027', [], TODAY);
    expect(january.label).toBe('January 2027');
    expect(january.short).toBe('Jan');
  });

  it('refuses a month that has gone, and a month past the horizon', () => {
    const chips = monthChips('2026', [], TODAY);
    const at = (month: string) => chips.find((chip) => chip.month === month);

    expect(at('2026-01')?.refusal).toBe('gone');
    // The month the reader is standing in still counts: its remaining days do.
    expect(at('2026-08')?.refusal).toBeNull();
    expect(at('2026-12')?.refusal).toBeNull();

    const next = monthChips('2027', [], TODAY);
    expect(next.find((chip) => chip.month === '2027-07')?.refusal).toBeNull();
    expect(next.find((chip) => chip.month === '2027-08')?.refusal).toBe('beyond-horizon');
  });

  it('never refuses a month that is already picked', () => {
    /*
     * A watch made in August needs August to be removable in September. A
     * pressed control that is also disabled is a trap with no way out of it,
     * so a stale month stays live — and says on hover that nothing more will
     * be collected for it.
     */
    const chips = monthChips('2026', ['2026-01'], TODAY);
    const january = chips.find((chip) => chip.month === '2026-01');
    expect(january?.selected).toBe(true);
    expect(january?.refusal).toBeNull();
    expect(staleText('2026-01')).toBe(
      'January 2026 has gone; nothing more will be collected for it.',
    );
  });

  it('keeps the sentences the add form has always refused with', () => {
    // Not new wording: these are the strings the form has always refused with,
    // moved to where the reader is standing when they cause one.
    expect(refusalText('gone', TODAY)).toBe('That month has gone.');
    expect(refusalText('beyond-horizon', TODAY)).toContain('14/07/2027');
  });
});

describe('monthsElsewhere', () => {
  it('counts the picked months the strip on screen is not showing', () => {
    // Without it, a reader on 26 who has picked March 2027 sees twelve
    // unpressed chips and a form that looks empty.
    expect(monthsElsewhere(['2026-09', '2027-03'], '2026')).toBe('1 more in 27');
    expect(monthsElsewhere(['2027-03', '2027-04'], '2026')).toBe('2 more in 27');
  });

  it('says nothing when the strip holds all of them', () => {
    expect(monthsElsewhere(['2026-09', '2026-10'], '2026')).toBeNull();
    expect(monthsElsewhere([], '2026')).toBeNull();
  });
});

describe('what a watchlist row draws', () => {
  it('prints three letters and never a year', () => {
    /*
     * The trade-off, pinned so it is a decision and not a regression. `Nov 26`
     * is 55.52px against `Nov`'s 31.76, so four tabs carrying years want 231px
     * of a row that has 135 — showing every month explicitly and showing each
     * one's year are not both available at this width.
     *
     * The year is on every tab's accessible name and on the group's `title`,
     * which is what the row test asserts.
     */
    expect(shortMonth('2026-11')).toBe('Nov');
    expect(shortMonth('2027-11')).toBe('Nov');
    expect(shortMonth('2026-01')).toBe('Jan');
  });

  it('hands back anything that is not a month untouched', () => {
    expect(shortMonth('soon')).toBe('soon');
  });

  it('puts four to a line, which is what the width of a row allows', () => {
    // Measured rather than chosen — see the constant. The stylesheet declares
    // the same four, and `routesScroll.test` is what holds the two together.
    expect(MONTHS_PER_ROW).toBe(4);
  });
});

describe('what the form refuses a whole selection for', () => {
  it('knows when every picked month has gone', () => {
    expect(allDeparted(['2026-01', '2026-02'], TODAY)).toBe(true);
    expect(allDeparted(['2026-01', '2026-09'], TODAY)).toBe(false);
    // An empty selection is not a departed one — it is a different refusal.
    expect(allDeparted([], TODAY)).toBe(false);
  });

  it('names the picked months the horizon cannot reach', () => {
    // Named rather than counted: telling a reader that "some" of their months
    // are past the horizon leaves them to work out which, in a strip where the
    // offending cells are the ones they just pressed.
    expect(beyondHorizon(['2026-09', '2027-08', '2027-09'], TODAY)).toEqual(['2027-08', '2027-09']);
    expect(beyondHorizon(['2026-09'], TODAY)).toEqual([]);
  });
});
