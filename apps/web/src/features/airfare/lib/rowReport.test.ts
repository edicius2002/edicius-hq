import { describe, expect, it } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { describeCollection, describeRefusal } from '@/features/airfare/lib/rowReport';
import type { CollectResponse, CollectRouteResult } from '@/shared/api/fares';

const LIM_CUZ: FareRoute = {
  origin: 'LIM',
  destination: 'CUZ',
  month: '2026-10',
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
    // A press carries one month, so this is belt and braces — but a row that
    // confidently reported someone else's fare would be worse than a blank.
    const line = describeCollection(
      LIM_CUZ,
      report({ results: [result({ destination: 'MAD' })] }),
      LOCALE,
    );
    expect(line.ok).toBe(false);
    expect(line.text).toBe('The pass came back without a word about this month.');
  });

  it('does not read a neighbouring month on the same pair as its own', () => {
    const line = describeCollection(
      LIM_CUZ,
      report({ results: [result({ flightDate: '2026-11-03' })] }),
      LOCALE,
    );
    expect(line.text).toBe('The pass came back without a word about this month.');
  });

  it('counts the skips by reason rather than naming thirty departures', () => {
    /*
     * Since 12.111 a press runs the schedule, so a month already collected
     * today comes back entirely skipped — and on a daily cadence that is the
     * normal, healthy answer. It has to be said, and it has to be said in one
     * line: thirty-one dates in a paragraph is a wall nobody reads.
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
