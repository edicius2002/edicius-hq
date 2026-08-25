import { describe, expect, it } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import {
  MAX_NOTICES,
  collectNotice,
  withNotice,
  withoutNotice,
  type CollectNotice,
} from '@/features/airfare/lib/collectNotice';
import type { CollectResponse, CollectRouteResult } from '@/shared/api/fares';

const LIM_CUZ: FareRoute = {
  origin: 'LIM',
  destination: 'CUZ',
  months: ['2026-10'],
  currency: 'USD',
};

const LIM_MAD: FareRoute = {
  origin: 'LIM',
  destination: 'MAD',
  months: ['2026-12'],
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

function pass(overrides: Partial<CollectResponse> = {}): CollectResponse {
  return {
    state: 'finished',
    startedAt: '2026-08-19T14:00:00+00:00',
    finishedAt: '2026-08-19T14:00:06+00:00',
    source: 'google',
    watching: ['LIM-CUZ 2026-10'],
    polling: 1,
    completed: 1,
    collected: 1,
    changed: 0,
    failed: 0,
    results: [result()],
    skipped: [],
    error: null,
    ...overrides,
  };
}

/** Pinned, because the price inside the sentence follows the browser's locale. */
const LOCALE = 'en-US';

function notice(id: string, ok = true): CollectNotice {
  return { id, title: id, report: { ok, text: id } };
}

describe('what a finished press puts in front of the reader', () => {
  it('carries the row’s own sentence, word for word', () => {
    // Deliberately the same text as the line under the row rather than a
    // second wording of it: two sentences about one pass would drift, and the
    // one in `rowReport` is the one with a suite behind it.
    const raised = collectNotice(
      LIM_CUZ,
      pass({
        results: [
          result({ flightDate: '2026-10-17', cheapest: 412 }),
          result({ flightDate: '2026-10-21', cheapest: 380 }),
        ],
      }),
      LOCALE,
    );

    expect(raised?.report.text).toBe(
      'Collected: 2 departures looked at, cheapest $380.00 on 21/10/2026 — nothing new to record.',
    );
    expect(raised?.report.ok).toBe(true);
  });

  it('names the watch it is about', () => {
    // The card floats clear of the list, so unlike the row's own line it has
    // nothing beside it to say which of eight watches just finished.
    const raised = collectNotice(LIM_CUZ, pass(), LOCALE);
    expect(raised?.title).toBe('LIM → CUZ · October 2026');
  });

  it('says so when the board did not move', () => {
    // The whole reason a quiet pass still raises one: "ran and changed
    // nothing" and "did not run" are the two states a reader cannot tell
    // apart, and silence is how they stop trusting the control.
    const raised = collectNotice(LIM_CUZ, pass({ results: [result({ changed: false })] }), LOCALE);
    expect(raised?.report.text).toContain('nothing new to record');
  });

  it('says nothing while the pass is still running', () => {
    // A card that appeared on the first frame would be gone before the pass
    // it announced had finished. The row's own line reports progress; this
    // reports outcomes.
    expect(collectNotice(LIM_CUZ, pass({ state: 'running', finishedAt: null }), LOCALE)).toBeNull();
  });

  it('says nothing about a pass this row did not start', () => {
    // The scheduled collector runs every fifteen minutes with nobody watching
    // — and a press made while it is running is answered with *that* pass
    // (12.210). Neither is news the reader asked for, and `isOurPass` is the
    // one question that tells them apart.
    const foreign = pass({ watching: ['ARI-SCL 2027-03'] });
    expect(collectNotice(LIM_CUZ, foreign, LOCALE)).toBeNull();
  });

  it('raises a pass that fell over, marked as a refusal', () => {
    // A press that failed is exactly the outcome worth putting in front of
    // someone who has looked away from the row.
    const raised = collectNotice(
      LIM_CUZ,
      pass({ state: 'failed', error: 'upstream said no' }),
      LOCALE,
    );
    expect(raised?.report.ok).toBe(false);
    expect(raised?.report.text).toContain('upstream said no');
  });
});

describe('how the cards share the corner', () => {
  it('stacks one row’s card beside another’s, newest last', () => {
    // Two rows can be collecting at once — the server runs one pass and both
    // follow it — so a second outcome must not swallow the first.
    const stack = withNotice(withNotice([], notice('a')), notice('b'));
    expect(stack.map((card) => card.id)).toEqual(['a', 'b']);
  });

  it('lets a row replace its own card rather than pile a second one on it', () => {
    // A row has one latest outcome by definition. Two cards for one watch
    // would be the older one arguing with the newer, which is the fault the
    // row list already avoids by clearing its line on every press.
    const stack = withNotice(withNotice(withNotice([], notice('a')), notice('b')), {
      ...notice('a'),
      report: { ok: false, text: 'refused' },
    });
    expect(stack.map((card) => card.id)).toEqual(['b', 'a']);
    expect(stack.at(-1)?.report.text).toBe('refused');
  });

  it('keeps the corner to a few cards, dropping the oldest', () => {
    // A watchlist is eight rows and each press is minutes long, so this is a
    // ceiling rather than a routine — but a stack that grew without one would
    // walk off the top of the window, where a card cannot be read at all.
    const stack = ['a', 'b', 'c', 'd', 'e'].reduce(
      (current, id) => withNotice(current, notice(id)),
      [] as readonly CollectNotice[],
    );
    expect(stack).toHaveLength(MAX_NOTICES);
    expect(stack.map((card) => card.id)).toEqual(['c', 'd', 'e']);
  });

  it('takes a card back out by the row it belongs to', () => {
    const stack = withoutNotice(withNotice(withNotice([], notice('a')), notice('b')), 'a');
    expect(stack.map((card) => card.id)).toEqual(['b']);
  });

  it('leaves the stack alone when there is nothing of that row’s to take out', () => {
    // Identity, not just contents: this answer is React state, and a fresh
    // array on every dismissal that matched nothing would re-render the page
    // for no change.
    const stack = withNotice([], notice('a'));
    expect(withoutNotice(stack, LIM_MAD.origin)).toBe(stack);
  });
});
