import { describe, expect, it } from 'vitest';

import type { AirfareRequest } from '@/features/airfare/data/airfareRequests';
import { routeId } from '@/features/airfare/data/fareRoutes';
import {
  MAX_NOTICES,
  acceptedCollectNotice,
  terminalCollectNotice,
  withNotice,
  withoutNotice,
  type CollectNotice,
} from '@/features/airfare/lib/collectNotice';

function request(overrides: Partial<AirfareRequest> = {}): AirfareRequest {
  return {
    requestId: 'request-1',
    payload: { origin: 'LIM', destination: 'CUZ', month: '2026-11', currency: 'USD' },
    progress: { stage: 'queued', completed: 0, total: null },
    status: 'queued',
    result: null,
    errorCode: null,
    createdAt: '2026-09-19T12:00:00Z',
    expiresAt: '2026-09-19T12:10:00Z',
    updatedAt: '2026-09-19T12:00:00Z',
    ...overrides,
  };
}

function notice(id: string): CollectNotice {
  return {
    id,
    routeId: 'LIM-CUZ',
    title: id,
    text: id,
    kind: 'success',
  };
}

describe('Pi Airfare request notices', () => {
  it('uses request ids and fixed accepted copy', () => {
    expect(acceptedCollectNotice(request())).toMatchObject({
      id: 'request-1',
      // The watchlist's key, so removing a watch can find its cards.
      routeId: routeId({ origin: 'LIM', destination: 'CUZ' }),
      title: 'LIM → CUZ · November 2026',
      text: 'Collection request accepted by the Pi.',
      kind: 'accepted',
    });
  });

  it('summarizes only the safe completed counts', () => {
    const completed = terminalCollectNotice(
      request({
        status: 'complete',
        result: {
          origin: 'LIM',
          destination: 'CUZ',
          month: '2026-11',
          lookedAt: 4,
          changed: 2,
          failed: 1,
          skipped: 1,
          synced: true,
        },
      }),
    );
    expect(completed).toMatchObject({
      kind: 'success',
      text: 'Collection complete: 4 departures checked, 2 updated.',
    });
  });

  it('does not expose collector failure codes', () => {
    const failed = terminalCollectNotice(
      request({ status: 'failed', errorCode: 'provider_secret_detail' }),
    );
    expect(failed).toMatchObject({ kind: 'error', text: 'Collection failed. Try again.' });
    expect(failed?.text).not.toContain('provider_secret_detail');
    expect(terminalCollectNotice(request({ status: 'expired' }))?.text).toContain('expired');
  });

  it('replaces a request card, bounds the stack, and removes by request id', () => {
    const stack = ['a', 'b', 'c', 'd'].reduce(
      (current, id) => withNotice(current, notice(id)),
      [] as readonly CollectNotice[],
    );
    expect(stack).toHaveLength(MAX_NOTICES);
    expect(stack.map((item) => item.id)).toEqual(['b', 'c', 'd']);
    const replaced = withNotice(stack, { ...notice('c'), kind: 'error' });
    expect(replaced.map((item) => item.id)).toEqual(['b', 'd', 'c']);
    expect(withoutNotice(replaced, 'd').map((item) => item.id)).toEqual(['b', 'c']);
  });
});
