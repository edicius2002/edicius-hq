import { describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc } }));
import { fetchFareCalendar } from '@/features/airfare/data/supabaseAirfare';

describe('useFareCalendar transport', () => {
  it('uses the owner calendar RPC', async () => {
    rpc.mockResolvedValue({ data: { horizon: null }, error: null });
    await fetchFareCalendar('AQP', 'LIM');
    expect(rpc).toHaveBeenCalledWith('read_owner_airfare_calendar', {
      p_origin: 'AQP',
      p_destination: 'LIM',
    });
  });
});
