import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AirfareRequest } from '@/features/airfare/data/airfareRequests';

const api = vi.hoisted(() => {
  let receive: ((request: unknown) => void) | undefined;
  const dispose = vi.fn();
  return {
    enqueueAirfareRequest: vi.fn(),
    fetchActiveAirfareRequests: vi.fn(),
    fetchAirfareRequest: vi.fn(),
    subscribeAirfareRequests: vi.fn((callback: (request: unknown) => void) => {
      receive = callback;
      return dispose;
    }),
    emit: (request: unknown) => receive?.(request),
    dispose,
  };
});

vi.mock('@/features/airfare/data/airfareRequests', () => api);

import { useRouteCollection } from './useRouteCollection';

const ROUTE = {
  origin: 'LIM',
  destination: 'CUZ',
  months: ['2026-11'],
  currency: 'USD',
};
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function request(overrides: Partial<AirfareRequest> = {}): AirfareRequest {
  return {
    requestId: REQUEST_ID,
    payload: { origin: 'LIM', destination: 'CUZ', month: '2026-11', currency: 'USD' },
    progress: { stage: 'queued', completed: 0, total: null },
    status: 'queued',
    result: null,
    errorCode: null,
    createdAt: '2026-09-19T12:00:00.000Z',
    expiresAt: '2099-09-19T12:10:00.000Z',
    updatedAt: '2026-09-19T12:00:00.000Z',
    ...overrides,
  };
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useRouteCollection(), { wrapper }) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useRouteCollection', () => {
  it('adopts an active request and maps queued, collecting, and syncing progress', async () => {
    api.fetchActiveAirfareRequests.mockResolvedValue([request()]);
    const { result, unmount } = setup();

    await waitFor(() => expect(result.current.collecting).toEqual(['LIM-CUZ']));
    expect(result.current.progress.get('LIM-CUZ')).toEqual({
      completed: 0,
      polling: null,
      fraction: null,
    });

    act(() =>
      api.emit(
        request({
          status: 'running',
          progress: { stage: 'collecting', completed: 2, total: 5 },
        }),
      ),
    );
    expect(result.current.progress.get('LIM-CUZ')).toEqual({
      completed: 2,
      polling: 5,
      fraction: 0.4,
    });

    act(() =>
      api.emit(
        request({
          status: 'running',
          progress: { stage: 'syncing', completed: 3, total: 5 },
        }),
      ),
    );
    expect(result.current.progress.get('LIM-CUZ')).toEqual({
      completed: 5,
      polling: 5,
      fraction: 1,
    });
    act(() =>
      api.emit(
        request({
          status: 'running',
          progress: { stage: 'syncing', completed: 3, total: null },
        }),
      ),
    );
    expect(result.current.progress.get('LIM-CUZ')).toEqual({
      completed: 3,
      polling: 3,
      fraction: 1,
    });
    unmount();
    expect(api.dispose).toHaveBeenCalledOnce();
  });

  it('enqueues once, shows accepted/success notices, and invalidates completed data once', async () => {
    api.fetchActiveAirfareRequests.mockResolvedValue([]);
    api.enqueueAirfareRequest.mockResolvedValue(request());
    const { client, result } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await waitFor(() => expect(api.fetchActiveAirfareRequests).toHaveBeenCalled());

    act(() => result.current.collect(ROUTE, '2026-11'));
    await waitFor(() => expect(api.enqueueAirfareRequest).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.notices[0]?.kind).toBe('accepted'));

    const complete = request({
      status: 'complete',
      progress: { stage: 'syncing', completed: 5, total: 5 },
      result: {
        origin: 'LIM',
        destination: 'CUZ',
        month: '2026-11',
        lookedAt: 5,
        changed: 2,
        failed: 0,
        skipped: 0,
        synced: true,
      },
    });
    act(() => {
      api.emit(complete);
      api.emit(complete);
    });
    await waitFor(() => expect(result.current.notices[0]?.kind).toBe('success'));

    for (const queryKey of [
      ['fares', 'history', 'LIM', 'CUZ'],
      ['fares', 'calendar', 'LIM', 'CUZ'],
      ['fares', 'airports'],
    ]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(result.current.collecting).toEqual([]);
  });

  it('recovers missed terminal events by polling and exposes only safe failure/expiry copy', async () => {
    vi.useFakeTimers();
    api.fetchActiveAirfareRequests.mockResolvedValueOnce([request()]).mockResolvedValue([]);
    api.fetchAirfareRequest.mockResolvedValue(
      request({ status: 'failed', errorCode: 'provider_secret_detail' }),
    );
    const { result } = setup();
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(result.current.collecting).toEqual(['LIM-CUZ']);

    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(api.fetchAirfareRequest).toHaveBeenCalledWith(REQUEST_ID);
    expect(result.current.notices[0]).toMatchObject({
      id: REQUEST_ID,
      kind: 'error',
      text: 'Collection failed. Try again.',
    });
    expect(result.current.notices[0]?.text).not.toContain('provider_secret_detail');

    const expiring = request({ requestId: '22222222-2222-4222-8222-222222222222' });
    act(() => {
      api.emit(expiring);
      api.emit({ ...expiring, status: 'expired' });
    });
    expect(result.current.notices.at(-1)?.text).toBe('Collection request expired. Try again.');
  });

  it('forgets all state belonging to a removed route', async () => {
    api.fetchActiveAirfareRequests.mockResolvedValue([request()]);
    const { result } = setup();
    await waitFor(() => expect(result.current.collecting).toContain('LIM-CUZ'));
    act(() => result.current.forget('LIM-CUZ'));
    expect(result.current.collecting).toEqual([]);
    expect(result.current.progress.has('LIM-CUZ')).toBe(false);
  });
});
