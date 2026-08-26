import { describe, expect, it } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import {
  describeCollection,
  describeHorizon,
  describeHorizonProgress,
  describeRefusal,
} from '@/features/airfare/lib/rowReport';
import type {
  CalendarCollectResponse,
  CollectResponse,
  CollectRouteResult,
} from '@/shared/api/fares';

const LIM_CUZ: FareRoute = {
  origin: 'LIM',
  destination: 'CUZ',
  months: ['2026-10'],
  currency: 'USD',
};

function result(overrides: Partial<CollectRouteResult> = {}): CollectRouteResult {
  return {
    origin: 'LIM',
    destination: 'CUZ',
    flightDate: '2026-10-17',
    returnDate: null,
    ok: true,
    changed: false,
    seeded: 0,
    offers: 14,
    cheapest: 412,
    currency: 'USD',
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function report(overrides: Partial<CollectResponse> = {}): CollectResponse {
  return {
    state: 'finished',
    startedAt: '2026-08-19T14:00:00+00:00',
    finishedAt: '2026-08-19T14:00:06+00:00',
    source: 'google',
    // The pass covers the route these tests ask about. A row only reads a pass
    // that names its own month — 12.210 — so leaving this out would make every
    // case below assert the "somebody else's pass" branch by accident.
    watching: ['LIM-CUZ 2026-10'],
    polling: 1,
    completed: 1,
    collected: 1,
    changed: 0,
    failed: 0,
    results: [],
    skipped: [],
    error: null,
    ...overrides,
  };
}

/** Pinned, because `money` follows the browser's locale by design. */
const LOCALE = 'en-US';

describe('what a row says after its own collection', () => {
  it('counts the departures it looked at and names the cheapest day among them', () => {
    // The one figure a month can give that a single departure could not: not
    // "October costs $380" but "October costs $380 and it is the 21st".
    const line = describeCollection(
      LIM_CUZ,
      report({
        results: [
          result({ flightDate: '2026-10-17', cheapest: 412 }),
          result({ flightDate: '2026-10-21', cheapest: 380 }),
        ],
      }),
      LOCALE,
    );
    expect(line.ok).toBe(true);
    expect(line.text).toBe(
      'Collected: 2 departures looked at, cheapest $380.00 on 21/10/2026 — nothing new to record.',
    );
  });

  it('says how many of the looks actually wrote a snapshot', () => {
    // Most successful looks write nothing — the board rarely moves between
    // polls — and a reader who is not told that reads a flat series as a
    // collector that stopped.
    const line = describeCollection(
      LIM_CUZ,
      report({
        results: [
          result({ flightDate: '2026-10-17', changed: true }),
          result({ flightDate: '2026-10-18' }),
        ],
      }),
      LOCALE,
    );
    expect(line.text).toContain('1 new snapshot');
  });

  it('mentions the provider history a first look folds in, across the whole month', () => {
    // Non-zero essentially only the first time a departure is watched, and a
    // month watched for the first time seeds every day of it at once.
    const line = describeCollection(
      LIM_CUZ,
      report({
        results: [
          result({ flightDate: '2026-10-17', seeded: 60, changed: true }),
          result({ flightDate: '2026-10-18', seeded: 60, changed: true }),
        ],
      }),
      LOCALE,
    );
    expect(line.text).toContain("120 days of the provider's own history seeded");
  });

  it('carries a refusal with its code and its reason when the whole month refused', () => {
    // What was refused travels beside what worked and says why — 8.8 and 8.41.
    const line = describeCollection(
      LIM_CUZ,
      report({
        failed: 1,
        collected: 0,
        results: [
          result({ ok: false, errorCode: 'no-offers', errorMessage: 'nothing on that day' }),
        ],
      }),
      LOCALE,
    );
    expect(line.ok).toBe(false);
    expect(line.text).toBe('Refused: no-offers — nothing on that day');
  });

  it('still reports the days that worked when only some of the month refused', () => {
    // A month is thirty-one separate requests and one of them failing is not
    // the pass failing. Reporting only the refusal would hide the collection.
    const line = describeCollection(
      LIM_CUZ,
      report({
        failed: 1,
        results: [
          result({ flightDate: '2026-10-17' }),
          result({ flightDate: '2026-10-18', ok: false, errorCode: 'upstream-error' }),
        ],
      }),
      LOCALE,
    );
    expect(line.ok).toBe(false);
    expect(line.text).toContain('1 departure looked at');
    expect(line.text).toContain('1 refused (upstream-error)');
  });

  it('reports a look that found an empty board without inventing a price of zero', () => {
    const line = describeCollection(
      LIM_CUZ,
      report({ results: [result({ offers: 0, cheapest: null, currency: null })] }),
      LOCALE,
    );
    expect(line.text).toContain('no price quoted');
    expect(line.text).not.toContain('0.00');
  });

  it('does not read another route’s outcome as its own', () => {
    // A press carries one city pair, so this is belt and braces — but a row
    // that confidently reported someone else's fare would be worse than a blank.
    const line = describeCollection(
      LIM_CUZ,
      report({ results: [result({ destination: 'MAD' })] }),
      LOCALE,
    );
    expect(line.ok).toBe(false);
    expect(line.text).toBe('The pass came back without a word about this watch.');
  });

  /*
   * The inversion, split into three so it stays honest —
   * `a-pass-is-ours-if-it-names-any-of-our-months`.
   *
   * This was one test asserting that a neighbouring month on the same pair is
   * never ours. Half of that is now false, because a pair is one row and its
   * months are that row's. The other half is what stops the inversion from
   * becoming sloppy: membership is decided by `watching`, never by the
   * document. A month this row watches that the pass in hand was not asked
   * about is still not this pass's business.
   */
  it('does not read a month it does not watch, even on its own pair', () => {
    const line = describeCollection(
      LIM_CUZ,
      report({ results: [result({ flightDate: '2026-11-03' })] }),
      LOCALE,
    );
    expect(line.text).toBe('The pass came back without a word about this watch.');
  });

  it('does not read a month it watches that this pass is not covering', () => {
    // The row watches both; `watching` names only October, so November's
    // result belongs to whatever else asked for it.
    const line = describeCollection(
      { ...LIM_CUZ, months: ['2026-10', '2026-11'] },
      report({ results: [result({ flightDate: '2026-11-03' })] }),
      LOCALE,
    );
    expect(line.text).toBe('The pass came back without a word about this watch.');
  });

  it('reads a second month of its own pair when the pass names it too', () => {
    const line = describeCollection(
      { ...LIM_CUZ, months: ['2026-10', '2026-11'] },
      report({
        watching: ['LIM-CUZ 2026-10', 'LIM-CUZ 2026-11'],
        results: [result({}), result({ flightDate: '2026-11-03', cheapest: 210 })],
      }),
      LOCALE,
    );
    // Both months in one sentence, and the cheapest is the cheapest across
    // both — the full date is printed, so the winning month names itself.
    expect(line.text).toContain('2 departures looked at');
    expect(line.text).toContain('03/11/2026');
  });

  it('counts the skips by reason rather than naming thirty departures', () => {
    /*
     * A month can still come back entirely skipped, and since
     * `a-press-collects-the-month-it-is-on` the reasons that reach a press are
     * different ones. The row's own press no longer meets `not-due` — it
     * forces past the cadence, which is what settles 12.212 — but a scheduled
     * pass reported through the same document does, and `departed`,
     * `over-budget` and `another-pass-is-running` all still reach a press.
     *
     * Whatever the reason, it has to be said in one line: thirty-one dates in a
     * paragraph is a wall nobody reads.
     */
    const line = describeCollection(
      LIM_CUZ,
      report({
        collected: 0,
        skipped: [
          { what: 'LIM-CUZ 2026-10-01', reason: 'departed' },
          { what: 'LIM-CUZ 2026-10-17', reason: 'not-due' },
          { what: 'LIM-CUZ 2026-10-18', reason: 'not-due' },
          // Another month on the same pair. Not this row's business.
          { what: 'LIM-CUZ 2026-11-02', reason: 'not-due' },
        ],
      }),
      LOCALE,
    );
    expect(line.ok).toBe(false);
    expect(line.text).toBe('Not collected: 2 not-due, 1 departed.');
  });

  it('says the two things a forced press can still be refused for, in the server’s own words', () => {
    /*
     * `a-press-collects-the-month-it-is-on` lets the reader overrule the
     * cadence and nothing else. The day's ledger and the pass lock still stop a
     * press, and both were deliberately not given a new vocabulary for it: the
     * collector answers `over-budget` and `another-pass-is-running`, which are
     * the words a scheduled pass has always used, so this line needed no branch
     * to learn how to say them.
     *
     * Pinned here because "the word is already rendered" is the argument the
     * server side leans on, and an argument that nothing checks is a guess.
     */
    const spent = describeCollection(
      LIM_CUZ,
      report({
        collected: 0,
        skipped: [
          { what: 'LIM-CUZ 2026-10-17', reason: 'over-budget' },
          { what: 'LIM-CUZ 2026-10-18', reason: 'over-budget' },
        ],
      }),
      LOCALE,
    );
    expect(spent).toEqual({ ok: false, text: 'Not collected: 2 over-budget.' });

    const second = describeCollection(
      LIM_CUZ,
      report({
        collected: 0,
        skipped: [{ what: 'LIM-CUZ 2026-10-17', reason: 'another-pass-is-running' }],
      }),
      LOCALE,
    );
    expect(second).toEqual({ ok: false, text: 'Not collected: 1 another-pass-is-running.' });
  });

  it('says what it declined even on a pass that also collected something', () => {
    const line = describeCollection(
      LIM_CUZ,
      report({
        results: [result({ flightDate: '2026-10-17' })],
        skipped: [{ what: 'LIM-CUZ 2026-10-18', reason: 'not-due' }],
      }),
      LOCALE,
    );
    expect(line.text).toContain('1 not-due');
  });

  it('says so when the call never landed at all', () => {
    const line = describeRefusal('Request failed with status 502');
    expect(line.ok).toBe(false);
    expect(line.text).toBe('The call failed: Request failed with status 502');
  });
});

describe('the horizon collection an added route fires', () => {
  function horizon(overrides: Partial<CalendarCollectResponse> = {}): CalendarCollectResponse {
    return {
      state: 'finished',
      startedAt: '2026-08-19T15:49:00+00:00',
      finishedAt: '2026-08-19T15:49:04+00:00',
      source: 'google-flights',
      watching: ['LIM-CUZ'],
      completed: 1,
      windows: 2,
      windowsPriced: 2,
      requests: 2,
      dates: 331,
      collected: 1,
      changed: 1,
      failed: 0,
      results: [],
      skipped: [],
      error: null,
      ...overrides,
    };
  }

  it('reads a pass that fell over as the pass falling over, not as a refused route', () => {
    // Two different facts. A route the provider refused travels in `results`
    // with its own reason; a pass that fell over never got that far.
    const line = describeHorizon(
      LIM_CUZ,
      horizon({ state: 'failed', error: 'RuntimeError: boom' }),
    );
    expect(line.ok).toBe(false);
    expect(line.text).toBe(
      'The booking horizon pass failed: RuntimeError: boom. The route is watched either way.',
    );
  });

  it('says a pass that mentioned neither the route nor a reason said nothing', () => {
    // 8.8 again: a control that appears to do nothing is indistinguishable from
    // a broken one, so even the shape that should not arise gets a sentence.
    const line = describeHorizon(LIM_CUZ, horizon());
    expect(line.ok).toBe(false);
    expect(line.text).toContain('without a word about this route');
    expect(line.text).toContain('It is watched all the same');
  });

  describe('while it is still running', () => {
    it('promises no duration, because the one it used to promise was false', () => {
      // It said "two requests, about four seconds". Measured live on
      // 2026-08-21: three requests and twenty seconds, because a far window was
      // refused and walked back. Five times the promised wait reads as a broken
      // control, so nothing is promised and the pass reports itself instead.
      const line = describeHorizonProgress(
        LIM_CUZ,
        horizon({ state: 'running', windows: null, windowsPriced: 0, requests: 0, dates: 0 }),
      );
      expect(line.ok).toBe(true);
      expect(line.text).toBe('Collecting the booking horizon for LIM → CUZ…');
      expect(line.text).not.toContain('second');
    });

    it('counts windows and requests separately once the plan has settled', () => {
      const line = describeHorizonProgress(
        LIM_CUZ,
        horizon({ state: 'running', windows: 2, windowsPriced: 1, requests: 3, dates: 181 }),
      );
      // Three requests for one window is the retry showing through, which is
      // the thing that makes twenty seconds legible as work.
      expect(line.text).toBe(
        'Collecting LIM → CUZ: 1 of 2 windows priced in 3 requests, 181 departure dates so far.',
      );
    });

    it('says "none yet" rather than a count of zero dates', () => {
      const line = describeHorizonProgress(
        LIM_CUZ,
        horizon({ state: 'running', windows: 2, windowsPriced: 0, requests: 1, dates: 0 }),
      );
      expect(line.text).toContain('1 request,');
      expect(line.text).toContain('no departure dates yet');
    });

    it('will not report a stranger’s pass as this route’s own', () => {
      // The server keeps one calendar slot, so a press that arrives mid-pass is
      // answered with that pass. A row claiming it would be the quietest lie
      // this control could tell.
      const line = describeHorizonProgress(
        LIM_CUZ,
        horizon({ state: 'running', watching: ['ARI-SCL'] }),
      );
      expect(line.ok).toBe(false);
      expect(line.text).toContain('ARI-SCL');
      expect(line.text).toContain('this route is watched');
    });
  });
});
