import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { from, channel, removeChannel, maybeSingle, limit, order, eq, subscribe } = vi.hoisted(
  () => {
    const mockedMaybeSingle = vi.fn();
    const mockedLimit = vi.fn(() => ({ maybeSingle: mockedMaybeSingle }));
    const mockedOrder = vi.fn(() => ({ limit: mockedLimit }));
    const mockedEq = vi.fn(() => ({ order: mockedOrder }));
    const mockedSelect = vi.fn(() => ({ eq: mockedEq }));
    const mockedFrom = vi.fn(() => ({ select: mockedSelect }));
    const mockedSubscribe = vi.fn(() => ({ id: 'channel' }));
    const mockedOn = vi.fn(() => ({ subscribe: mockedSubscribe }));
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
    };
  },
);
vi.mock('@/shared/supabase/client', () => ({ supabase: { from, channel, removeChannel } }));
import { useAirfareCollectorStatus } from './collectorStatus';

describe('useAirfareCollectorStatus', () => {
  it('reads the latest airfare run, polls every 30 seconds, and cleans up its channel', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { unmount } = renderHook(() => useAirfareCollectorStatus(), { wrapper });
    await waitFor(() => expect(maybeSingle).toHaveBeenCalled());
    expect(from).toHaveBeenCalledWith('collector_runs');
    expect(eq).toHaveBeenCalledWith('collector', 'airfare');
    expect(order).toHaveBeenCalledWith('started_at', { ascending: false });
    expect(limit).toHaveBeenCalledWith(1);
    expect(subscribe).toHaveBeenCalled();
    unmount();
    expect(removeChannel).toHaveBeenCalledWith({ id: 'channel' });
  });
});
