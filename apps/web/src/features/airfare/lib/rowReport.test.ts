import { describe, expect, it } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { describeCollection, describeRefusal } from '@/features/airfare/lib/rowReport';
import type { CollectResponse, CollectRouteResult } from '@/shared/api/fares';

const LIM_CUZ: FareRoute = {
  origin: 'LIM',
  destination: 'CUZ',
  flightDate: '2026-10-17',
  returnDate: null,
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
    startedAt: '2026-08-19T14:00:00+00:00',
    finishedAt: '2026-08-19T14:00:06+00:00',
    source: 'google',
    collected: 1,
    changed: 0,
    failed: 0,
    results: [],
    skipped: [],
    ...overrides,
  };
}

/** Pinned, because `money` follows the browser's locale by design. */
const LOCALE = 'en-US';

describe('what a row says after its own collection', () => {
  it('reports the flights, the cheapest fare and that nothing had moved', () => {
    // Most successful looks write no snapshot — the board rarely moves between
    // polls — and a reader who is not told that reads a flat series as a
    // collector that stopped.
    const line = describeCollection(LIM_CUZ, report({ results: [result()] }), LOCALE);
    expect(line.ok).toBe(true);
    expect(line.text).toBe('Collected: 14 flights, cheapest $412.00 — nothing new to record.');
  });

  it('says when the look actually wrote a snapshot', () => {
    const line = describeCollection(
      LIM_CUZ,
      report({ results: [result({ changed: true })] }),
      LOCALE,
    );
    expect(line.text).toContain('a new snapshot');
  });

  it('mentions the provider history a first look folds in', () => {
    // Non-zero essentially only the first time a departure is watched, and it
    // is the one collection that makes the chart appear rather than tick.
    const line = describeCollection(
      LIM_CUZ,
      report({ results: [result({ seeded: 60, changed: true })] }),
      LOCALE,
    );
    expect(line.text).toContain("60 days of the provider's own history seeded");
  });

  it('carries a refusal with its code and its reason', () => {
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

  it('reports a look that found an empty board without inventing a price of zero', () => {
    const line = describeCollection(
      LIM_CUZ,
      report({ results: [result({ offers: 0, cheapest: null, currency: null })] }),
      LOCALE,
    );
    expect(line.text).toContain('0 flights');
    expect(line.text).toContain('no price quoted');
    expect(line.text).not.toContain('0.00');
  });

  it('does not read another route’s outcome as its own', () => {
    // A press carries one route, so this is belt and braces — but a row that
    // confidently reported someone else's fare would be worse than a blank.
    const line = describeCollection(
      LIM_CUZ,
      report({ results: [result({ destination: 'MAD' })] }),
      LOCALE,
    );
    expect(line.ok).toBe(false);
    expect(line.text).toBe('The pass came back without a word about this route.');
  });

  it('passes on a skip the server chose to make, rather than showing nothing', () => {
    /*
     * `POST /api/fares/collect` runs the unconditional `collect`, so today it
     * cannot skip anything it is handed — a press bypasses the cadence by
     * construction. The branch exists so that if it ever starts honouring the
     * schedule, the button says why it did nothing instead of appearing broken.
     */
    const line = describeCollection(
      LIM_CUZ,
      report({
        collected: 0,
        skipped: [{ what: 'LIM-CUZ 2026-10-17', reason: 'not due for 22 minutes' }],
      }),
      LOCALE,
    );
    expect(line.ok).toBe(false);
    expect(line.text).toBe('Not collected: not due for 22 minutes.');
  });

  it('says so when the call never landed at all', () => {
    const line = describeRefusal('Request failed with status 502');
    expect(line.ok).toBe(false);
    expect(line.text).toBe('The call failed: Request failed with status 502');
  });
});
