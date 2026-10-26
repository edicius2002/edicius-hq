import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AirfareRequest } from '@/features/airfare/data/airfareRequests';
import { routeId } from '@/features/airfare/data/fareRoutes';

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
// The key every watchlist row, the map and the page look a route up by.
const ROW_ID = routeId(ROUTE);
const MONTH_KEY = 'LIM|CUZ|2026-11';
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
  it('reconciles idle requests once per minute while keeping active requests on five-second recovery', async () => {
    vi.useFakeTimers();
    api.fetchActiveAirfareRequests.mockResolvedValue([]);
    const { result } = setup();

    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(api.fetchActiveAirfareRequests).toHaveBeenCalledTimes(1);

    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(api.fetchActiveAirfareRequests).toHaveBeenCalledTimes(1);

    act(() => api.emit(request()));
    expect(result.current.collecting).toEqual([MONTH_KEY]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(api.fetchActiveAirfareRequests).toHaveBeenCalledTimes(2);

    act(() => api.emit(request({ status: 'failed' })));
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(api.fetchActiveAirfareRequests).toHaveBeenCalledTimes(2);
    await act(async () => void (await vi.advanceTimersByTimeAsync(55_000)));
    expect(api.fetchActiveAirfareRequests).toHaveBeenCalledTimes(3);
  });

  it('keeps simultaneous months of one route independent', async () => {
    api.fetchActiveAirfareRequests.mockResolvedValue([
      request({ progress: { stage: 'collecting', completed: 2, total: 5 }, status: 'running' }),
      request({
        requestId: '33333333-3333-4333-8333-333333333333',
        payload: { origin: 'LIM', destination: 'CUZ', month: '2026-12', currency: 'USD' },
        progress: { stage: 'syncing', completed: 1, total: 4 },
        status: 'running',
      }),
    ]);
    const { result, unmount } = setup();

    await waitFor(() =>
      expect(result.current.collecting).toEqual(['LIM|CUZ|2026-11', 'LIM|CUZ|2026-12']),
    );
    expect(result.current.progress.get('LIM|CUZ|2026-11')).toEqual({
      stage: 'collecting',
      completed: 2,
      total: 5,
    });
    expect(result.current.progress.get('LIM|CUZ|2026-12')).toEqual({
      stage: 'syncing',
      completed: 1,
      total: 4,
    });
    unmount();
  });

  it('blocks a second fetch of the same month before enqueue settles but allows another month', async () => {
    api.fetchActiveAirfareRequests.mockResolvedValue([]);
    api.enqueueAirfareRequest.mockImplementation(() => new Promise(() => {}));
    const { result, unmount } = setup();
    await waitFor(() => expect(api.fetchActiveAirfareRequests).toHaveBeenCalled());

    act(() => {
      result.current.collect(ROUTE, '2026-11');
      result.current.collect(ROUTE, '2026-11');
      result.current.collect(ROUTE, '2026-12');
    });

    expect(api.enqueueAirfareRequest).toHaveBeenCalledTimes(2);
    expect(result.current.collecting).toEqual(['LIM|CUZ|2026-11', 'LIM|CUZ|2026-12']);
    unmount();
  });

  it('keeps a new submission visible when an old request event arrives late', async () => {
    api.fetchActiveAirfareRequests.mockResolvedValue([]);
    api.enqueueAirfareRequest.mockImplementation(() => new Promise(() => {}));
    const { result, unmount } = setup();
    await waitFor(() => expect(api.fetchActiveAirfareRequests).toHaveBeenCalled());

    act(() => api.emit(request({ status: 'running' })));
    act(() => api.emit(request({ status: 'complete' })));
    act(() => result.current.collect(ROUTE, '2026-11'));
    expect(result.current.progress.get(MONTH_KEY)?.stage).toBe('submitting');

    act(() => api.emit(request({ status: 'running' })));
    expect(result.current.progress.get(MONTH_KEY)?.stage).toBe('submitting');
    unmount();
  });

  it('adopts an active request and maps queued, collecting, and syncing progress', async () => {
    api.fetchActiveAirfareRequests.mockResolvedValue([request()]);
    const { result, unmount } = setup();

    await waitFor(() => expect(result.current.collecting).toEqual([MONTH_KEY]));
    expect(result.current.progress.get(MONTH_KEY)).toEqual({
      stage: 'queued',
      completed: 0,
      total: null,
    });

    act(() =>
      api.emit(
        request({
          status: 'running',
          progress: { stage: 'collecting', completed: 2, total: 5 },
        }),
      ),
    );
    expect(result.current.progress.get(MONTH_KEY)).toEqual({
      stage: 'collecting',
      completed: 2,
      total: 5,
    });

    act(() =>
      api.emit(
        request({
          status: 'running',
          progress: { stage: 'syncing', completed: 3, total: 5 },
        }),
      ),
    );
    expect(result.current.progress.get(MONTH_KEY)).toEqual({
      stage: 'syncing',
      completed: 3,
      total: 5,
    });
    // A late row cannot make a known sync denominator disappear.
    act(() =>
      api.emit(
        request({
          status: 'running',
          progress: { stage: 'syncing', completed: 3, total: null },
        }),
      ),
    );
    expect(result.current.progress.get(MONTH_KEY)).toEqual({
      stage: 'syncing',
      completed: 3,
      total: 5,
    });
    unmount();
    expect(api.dispose).toHaveBeenCalledOnce();
  });

  it('keeps the newest database progress when Realtime and polling arrive out of order', async () => {
    api.fetchActiveAirfareRequests.mockResolvedValue([]);
    const { result, unmount } = setup();
    await waitFor(() => expect(api.fetchActiveAirfareRequests).toHaveBeenCalled());

    act(() =>
      api.emit(
        request({
          status: 'running',
          progress: { stage: 'collecting', completed: 4, total: 5 },
          updatedAt: '2026-09-19T12:02:00.000Z',
        }),
      ),
    );
    act(() =>
      api.emit(
        request({
          status: 'running',
          progress: { stage: 'collecting', completed: 1, total: 5 },
          updatedAt: '2026-09-19T12:01:00.000Z',
        }),
      ),
    );
    expect(result.current.progress.get(MONTH_KEY)).toEqual({
      stage: 'collecting',
      completed: 4,
      total: 5,
    });

    act(() =>
      api.emit(
        request({
          status: 'running',
          progress: { stage: 'collecting', completed: 4, total: null },
          updatedAt: '2026-09-19T12:02:00.000Z',
        }),
      ),
    );
    expect(result.current.progress.get(MONTH_KEY)).toEqual({
      stage: 'collecting',
      completed: 4,
      total: 5,
    });

    act(() =>
      api.emit(
        request({
          status: 'running',
          progress: { stage: 'syncing', completed: 0, total: null },
          updatedAt: '2026-09-19T12:03:00.000Z',
        }),
      ),
    );
    expect(result.current.progress.get(MONTH_KEY)).toEqual({
      stage: 'syncing',
      completed: 0,
      total: null,
    });
    unmount();
  });

  it('recovers collection and sync percentages by polling when Realtime is unavailable', async () => {
    vi.useFakeTimers();
    api.fetchActiveAirfareRequests
      .mockResolvedValueOnce([request()])
      .mockResolvedValueOnce([
        request({
          status: 'running',
          progress: { stage: 'collecting', completed: 2, total: 4 },
          updatedAt: '2026-09-19T12:01:00.000Z',
        }),
      ])
      .mockResolvedValueOnce([
        request({
          status: 'running',
          progress: { stage: 'syncing', completed: 1, total: 3 },
          updatedAt: '2026-09-19T12:02:00.000Z',
        }),
      ]);
    const { result, unmount } = setup();
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(result.current.progress.get(MONTH_KEY)).toEqual({
      stage: 'queued',
      completed: 0,
      total: null,
    });

    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(result.current.progress.get(MONTH_KEY)).toEqual({
      stage: 'collecting',
      completed: 2,
      total: 4,
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(result.current.progress.get(MONTH_KEY)).toEqual({
      stage: 'syncing',
      completed: 1,
      total: 3,
    });
    unmount();
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
    expect(result.current.notices[0]?.routeId).toBe(ROW_ID);
    expect(result.current.collecting).toEqual([MONTH_KEY]);

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
      ['fares', 'projection', 'LIM', 'CUZ'],
      ['fares', 'flightPage', 'LIM', 'CUZ'],
      ['fares', 'calendar', 'LIM', 'CUZ'],
      ['fares', 'airports'],
    ]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
    expect(invalidate).toHaveBeenCalledTimes(5);
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
    expect(result.current.collecting).toEqual([MONTH_KEY]);

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

  it('stops syncing when a request expires even if remote status and polling never settle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00.000Z'));
    api.fetchActiveAirfareRequests.mockResolvedValue([
      request({
        status: 'running',
        progress: { stage: 'syncing', completed: 3, total: 3 },
        expiresAt: '2026-09-19T12:00:01.000Z',
      }),
    ]);
    const { client, result } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(result.current.collecting).toEqual([MONTH_KEY]);

    await act(async () => void (await vi.advanceTimersByTimeAsync(1_001)));
    expect(result.current.collecting).toEqual([]);
    expect(result.current.progress.has(MONTH_KEY)).toBe(false);
    expect(result.current.notices.at(-1)?.text).toBe('Collection request expired. Try again.');

    act(() =>
      api.emit(
        request({
          status: 'complete',
          expiresAt: '2026-09-19T12:00:01.000Z',
          result: {
            origin: 'LIM',
            destination: 'CUZ',
            month: '2026-11',
            lookedAt: 3,
            changed: 2,
            failed: 0,
            skipped: 0,
            synced: true,
          },
        }),
      ),
    );
    expect(result.current.notices.at(-1)?.kind).toBe('success');
    expect(invalidate).toHaveBeenCalledTimes(5);
  });

  it('checks the database at local expiry so a missed completion still refreshes fares', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00.000Z'));
    api.fetchActiveAirfareRequests
      .mockResolvedValueOnce([
        request({
          status: 'running',
          progress: { stage: 'syncing', completed: 3, total: 3 },
          expiresAt: '2026-09-19T12:00:01.000Z',
        }),
      ])
      .mockResolvedValue([]);
    api.fetchAirfareRequest.mockResolvedValue(
      request({
        status: 'complete',
        progress: { stage: 'syncing', completed: 3, total: 3 },
        expiresAt: '2026-09-19T12:00:01.000Z',
        updatedAt: '2026-09-19T12:00:00.900Z',
        result: {
          origin: 'LIM',
          destination: 'CUZ',
          month: '2026-11',
          lookedAt: 3,
          changed: 2,
          failed: 0,
          skipped: 0,
          synced: true,
        },
      }),
    );
    const { client, result } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(result.current.collecting).toEqual([MONTH_KEY]);

    await act(async () => void (await vi.advanceTimersByTimeAsync(1_001)));
    expect(api.fetchAirfareRequest).toHaveBeenCalledWith(REQUEST_ID);
    expect(result.current.notices.at(-1)?.kind).toBe('success');
    expect(invalidate).toHaveBeenCalledTimes(5);
  });

  it('forgets all state belonging to a removed route', async () => {
    api.fetchActiveAirfareRequests.mockResolvedValue([request()]);
    const { result } = setup();
    await waitFor(() => expect(result.current.collecting).toContain(MONTH_KEY));
    act(() => result.current.forget(ROW_ID));
    expect(result.current.collecting).toEqual([]);
    expect(result.current.progress.has(MONTH_KEY)).toBe(false);
  });
});
