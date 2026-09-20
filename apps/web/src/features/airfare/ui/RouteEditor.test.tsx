import { describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc } }));
import { searchAirports } from '@/features/airfare/data/supabaseAirfare';

describe('RouteEditor airport search transport', () => {
  it('uses the owner airport search RPC', async () => {
    rpc.mockResolvedValue({ data: { query: 'lim', matches: [] }, error: null });
    await searchAirports('lim', { limit: 8 });
    expect(rpc).toHaveBeenCalledWith('search_owner_airports', { p_query: 'lim', p_limit: 8 });
  });
});
