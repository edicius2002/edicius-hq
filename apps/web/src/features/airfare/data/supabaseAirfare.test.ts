import { afterEach, describe, expect, it, vi } from 'vitest';
import rawFixture from '../../../../../../fixtures/airfare-history-pagination/v1.json?raw';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc } }));

import {
  fetchAirports,
  fetchFareCalendar,
  fetchFareHistory,
  searchAirports,
} from '@/features/airfare/data/supabaseAirfare';

afterEach(() => vi.clearAllMocks());

describe('Supabase Airfare reads', () => {
  it('reads history through the owner-gated RPC with the existing filter shape', async () => {
    const history = JSON.parse(rawFixture) as {
      meta: unknown;
      snapshotPages: unknown[];
      baselinePages: unknown[];
      expected: unknown;
    };
    const responses = [
      history.meta,
      history.snapshotPages[0],
      history.baselinePages[0],
      ...history.snapshotPages.slice(1),
      ...history.baselinePages.slice(1),
      history.meta,
    ];
    const signals: AbortSignal[] = [];
    rpc.mockImplementation(() => ({
      abortSignal: (signal: AbortSignal) => {
        signals.push(signal);
        return Promise.resolve({ data: responses.shift(), error: null });
      },
    }));
    const controller = new AbortController();

    await expect(
      fetchFareHistory('AQP', 'LIM', {
        departure: '2026-11',
        snapshotMonths: ['2026-11'],
        signal: controller.signal,
      }),
    ).resolves.toEqual(history.expected);
    expect(rpc).toHaveBeenNthCalledWith(1, 'read_owner_airfare_history_meta', {
      p_origin: 'AQP',
      p_destination: 'LIM',
      p_departure: '2026-11',
      p_snapshot_months: ['2026-11'],
      p_since: '',
      p_until: '',
    });
    expect(signals).toHaveLength(5);
    expect(new Set(signals).size).toBe(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(new Set(signals.slice(1, 4)).size).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('does not restart a different 40001 or expose arbitrary server details', async () => {
    rpc.mockReturnValue({
      abortSignal: () =>
        Promise.resolve({
          data: null,
          error: { code: '40001', message: 'private-server-message', details: 'private-key' },
        }),
    });
    await expect(fetchFareHistory('AQP', 'LIM')).rejects.toThrow(
      'Airfare data request failed (40001).',
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('uses the owner-gated airport search RPC and preserves its wire response', async () => {
    const result = { query: 'lima', matches: [] };
    rpc.mockResolvedValue({ data: result, error: null });

    await expect(searchAirports('lima', { limit: 8 })).resolves.toBe(result);
    expect(rpc).toHaveBeenCalledWith('search_owner_airports', { p_query: 'lima', p_limit: 8 });
  });

  it('reads map coordinates through the owner-gated Supabase RPC', async () => {
    const result = {
      airports: [
        {
          code: 'AQP',
          name: 'Rodriguez Ballon',
          city: 'Arequipa',
          country: 'Peru',
          latitude: -16.341,
          longitude: -71.583,
        },
      ],
    };
    rpc.mockResolvedValue({ data: result, error: null });

    await expect(fetchAirports(['AQP', 'LIM'])).resolves.toBe(result);
    expect(rpc).toHaveBeenCalledWith('read_owner_fare_airports', {
      p_codes: ['AQP', 'LIM'],
    });
  });

  it('surfaces owner RPC errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_edicius_owner' } });

    await expect(fetchFareCalendar('AQP', 'LIM')).rejects.toThrow(
      'Airfare data request failed (42501).',
    );
  });
});
