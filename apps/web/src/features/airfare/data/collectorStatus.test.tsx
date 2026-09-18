import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { from, channel, removeChannel, maybeSingle, limit, order, eq, subscribe, callback } =
  vi.hoisted(() => {
    const mockedMaybeSingle = vi.fn();
    const mockedLimit = vi.fn(() => ({ maybeSingle: mockedMaybeSingle }));
    const mockedOrder = vi.fn(() => ({ limit: mockedLimit }));
    const mockedEq = vi.fn(() => ({ order: mockedOrder }));
    const mockedSelect = vi.fn(() => ({ eq: mockedEq }));
    const mockedFrom = vi.fn(() => ({ select: mockedSelect }));
    const mockedSubscribe = vi.fn(() => ({ id: 'channel' }));
    let realtimeCallback: (() => void) | undefined;
    const mockedOn = vi.fn((_event, _filter, next) => {
      realtimeCallback = next;
      return { subscribe: mockedSubscribe };
    });
    const mockedChannel = vi.fn(() => ({ on: mockedOn }));
    return {
      from: mockedFrom,
      channel: mockedChannel,
      removeChannel: vi.fn(),
      maybeSingle: mockedMaybeSingle,
      limit: mockedLimit,
      order: mockedOrder,
      eq: mockedEq,
      select: mockedSelect,
      subscribe: mockedSubscribe,
      on: mockedOn,
      callback: () => realtimeCallback?.(),
    };
  });
vi.mock('@/shared/supabase/client', () => ({ supabase: { from, channel, removeChannel } }));
import { useAirfareCollectorStatus } from './collectorStatus';

describe('useAirfareCollectorStatus', () => {
  it('refetches on relevant realtime changes, every 30 seconds, and cleans up its channel', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { unmount } = renderHook(() => useAirfareCollectorStatus(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(maybeSingle).toHaveBeenCalled();
    expect(from).toHaveBeenCalledWith('collector_runs');
    expect(eq).toHaveBeenCalledWith('collector', 'airfare');
    expect(order).toHaveBeenCalledWith('started_at', { ascending: false });
    expect(limit).toHaveBeenCalledWith(1);
    expect(subscribe).toHaveBeenCalled();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await act(async () => callback());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['collector-runs', 'airfare'] });
    const before = maybeSingle.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(maybeSingle.mock.calls.length).toBeGreaterThan(before);
    unmount();
    expect(removeChannel).toHaveBeenCalledWith({ id: 'channel' });
    vi.useRealTimers();
  });
});
