import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getBars = vi.hoisted(() => vi.fn());
const focus = vi.hoisted(() => vi.fn());
const barCache = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api/market', () => ({ getBars }));
vi.mock('@/features/investing/hooks/useChartFocus', () => ({ useChartFocus: focus }));
vi.mock('@/features/investing/data/marketBarCache', () => ({ marketBarCache: barCache }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { auth: { getSession } } }));

import { candleRefetchInterval, useCandles } from '@/features/investing/chart/useCandles';
import type { Tick } from '@/features/investing/data/quoteStream';
import type { LiveBarUpdate } from '@/features/investing/data/liveBars';
import type { BarsResponse } from '@/shared/api/market';
import { queryWrapper, sharedQueryWrapper } from '@/test/queryWrapper';

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

getSession.mockResolvedValue({ data: { session: { user: { id: 'owner-a' } } }, error: null });
barCache.read.mockResolvedValue(null);
barCache.write.mockResolvedValue(undefined);

const BASE_TIME = Date.parse('2026-08-07T13:30:00Z') / 1000;
const history = { time: BASE_TIME, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 };

const barsResponse = {
  symbol: 'SPCX',
  timeframe: '15m',
  provider: 'yahoo',
  extended: false,
  hasSession: true,
  stale: false,
  bars: [history],
};
const live: LiveBarUpdate = {
  symbol: 'SPCX',
  timeframe: '15m',
  extended: false,
  asOf: BASE_TIME + 90,
  bar: { ...history, close: 1.7, high: 1.8, volume: 80 },
};
const tick: Tick = {
  symbol: 'SPCX',
  time: BASE_TIME + 100,
  price: 1.9,
  marketState: 'REGULAR',
  extended: false,
  changePercent: null,
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useCandles', () => {
  it('reuses a recent daily series when switching back to an asset', async () => {
    const wrapper = sharedQueryWrapper();
    getBars.mockImplementation((symbol: string) => Promise.resolve({ ...barsResponse, symbol }));
    const { rerender, result } = renderHook(
      ({ symbol }) => useCandles(symbol, '1d', undefined, new Map()),
      { initialProps: { symbol: 'SPCX' }, wrapper },
    );
    await waitFor(() => expect(result.current.bars).toHaveLength(1));
    expect(
      wrapper.client.getQueryCache().findAll({ queryKey: ['market', 'bars'] })[0]?.gcTime,
    ).toBe(Infinity);
    rerender({ symbol: 'OTHER' });
    await waitFor(() => expect(getBars).toHaveBeenCalledTimes(2));
    rerender({ symbol: 'SPCX' });
    await waitFor(() => expect(result.current.bars).toHaveLength(1));
    expect(getBars.mock.calls.filter(([symbol]) => symbol === 'SPCX')).toHaveLength(1);
  });

  it('paints a persisted series while a fresh series is still loading', async () => {
    const wrapper = sharedQueryWrapper();
    const next = deferred<typeof barsResponse>();
    barCache.read.mockResolvedValueOnce({ ...barsResponse, stale: true });
    getBars.mockReturnValue(next.promise);

    const { result } = renderHook(() => useCandles('SPCX', '15m', undefined, new Map()), {
      wrapper,
    });
    await waitFor(() => expect(result.current.bars).toEqual([history]));
    expect(result.current.isStale).toBe(true);
    expect(result.current.isPending).toBe(false);

    next.resolve({ ...barsResponse, bars: [{ ...history, close: 1.8 }] });
    await waitFor(() => expect(result.current.bars[0].close).toBe(1.8));
    expect(result.current.isStale).toBe(false);
  });

  it('replaces an older browser copy with a newer saved Supabase row', async () => {
    const wrapper = sharedQueryWrapper();
    const next = deferred<typeof barsResponse>();
    barCache.read.mockResolvedValueOnce({
      ...barsResponse,
      stale: true,
      capturedAt: 100,
      bars: [{ ...history, close: 1.1 }],
    });
    getBars.mockReturnValue(next.promise);

    const { result } = renderHook(() => useCandles('SPCX', '15m', undefined, new Map()), {
      wrapper,
    });
    await waitFor(() => expect(result.current.bars[0].close).toBe(1.1));
    const publish = getBars.mock.calls[0][4] as (bars: BarsResponse) => void;
    act(() =>
      publish({
        ...barsResponse,
        stale: true,
        capturedAt: 50,
        bars: [{ ...history, close: 1.05 }],
      }),
    );
    expect(result.current.bars[0].close).toBe(1.1);
    act(() =>
      publish({
        ...barsResponse,
        stale: true,
        capturedAt: 200,
        bars: [{ ...history, close: 1.4 }],
      }),
    );
    await waitFor(() => expect(result.current.bars[0].close).toBe(1.4));
    act(() =>
      publish({
        ...barsResponse,
        stale: true,
        capturedAt: 150,
        bars: [{ ...history, close: 1.2 }],
      }),
    );
    expect(result.current.bars[0].close).toBe(1.4);
    next.resolve({ ...barsResponse, bars: [{ ...history, close: 1.8 }] });
    await waitFor(() => expect(result.current.bars[0].close).toBe(1.8));
  });

  it('cannot repopulate memory or IndexedDB after its chart request is cancelled', async () => {
    const wrapper = sharedQueryWrapper();
    const next = deferred<typeof barsResponse>();
    getBars.mockReturnValue(next.promise);
    renderHook(() => useCandles('SPCX', '15m', undefined, new Map()), { wrapper });
    await waitFor(() => expect(getBars).toHaveBeenCalledOnce());

    await act(async () => {
      await wrapper.client.cancelQueries({ queryKey: ['market', 'bars', 'SPCX', '15m', true] });
    });
    const publish = getBars.mock.calls[0][4] as (bars: typeof barsResponse) => void;
    act(() => publish({ ...barsResponse, stale: true }));
    next.resolve(barsResponse);
    await act(async () => {
      await Promise.resolve();
    });

    expect(wrapper.client.getQueryData(['market', 'bars', 'SPCX', '15m', true])).toBeUndefined();
    expect(barCache.write).not.toHaveBeenCalled();
  });
  it('keeps 24/7 instruments polling while the US market is closed', () => {
    expect(candleRefetchInterval('closed', '1m', false)).toBe(10_000);
    expect(candleRefetchInterval('closed', '1m', true)).toBe(false);
  });

  it('keeps a loaded chart when a background refresh fails', async () => {
    const wrapper = queryWrapper();
    getBars.mockResolvedValueOnce(barsResponse).mockRejectedValueOnce(new Error('upstream down'));

    const { result } = renderHook(() => useCandles('SPCX', '15m', undefined, new Map()), {
      wrapper,
    });
    await waitFor(() => expect(result.current.bars).toHaveLength(1));

    await act(async () => result.current.refetch());
    await waitFor(() => expect(result.current.isStale).toBe(true));

    expect(result.current.isError).toBe(false);
    expect(result.current.bars).toHaveLength(1);
  });

  it('reconciles authoritative volume then replays the newer quote tick', async () => {
    const wrapper = sharedQueryWrapper();
    const nextSeries = deferred<typeof barsResponse>();
    let requestedInitialSeries = false;
    getBars.mockImplementation(() => {
      if (!requestedInitialSeries) {
        requestedInitialSeries = true;
        return Promise.resolve(barsResponse);
      }
      return nextSeries.promise;
    });
    type HookInput = {
      symbol: string;
      timeframe: string;
      selectedTick: Tick | undefined;
      liveBars: Map<string, LiveBarUpdate>;
    };
    const initialProps: HookInput = {
      symbol: 'SPCX',
      timeframe: '15m',
      selectedTick: tick,
      liveBars: new Map([['SPCX:15m:false', live]]),
    };
    const { result, rerender } = renderHook(
      ({ symbol, timeframe, selectedTick, liveBars }) =>
        useCandles(symbol, timeframe, selectedTick, liveBars),
      {
        initialProps,
        wrapper,
      },
    );

    await waitFor(() => expect(result.current.bars.at(-1)?.volume).toBe(80));
    expect(result.current.bars.at(-1)).toMatchObject({ close: 1.9, high: 1.9, volume: 80 });

    const corrected = { ...live, asOf: live.asOf + 1, bar: { ...live.bar, volume: 12 } };
    rerender({
      symbol: 'SPCX',
      timeframe: '15m',
      selectedTick: tick,
      liveBars: new Map([['SPCX:15m:false', corrected]]),
    });
    await waitFor(() => expect(result.current.bars.at(-1)?.volume).toBe(12));
    expect(result.current.bars.at(-1)?.close).toBe(1.9);

    rerender({
      symbol: 'SPCX',
      timeframe: '1h',
      selectedTick: undefined,
      liveBars: new Map([['SPCX:15m:false', corrected]]),
    });
    expect(result.current.bars).toEqual([]);

    rerender({
      symbol: 'OTHER',
      timeframe: '1h',
      selectedTick: undefined,
      liveBars: new Map([['SPCX:15m:false', corrected]]),
    });
    expect(result.current.bars).toEqual([]);
  });

  it('uses POST immediately for the extended query and focus variant', async () => {
    const wrapper = sharedQueryWrapper();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T14:00:00Z'));
    getBars.mockResolvedValue(barsResponse);
    const post = { ...tick, marketState: 'POST', extended: true };
    const { rerender } = renderHook(
      ({ selectedTick }) => useCandles('SPCX', '15m', selectedTick, new Map()),
      { initialProps: { selectedTick: tick }, wrapper },
    );

    rerender({ selectedTick: post });
    expect(focus).toHaveBeenLastCalledWith({
      symbol: 'SPCX',
      timeframe: '15m',
      extended: true,
      active: true,
    });
    await waitFor(() =>
      expect(getBars).toHaveBeenCalledWith(
        'SPCX',
        '15m',
        true,
        expect.any(AbortSignal),
        expect.any(Function),
      ),
    );
  });

  it('releases Yahoo focus immediately on CLOSED while preserving history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T14:00:00Z'));
    const wrapper = sharedQueryWrapper();
    const extendedResponse = deferred<typeof barsResponse>();
    getBars.mockImplementation((_symbol, _timeframe, extended) =>
      extended ? extendedResponse.promise : Promise.resolve(barsResponse),
    );
    const { result, rerender } = renderHook(
      ({ selectedTick }) => useCandles('SPCX', '15m', selectedTick, new Map()),
      { initialProps: { selectedTick: tick }, wrapper },
    );
    await waitFor(() => expect(result.current.bars).toHaveLength(1));

    vi.setSystemTime(new Date('2026-09-22T21:00:00Z'));
    rerender({ selectedTick: { ...tick, marketState: 'CLOSED', extended: false } });
    expect(focus).toHaveBeenLastCalledWith({
      symbol: 'SPCX',
      timeframe: '15m',
      extended: true,
      active: false,
    });
    await waitFor(() =>
      expect(getBars).toHaveBeenCalledWith(
        'SPCX',
        '15m',
        true,
        expect.any(AbortSignal),
        expect.any(Function),
      ),
    );
    expect(result.current.bars).toEqual([history]);

    extendedResponse.resolve({ ...barsResponse, extended: true });
    await waitFor(() => expect(result.current.bars).toEqual([history]));
  });

  it('keeps focus active for a sessionless Binance market through a New York close', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T21:00:00Z'));
    const wrapper = sharedQueryWrapper();
    getBars.mockResolvedValue({
      ...barsResponse,
      symbol: 'BTCUSDT',
      provider: 'binance',
      hasSession: false,
    });
    const { result } = renderHook(() => useCandles('BTCUSDT', '1m', undefined, new Map()), {
      wrapper,
    });

    await waitFor(() => expect(result.current.bars).toHaveLength(1));
    expect(focus).toHaveBeenLastCalledWith({
      symbol: 'BTCUSDT',
      timeframe: '1m',
      extended: false,
      active: true,
    });
  });

  it('ghosts a newly appended daily bar during extended hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T21:00:00Z'));
    const wrapper = sharedQueryWrapper();
    const previousDay = {
      ...history,
      time: Date.parse('2026-09-21T13:30:00Z') / 1000,
    };
    getBars.mockResolvedValue({ ...barsResponse, timeframe: '1d', bars: [previousDay] });
    const postTick: Tick = {
      ...tick,
      time: Date.parse('2026-09-22T20:05:00Z') / 1000,
      marketState: 'POST',
      extended: true,
    };
    const { result } = renderHook(() => useCandles('SPCX', '1d', postTick, new Map()), { wrapper });

    await waitFor(() => expect(result.current.bars).toHaveLength(2));
    expect(result.current.isGhost(result.current.bars[1], 1)).toBe(true);
  });

  it('still reports a fatal error when no series has ever loaded', async () => {
    const wrapper = queryWrapper();
    getBars.mockRejectedValue(new Error('upstream down'));

    const { result } = renderHook(() => useCandles('SPCX', '15m', undefined, new Map()), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.bars).toEqual([]);
    expect(result.current.isStale).toBe(false);
  });
});
