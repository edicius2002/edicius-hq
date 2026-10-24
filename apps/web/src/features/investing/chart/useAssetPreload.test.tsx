import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getBars = vi.hoisted(() => vi.fn());
const getStoredBarsForSymbols = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());
const barCache = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@/shared/api/market', () => ({ getBars, getStoredBarsForSymbols }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { auth: { getSession } } }));
vi.mock('@/features/investing/data/marketBarCache', () => ({ marketBarCache: barCache }));

import { useAssetPreload } from './useAssetPreload';
import type { BarsResponse } from '@/shared/api/market';
import { sharedQueryWrapper } from '@/test/queryWrapper';

const saved = (symbol: string, timeframe: string): BarsResponse => ({
  symbol,
  timeframe,
  extended: false,
  hasSession: true,
  provider: 'yahoo',
  stale: true,
  capturedAt: 1_000,
  bars: [{ time: 1, open: 1, high: 2, low: 1, close: 2, volume: 3 }],
});

afterEach(() => {
  vi.clearAllMocks();
  getBars.mockReset();
  getStoredBarsForSymbols.mockReset();
});

getSession.mockResolvedValue({ data: { session: { user: { id: 'owner-a' } } } });
barCache.read.mockResolvedValue(null);
barCache.write.mockResolvedValue(undefined);

describe('useAssetPreload', () => {
  it('abandons an old grouped read when the selected asset changes', async () => {
    const wrapper = sharedQueryWrapper();
    let finishOld!: (value: BarsResponse[]) => void;
    getStoredBarsForSymbols.mockImplementation((symbols: string[]) =>
      symbols.includes('BNO')
        ? new Promise<BarsResponse[]>((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve([]),
    );
    const { rerender, unmount } = renderHook(
      ({ selected }) => useAssetPreload(['AAPL', 'BNO'], selected, '1d', false, true),
      { initialProps: { selected: 'AAPL' }, wrapper },
    );
    await waitFor(() => expect(getStoredBarsForSymbols).toHaveBeenCalledTimes(1));
    const oldSignal = getStoredBarsForSymbols.mock.calls[0][2] as AbortSignal;
    rerender({ selected: 'BNO' });
    expect(oldSignal.aborted).toBe(true);
    finishOld([saved('BNO', '1w')]);
    await waitFor(() => expect(getStoredBarsForSymbols).toHaveBeenCalledTimes(2));
    expect(wrapper.client.getQueryData(['market', 'bars', 'BNO', '1w', false])).toBeUndefined();
    unmount();
  });

  it('keeps provider requests sequential when two assets have no saved chart', async () => {
    const wrapper = sharedQueryWrapper();
    let finishFirst!: (value: BarsResponse) => void;
    getStoredBarsForSymbols.mockResolvedValue([]);
    getBars.mockImplementation((symbol: string, timeframe: string) =>
      symbol === 'BNO'
        ? new Promise<BarsResponse>((resolve) => {
            finishFirst = resolve;
          })
        : Promise.resolve(saved(symbol, timeframe)),
    );

    const { unmount } = renderHook(
      () => useAssetPreload(['AAPL', 'BNO', 'USO'], 'AAPL', '1d', false, true),
      { wrapper },
    );
    await waitFor(() => expect(getBars).toHaveBeenCalledTimes(1));
    expect(getBars.mock.calls[0][0]).toBe('BNO');
    finishFirst(saved('BNO', '1d'));
    await waitFor(() =>
      expect(getBars.mock.calls.map((call: unknown[]) => call[0] as string)).toEqual([
        'BNO',
        'USO',
      ]),
    );
    unmount();
  });

  it('hydrates other assets from grouped saved bars and fetches only missing current charts', async () => {
    const wrapper = sharedQueryWrapper();
    getStoredBarsForSymbols.mockResolvedValue([
      saved('BNO', '1d'),
      saved('BNO', '1w'),
      saved('USO', '1w'),
    ]);
    getBars.mockImplementation((symbol: string, timeframe: string) =>
      Promise.resolve(saved(symbol, timeframe)),
    );

    const { unmount } = renderHook(
      () => useAssetPreload(['AAPL', 'BNO', 'USO'], 'AAPL', '1d', false, true),
      { wrapper },
    );

    await waitFor(() =>
      expect(
        wrapper.client.getQueryData<BarsResponse>(['market', 'bars', 'BNO', '1w', false]),
      ).toMatchObject({ symbol: 'BNO', timeframe: '1w', stale: true }),
    );
    await waitFor(() =>
      expect(getBars).toHaveBeenCalledWith(
        'USO',
        '1d',
        false,
        expect.anything(),
        expect.anything(),
      ),
    );
    expect(getStoredBarsForSymbols).toHaveBeenCalledWith(
      ['BNO', 'USO'],
      false,
      expect.any(AbortSignal),
    );
    expect(getBars.mock.calls.map((call: unknown[]) => call[0] as string)).toEqual(['USO']);
    unmount();
  });

  it('does not start speculative work until the visible chart is ready', async () => {
    getStoredBarsForSymbols.mockResolvedValue([]);
    const { unmount } = renderHook(
      () => useAssetPreload(['AAPL', 'BNO'], 'AAPL', '1d', false, false),
      { wrapper: sharedQueryWrapper() },
    );
    expect(getStoredBarsForSymbols).not.toHaveBeenCalled();
    expect(getBars).not.toHaveBeenCalled();
    unmount();
  });
});
