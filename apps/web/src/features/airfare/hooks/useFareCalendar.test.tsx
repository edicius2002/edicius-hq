import { describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc } }));
import { fetchFareCalendar } from '@/features/airfare/data/supabaseAirfare';
import { fetchFareCalendar as fetchCalendar } from '@/shared/api/fares';

describe('useFareCalendar transport', () => {
  it('propagates cancellation through the public wrapper and rejects late responses', async () => {
    const controller = new AbortController();
    const abortSignal = vi.fn(async () => {
      controller.abort();
      return { data: { horizon: null }, error: null };
    });
    rpc.mockReturnValue({ abortSignal });
    await expect(fetchCalendar('AQP', 'LIM', { signal: controller.signal })).rejects.toThrow();
    expect(abortSignal).toHaveBeenCalledWith(controller.signal);
  });
  it('uses the owner calendar RPC', async () => {
    rpc.mockResolvedValue({ data: { horizon: null }, error: null });
    await fetchFareCalendar('AQP', 'LIM');
    expect(rpc).toHaveBeenCalledWith('read_owner_airfare_calendar', {
      p_origin: 'AQP',
      p_destination: 'LIM',
    });
  });
});
