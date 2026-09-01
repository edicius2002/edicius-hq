import { describe, expect, it } from 'vitest';

import {
  describeCost,
  passCost,
  PASS_OVERRUN_MINUTES,
  REQUEST_GAP_SECONDS,
} from '@/features/airfare/lib/passCost';

const TODAY = '2026-08-18';

describe('what a pass over these months costs', () => {
  it('counts one request a departure, at the pace a pass runs at', () => {
    // A month is thirty-one board requests and a pass paces them three seconds
    // apart. Neither number is visible anywhere else on the page.
    const cost = passCost(['2026-10'], TODAY);
    expect(cost.months).toBe(1);
    expect(cost.departures).toBe(31);
    expect(cost.minutes).toBeCloseTo((31 * REQUEST_GAP_SECONDS) / 60, 5);
  });

  it('counts the current month only from today, and a departed one as nothing', () => {
    expect(passCost(['2026-08'], TODAY).departures).toBe(14);
    expect(passCost(['2026-01'], TODAY).departures).toBe(0);
  });

  it('leaves the booking-horizon curve out of the figure', () => {
    /*
     * A curve covers every month of a city pair in one observation — the
     * calendar pass deduplicates watches down to the pair before it collects —
     * so it costs the same whatever is ticked. Folding it in would make the
     * number move for a reason the chips did not cause.
     *
     * Asserted as an exact multiple of the departure count: any per-pair
     * constant added on top would break it.
     */
    for (const months of [['2026-10'], ['2026-10', '2026-11'], ['2026-10', '2026-11', '2026-12']]) {
      const cost = passCost(months, TODAY);
      expect(cost.minutes).toBeCloseTo((cost.departures * REQUEST_GAP_SECONDS) / 60, 5);
    }
  });

  it('says nothing is picked rather than saying it costs nothing', () => {
    expect(describeCost(passCost([], TODAY))).toBe('No months picked yet.');
  });

  it('keeps an ordinary pass quiet', () => {
    // A normal selection needs no explanation; the warning remains reserved
    // for the pass lengths that can silently cost a scheduled collection.
    expect(describeCost(passCost(['2026-10'], TODAY))).toBeNull();
  });

  it('warns before the window rather than only after it', () => {
    /*
     * The threshold is the scheduled task's own interval. A pass that runs past
     * it makes the next firing disappear with no error and no log — nothing
     * that looks unlike a quiet market — so the sentence says the consequence
     * and not just a number.
     */
    const under = passCost(['2026-10'], TODAY);
    expect(under.approaching).toBe(false);
    expect(under.overrun).toBe(false);

    // Twelve minutes is where it starts saying so; fifteen is where it stops
    // being a warning and becomes a statement.
    const approaching = passCost(
      ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'],
      TODAY,
    );
    expect(approaching.minutes).toBeGreaterThanOrEqual(12);
    expect(approaching.minutes).toBeLessThanOrEqual(PASS_OVERRUN_MINUTES);
    expect(approaching.approaching).toBe(true);
    expect(describeCost(approaching)).toContain('close to the 15');

    const over = passCost(
      [
        '2026-09',
        '2026-10',
        '2026-11',
        '2026-12',
        '2027-01',
        '2027-02',
        '2027-03',
        '2027-04',
        '2027-05',
        '2027-06',
      ],
      TODAY,
    );
    expect(over.minutes).toBeGreaterThan(PASS_OVERRUN_MINUTES);
    expect(over.overrun).toBe(true);
    expect(describeCost(over)).toContain('discarded without a word');
  });
});
