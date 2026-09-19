import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import rawFixture from '../../../../../../fixtures/airfare-history-pagination/v1.json?raw';
import { useFareHistory } from './useFareHistory';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc } }));

const route = {
  origin: 'AQP',
  destination: 'LIM',
  months: ['2026-11', '2026-12'],
  currency: 'USD',
};
const key = ['fares', 'history', 'AQP', 'LIM', '2026-11', '2026-11,2026-12'];

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 1000 } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('useFareHistory complete reads', () => {
  it('does not multiply three internal attempts with QueryClient retry defaults', async () => {
    vi.useFakeTimers();
    rpc.mockImplementation(() => ({
      abortSignal: () =>
        Promise.resolve({
          data: null,
          error: { code: '40001', message: 'airfare_history_revision_changed' },
        }),
    }));
    const { client, wrapper } = setup();
    const { unmount } = renderHook(() => useFareHistory(route, '2026-11'), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(client.getQueryState(key)?.status).toBe('error');
    expect(client.getQueryData(key)).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(3);
    unmount();
    client.clear();
  });

  it('keeps prior complete cached data on late failure without exposing partial pages', async () => {
    vi.useFakeTimers();
    const fixture = JSON.parse(rawFixture);
    const responses = [fixture.meta, fixture.snapshotPages[0]];
    rpc.mockImplementation(() => ({
      abortSignal: () =>
        Promise.resolve(
          responses.length
            ? { data: responses.shift(), error: null }
            : { data: null, error: { code: '503', message: 'unavailable' } },
        ),
    }));
    const { client, wrapper } = setup();
    const previous = { ...fixture.expected, snapshots: [] };
    client.setQueryData(key, previous, { updatedAt: Date.now() - 61_000 });
    const { unmount } = renderHook(() => useFareHistory(route, '2026-11'), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(client.getQueryState(key)?.status).toBe('error');
    expect(client.getQueryData(key)).toEqual(previous);
    expect(
      rpc.mock.calls.filter(([name]) => name === 'read_owner_airfare_history_meta'),
    ).toHaveLength(1);
    expect(rpc).toHaveBeenCalledTimes(4);
    unmount();
    client.clear();
  });

  it('forwards unmount cancellation to both active RPCs and starts no subsequent page', async () => {
    const fixture = JSON.parse(rawFixture);
    const signals: AbortSignal[] = [];
    rpc.mockImplementation(() => ({
      abortSignal: (signal: AbortSignal) => {
        signals.push(signal);
        if (signals.length === 1) return Promise.resolve({ data: fixture.meta, error: null });
        return new Promise(() => undefined);
      },
    }));
    const { client, wrapper } = setup();
    const { unmount } = renderHook(() => useFareHistory(route, '2026-11'), { wrapper });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(signals).toHaveLength(3);
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(signals[1].aborted).toBe(true);
    expect(signals[2].aborted).toBe(true);
    expect(client.getQueryData(key)).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(3);
    client.clear();
  });
});
