import { describe, expect, it } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { horizonProgress } from '@/features/airfare/lib/horizonProgress';
import type { CalendarCollectResponse } from '@/shared/api/fares';

/**
 * The bar under a booking-horizon collection.
 *
 * What each case is about is a moment where a bar could say something false:
 * claiming a length it has not been told, going on claiming work after the work
 * has stopped, or drawing somebody else's pass as this row's.
 */

const LIM_SCL: FareRoute = {
  origin: 'LIM',
  destination: 'SCL',
  months: ['2027-03'],
  currency: 'USD',
};

function pass(overrides: Partial<CalendarCollectResponse> = {}): CalendarCollectResponse {
  return {
    state: 'running',
    startedAt: '2026-08-21T12:00:00+00:00',
    finishedAt: null,
    source: 'google-flights',
    watching: ['LIM-SCL'],
    completed: 0,
    windows: 2,
    windowsPriced: 0,
    requests: 1,
    dates: 0,
    collected: 0,
    changed: 0,
    failed: 0,
    results: [],
    skipped: [],
    error: null,
    ...overrides,
  };
}

describe('how far a booking-horizon pass has got', () => {
  it('divides windows priced by windows planned', () => {
    expect(horizonProgress(LIM_SCL, pass({ windowsPriced: 1, requests: 2, dates: 181 }))).toEqual({
      windows: 2,
      windowsPriced: 1,
      requests: 2,
      dates: 181,
      fraction: 0.5,
    });
  });

  it('reports requests above windows, because a refused window is asked again', () => {
    // 12.245: three requests buy two windows when the far end is walked back.
    // A bar that reported only one of the two figures could not tell a reader
    // whether the extra time was a retry or a hang.
    const bar = horizonProgress(LIM_SCL, pass({ windowsPriced: 1, requests: 3, dates: 181 }));
    expect(bar!.requests).toBe(3);
    expect(bar!.windowsPriced).toBe(1);
  });

  it('has no fraction while the plan has not settled', () => {
    // Not zero. A bar drawn at zero is claiming a denominator; this one has
    // none yet and has to be able to say so.
    const bar = horizonProgress(LIM_SCL, pass({ windows: null }));
    expect(bar).not.toBeNull();
    expect(bar!.fraction).toBeNull();
    expect(bar!.windows).toBeNull();
  });

  it('draws nothing once the pass has stopped', () => {
    expect(horizonProgress(LIM_SCL, pass({ state: 'finished', windowsPriced: 2 }))).toBeNull();
    expect(horizonProgress(LIM_SCL, pass({ state: 'failed' }))).toBeNull();
    expect(horizonProgress(LIM_SCL, pass({ state: 'idle' }))).toBeNull();
  });

  it('draws nothing for a pass that belongs to another route', () => {
    // The server keeps one calendar slot, so a press that met a running pass is
    // answered with it. The row says so in words; a bar would be a picture
    // contradicting that sentence.
    expect(horizonProgress(LIM_SCL, pass({ watching: ['ARI-SCL'] }))).toBeNull();
  });

  it('draws nothing where the plan settled at no windows at all', () => {
    // Every pair collected inside its cadence. There is no bar that fills from
    // zero to zero, and "not collected again — not-due" is the whole story.
    expect(horizonProgress(LIM_SCL, pass({ windows: 0 }))).toBeNull();
  });

  it('matches on the city pair and not on the month, because a curve has none', () => {
    const april: FareRoute = { ...LIM_SCL, months: ['2027-04'] };
    expect(horizonProgress(april, pass())).not.toBeNull();
  });
});
