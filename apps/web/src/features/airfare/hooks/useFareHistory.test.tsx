import { describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc } }));
import { fetchFareHistory } from '@/features/airfare/data/supabaseAirfare';

describe('useFareHistory transport', () => {
  it('uses the owner RPC and preserves filters', async () => {
    rpc.mockResolvedValue({ data: { snapshots: [] }, error: null });
    await fetchFareHistory('AQP', 'LIM', { departure: '2026-10-01', snapshotMonths: ['2026-10'] });
    expect(rpc).toHaveBeenCalledWith(
      'read_owner_airfare_history',
      expect.objectContaining({
        p_origin: 'AQP',
        p_destination: 'LIM',
        p_departure: '2026-10-01',
        p_snapshot_months: ['2026-10'],
      }),
    );
  });
});
