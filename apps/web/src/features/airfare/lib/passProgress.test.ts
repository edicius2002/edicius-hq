import { describe, expect, it } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { passProgress } from '@/features/airfare/lib/passProgress';
import type { CollectResponse } from '@/shared/api/fares';

const ROUTE: FareRoute = {
  origin: 'LIM',
  destination: 'SCL',
  month: '2027-03',
  currency: 'USD',
};

/** A pass over this row's own month, at whatever point in it the test needs. */
function pass(overrides: Partial<CollectResponse> = {}): CollectResponse {
  return {
    state: 'running',
    startedAt: '2026-08-20T14:00:00+00:00',
    finishedAt: null,
    source: 'google',
    watching: ['LIM-SCL 2027-03'],
    polling: 31,
    completed: 0,
    collected: 0,
    changed: 0,
    failed: 0,
    results: [],
    skipped: [],
    error: null,
    ...overrides,
  };
}

describe('the fraction a running pass has covered', () => {
  it('divides what has come back by what the pass means to poll', () => {
    const progress = passProgress(ROUTE, pass({ completed: 4 }));
    expect(progress).toEqual({ completed: 4, polling: 31, fraction: 4 / 31 });
  });

  it('has no fraction while the plan is still being settled', () => {
    // `polling` lands before the first upstream request and not before the
    // press returns, so there is a window — one poll of the row, two seconds —
    // in which the pass is running and its denominator is unknown. Zero would
    // be a bar claiming a length it has not got.
    expect(passProgress(ROUTE, pass({ polling: null }))).toEqual({
      completed: 0,
      polling: null,
      fraction: null,
    });
  });

  it('reaches exactly one on the last departure', () => {
    expect(passProgress(ROUTE, pass({ completed: 31 }))?.fraction).toBe(1);
  });
});

describe('the passes a row draws no bar for', () => {
  it('draws nothing once the pass has stopped running', () => {
    // A finished pass is reported in words. A bar left standing at full would
    // go on claiming work after the work has ended.
    for (const state of ['finished', 'failed', 'idle'] as const) {
      expect(passProgress(ROUTE, pass({ state, completed: 31 }))).toBeNull();
    }
  });

  it('draws nothing for a pass this row did not start', () => {
    // The server keeps one slot, so a press that lands during a pass is
    // answered with that pass — 12.210. The row says so in a sentence, and a
    // bar beside it would be that sentence contradicted by a picture.
    const somebodyElses = pass({ watching: ['ARI-SCL 2027-01'], completed: 9 });
    expect(passProgress(ROUTE, somebodyElses)).toBeNull();
  });

  it('draws nothing where the plan settled at no departures at all', () => {
    // The ordinary outcome of a second press inside the cadence: every day of
    // the month was looked at today already. There is no bar that fills from
    // zero to zero, and "Not collected: 31 not-due" is the whole of it.
    expect(passProgress(ROUTE, pass({ polling: 0 }))).toBeNull();
  });
});
