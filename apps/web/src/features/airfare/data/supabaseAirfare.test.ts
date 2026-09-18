import { afterEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc } }));

import {
  fetchFareCalendar,
  fetchFareHistory,
  searchAirports,
} from '@/features/airfare/data/supabaseAirfare';

afterEach(() => vi.clearAllMocks());

describe('Supabase Airfare reads', () => {
  it('reads history through the owner-gated RPC with the existing filter shape', async () => {
    const history = { snapshots: [], baselines: [], health: [], airports: [] };
    rpc.mockResolvedValue({ data: history, error: null });

    await expect(
      fetchFareHistory('AQP', 'LIM', { departure: '2026-10-01', snapshotMonths: ['2026-10'] }),
    ).resolves.toBe(history);
    expect(rpc).toHaveBeenCalledWith('read_owner_airfare_history', {
      p_origin: 'AQP',
      p_destination: 'LIM',
      p_departure: '2026-10-01',
      p_snapshot_months: ['2026-10'],
      p_since: '',
      p_until: '',
    });
  });

  it('uses the owner-gated airport search RPC and preserves its wire response', async () => {
    const result = { query: 'lima', matches: [] };
    rpc.mockResolvedValue({ data: result, error: null });

    await expect(searchAirports('lima', { limit: 8 })).resolves.toBe(result);
    expect(rpc).toHaveBeenCalledWith('search_owner_airports', { p_query: 'lima', p_limit: 8 });
  });

  it('surfaces owner RPC errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_edicius_owner' } });

    await expect(fetchFareCalendar('AQP', 'LIM')).rejects.toThrow(
      'Airfare data request failed (42501).',
    );
  });
});
