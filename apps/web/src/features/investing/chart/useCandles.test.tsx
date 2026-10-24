import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getBars = vi.hoisted(() => vi.fn());
const getStoredBars = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const focus = vi.hoisted(() => vi.fn());
const barCache = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api/market', () => ({ getBars, getStoredBars }));
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
  getBars.mockReset();
  getStoredBars.mockReset().mockResolvedValue([]);
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
  it('shows all saved timeframes before the visible request finishes and refreshes a selected stale series', async () => {
    const wrapper = sharedQueryWrapper();
    const visible = deferred<BarsResponse>();
    const selected = deferred<BarsResponse>();
    const frames = ['1m', '5m', '15m', '1h', '1d', '1w', '1M'];
    getStoredBars.mockResolvedValue(
      frames.map((frame, index) => ({
        ...barsResponse,
        timeframe: frame,
        stale: true,
        capturedAt: (BASE_TIME + 200) * 1000 + index,
        bars: [{ ...history, close: index + 1 }],
      })),
    );
    getBars.mockImplementation((_symbol: string, frame: string) => {
      if (frame === '15m') return visible.promise;
      if (frame === '1w') return selected.promise;
      return Promise.resolve({ ...barsResponse, timeframe: frame });
    });

    const { rerender, result, unmount } = renderHook(
      ({ frame }) => useCandles('SPCX', frame, tick, new Map(), { preloadTimeframes: true }),
      { initialProps: { frame: '15m' }, wrapper },
    );

    await waitFor(() =>
      expect(
        frames.map(
          (frame) =>
            wrapper.client.getQueryData<BarsResponse>(['market', 'bars', 'SPCX', frame, false])
              ?.bars[0].close,
        ),
      ).toEqual([1, 2, 3, 4, 5, 6, 7]),
    );
    expect(result.current.bars[0].close).toBe(3);
    expect(result.current.isStale).toBe(true);
    expect(getBars.mock.calls.map((call) => call[1] as string)).toEqual(['15m']);

    rerender({ frame: '1w' });
    expect(result.current.bars[0].close).toBe(6);
    await waitFor(() =>
      expect(getBars.mock.calls.map((call) => call[1] as string)).toContain('1w'),
    );
    selected.resolve({ ...barsResponse, timeframe: '1w', bars: [{ ...history, close: 9 }] });
    await waitFor(() => expect(result.current.bars[0].close).toBe(9));
    unmount();
  });

  it('discards an old symbol batch after the selection changes', async () => {
    const wrapper = sharedQueryWrapper();
    const oldBatch = deferred<BarsResponse[]>();
    getBars.mockImplementation(() => new Promise(() => undefined));
    getStoredBars.mockImplementation((symbol: string) =>
      symbol === 'SPCX' ? oldBatch.promise : Promise.resolve([]),
    );
    const { rerender, unmount } = renderHook(
      ({ symbol }) => useCandles(symbol, '15m', tick, new Map(), { preloadTimeframes: true }),
      { initialProps: { symbol: 'SPCX' }, wrapper },
    );

    await waitFor(() => expect(getStoredBars).toHaveBeenCalledOnce());
    const oldSignal = getStoredBars.mock.calls[0][2] as AbortSignal;
    rerender({ symbol: 'OTHER' });
    await waitFor(() => expect(oldSignal.aborted).toBe(true));
    oldBatch.resolve([{ ...barsResponse, timeframe: '1w', capturedAt: 100, stale: true }]);
    await act(async () => {
      await Promise.resolve();
    });

    expect(wrapper.client.getQueryData(['market', 'bars', 'SPCX', '1w', false])).toBeUndefined();
    unmount();
  });

  it('keeps a newer in-memory chart when the grouped saved read returns an older copy', async () => {
    const wrapper = sharedQueryWrapper();
    wrapper.client.setQueryData(
      ['market', 'bars', 'SPCX', '15m', false],
      {
        ...barsResponse,
        capturedAt: (BASE_TIME + 300) * 1000,
        bars: [{ ...history, close: 9 }],
      },
      { updatedAt: Date.now() },
    );
    getStoredBars.mockResolvedValue([
      {
        ...barsResponse,
        capturedAt: (BASE_TIME + 200) * 1000,
        stale: true,
        bars: [{ ...history, close: 1 }],
      },
    ]);
    getBars.mockResolvedValue(barsResponse);

    const { result, unmount } = renderHook(
      () =>
        useCandles('SPCX', '15m', { ...tick, time: null }, new Map(), { preloadTimeframes: true }),
      { wrapper },
    );
    await waitFor(() => expect(getStoredBars).toHaveBeenCalledOnce());
    expect(result.current.bars[0].close).toBe(9);
    expect(
      wrapper.client.getQueryData<BarsResponse>(['market', 'bars', 'SPCX', '15m', false])?.bars[0]
        .close,
    ).toBe(9);
    unmount();
  });

  it('reuses a fresh saved sibling without sending a second bar request', async () => {
    const wrapper = sharedQueryWrapper();
    const visible = deferred<BarsResponse>();
    getStoredBars.mockResolvedValue([
      {
        ...barsResponse,
        timeframe: '1w',
        capturedAt: 100,
        stale: false,
        bars: [{ ...history, close: 6 }],
      },
    ]);
    getBars.mockImplementation((_symbol: string, frame: string) =>
      frame === '15m' ? visible.promise : Promise.resolve({ ...barsResponse, timeframe: frame }),
    );
    const { rerender, result, unmount } = renderHook(
      ({ frame }) =>
        useCandles('SPCX', frame, { ...tick, time: null }, new Map(), { preloadTimeframes: true }),
      { initialProps: { frame: '15m' }, wrapper },
    );
    await waitFor(() =>
      expect(
        wrapper.client.getQueryData<BarsResponse>(['market', 'bars', 'SPCX', '1w', false])?.bars[0]
          .close,
      ).toBe(6),
    );
    visible.resolve(barsResponse);
    await waitFor(() =>
      expect(getBars.mock.calls.map((call) => call[1] as string)).toContain('1M'),
    );
    expect(getBars.mock.calls.map((call) => call[1] as string)).not.toContain('1w');

    rerender({ frame: '1w' });
    expect(result.current.bars[0].close).toBe(6);
    expect(getBars.mock.calls.map((call) => call[1] as string)).not.toContain('1w');
    unmount();
  });

  it('warms sibling timeframes one at a time after the visible chart and reuses them on selection', async () => {
    const wrapper = sharedQueryWrapper();
    const visible = deferred<BarsResponse>();
    const firstSibling = deferred<BarsResponse>();
    getBars.mockImplementation((_symbol: string, frame: string) => {
      if (frame === '15m') return visible.promise;
      if (frame === '1m') return firstSibling.promise;
      return Promise.resolve({ ...barsResponse, timeframe: frame });
    });
    const { rerender, result } = renderHook(
      ({ frame }) => useCandles('SPCX', frame, tick, new Map(), { preloadTimeframes: true }),
      { initialProps: { frame: '15m' }, wrapper },
    );

    await waitFor(() => expect(getBars).toHaveBeenCalledOnce());
    expect(getBars.mock.calls.map((call) => call[1] as string)).toEqual(['15m']);
    visible.resolve(barsResponse);
    await waitFor(() =>
      expect(getBars.mock.calls.map((call) => call[1] as string)).toEqual(['15m', '1m']),
    );
    expect(wrapper.client.getQueryData(['market', 'bars', 'SPCX', '5m', false])).toBeUndefined();

    rerender({ frame: '1m' });
    expect(getBars.mock.calls.filter((call) => call[1] === '1m')).toHaveLength(1);
    firstSibling.resolve({ ...barsResponse, timeframe: '1m' });
    await waitFor(() => expect(result.current.bars[0]).toEqual(history));
    await waitFor(() => expect(getBars).toHaveBeenCalledTimes(7));
    expect(getBars.mock.calls.map((call) => call[1] as string)).toEqual([
      '15m',
      '1m',
      '5m',
      '1h',
      '1d',
      '1w',
      '1M',
    ]);
    expect(getBars.mock.calls.filter((call) => call[1] === '1m')).toHaveLength(1);
    expect(
      wrapper.client.getQueryCache().find({ queryKey: ['market', 'bars', 'SPCX', '5m', false] })
        ?.gcTime,
    ).toBe(30 * 60_000);
  });

  it('continues warming after one sibling fails', async () => {
    const wrapper = sharedQueryWrapper();
    getBars.mockImplementation((_symbol: string, frame: string) =>
      frame === '1m'
        ? Promise.reject(new Error('provider down'))
        : Promise.resolve({ ...barsResponse, timeframe: frame }),
    );
    renderHook(() => useCandles('SPCX', '15m', tick, new Map(), { preloadTimeframes: true }), {
      wrapper,
    });
    await waitFor(() =>
      expect(getBars.mock.calls.map((call) => call[1] as string)).toContain('1M'),
    );
    expect(getBars.mock.calls.filter((call) => call[1] === '1m')).toHaveLength(1);
  });

  it('cancels an unobserved sibling when the selected symbol changes', async () => {
    const wrapper = sharedQueryWrapper();
    const oldSibling = deferred<BarsResponse>();
    getBars.mockImplementation((symbol: string, frame: string) =>
      symbol === 'SPCX' && frame === '1m'
        ? oldSibling.promise
        : Promise.resolve({ ...barsResponse, symbol, timeframe: frame }),
    );
    const { rerender } = renderHook(
      ({ symbol }) => useCandles(symbol, '15m', tick, new Map(), { preloadTimeframes: true }),
      { initialProps: { symbol: 'SPCX' }, wrapper },
    );
    await waitFor(() =>
      expect(
        getBars.mock.calls.some(([symbol, frame]) => symbol === 'SPCX' && frame === '1m'),
      ).toBe(true),
    );
    const oldSignal = getBars.mock.calls.find(
      ([symbol, frame]) => symbol === 'SPCX' && frame === '1m',
    )?.[3] as AbortSignal;
    rerender({ symbol: 'OTHER' });
    await waitFor(() => expect(oldSignal.aborted).toBe(true));
    oldSibling.resolve({ ...barsResponse, timeframe: '1m' });
    expect(wrapper.client.getQueryData(['market', 'bars', 'SPCX', '1m', false])).toBeUndefined();
  });

  it('cancels a different speculative request before loading a newly selected timeframe', async () => {
    const wrapper = sharedQueryWrapper();
    const speculative = deferred<BarsResponse>();
    const selected = deferred<BarsResponse>();
    getBars.mockImplementation((_symbol: string, frame: string) => {
      if (frame === '1m') return speculative.promise;
      if (frame === '1h') return selected.promise;
      return Promise.resolve({ ...barsResponse, timeframe: frame });
    });
    const { rerender } = renderHook(
      ({ frame }) => useCandles('SPCX', frame, tick, new Map(), { preloadTimeframes: true }),
      { initialProps: { frame: '15m' }, wrapper },
    );
    await waitFor(() => expect(getBars.mock.calls.some((call) => call[1] === '1m')).toBe(true));
    const speculativeSignal = getBars.mock.calls.find(
      (call) => call[1] === '1m',
    )?.[3] as AbortSignal;

    rerender({ frame: '1h' });
    await waitFor(() => expect(speculativeSignal.aborted).toBe(true));
    await waitFor(() => expect(getBars.mock.calls.some((call) => call[1] === '1h')).toBe(true));
    expect(getBars.mock.calls.some((call) => call[1] === '5m')).toBe(false);
    selected.resolve({ ...barsResponse, timeframe: '1h' });
    speculative.resolve({ ...barsResponse, timeframe: '1m' });
    await waitFor(() => expect(getBars.mock.calls.some((call) => call[1] === '5m')).toBe(true));
  });

  it('keeps an expired saved sibling stale after its background refresh fails', async () => {
    const wrapper = sharedQueryWrapper();
    barCache.read.mockImplementation((_owner: string, _symbol: string, frame: string) =>
      Promise.resolve(
        frame === '1m' ? { ...barsResponse, timeframe: frame, capturedAt: 100, stale: true } : null,
      ),
    );
    getBars.mockImplementation((_symbol: string, frame: string) =>
      frame === '1m'
        ? Promise.reject(new Error('provider down'))
        : Promise.resolve({ ...barsResponse, timeframe: frame }),
    );
    const { rerender } = renderHook(
      ({ frame }) => useCandles('SPCX', frame, tick, new Map(), { preloadTimeframes: true }),
      { initialProps: { frame: '15m' }, wrapper },
    );

    await waitFor(() => expect(getBars.mock.calls.some((call) => call[1] === '5m')).toBe(true));
    expect(
      wrapper.client.getQueryState(['market', 'bars', 'SPCX', '1m', false])?.dataUpdatedAt,
    ).toBe(100);
    rerender({ frame: '1m' });
    await waitFor(() =>
      expect(getBars.mock.calls.filter((call) => call[1] === '1m')).toHaveLength(2),
    );
  });

  it('moves on to the next sibling when a speculative collector request stalls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const wrapper = sharedQueryWrapper();
    const stalled = deferred<BarsResponse>();
    barCache.read.mockImplementation((_owner: string, _symbol: string, frame: string) =>
      Promise.resolve(
        frame === '1m' ? { ...barsResponse, timeframe: frame, capturedAt: 100, stale: true } : null,
      ),
    );
    getBars.mockImplementation((_symbol: string, frame: string) =>
      frame === '1m' ? stalled.promise : Promise.resolve({ ...barsResponse, timeframe: frame }),
    );
    renderHook(() => useCandles('SPCX', '15m', tick, new Map(), { preloadTimeframes: true }), {
      wrapper,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getBars.mock.calls.some((call) => call[1] === '1m')).toBe(true);
    const stalledSignal = getBars.mock.calls.find((call) => call[1] === '1m')?.[3] as AbortSignal;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(stalledSignal.aborted).toBe(true);
    expect(getBars.mock.calls.some((call) => call[1] === '5m')).toBe(true);
    expect(
      wrapper.client.getQueryData<BarsResponse>(['market', 'bars', 'SPCX', '1m', false])?.bars,
    ).toEqual([history]);
    stalled.resolve({ ...barsResponse, timeframe: '1m' });
  });

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

  it('keeps a newer browser copy when a fresh-but-older Supabase row finishes', async () => {
    const wrapper = sharedQueryWrapper();
    barCache.read.mockResolvedValueOnce({
      ...barsResponse,
      stale: true,
      capturedAt: 200,
      bars: [{ ...history, close: 1.8 }],
    });
    getBars.mockResolvedValueOnce({
      ...barsResponse,
      capturedAt: 100,
      bars: [{ ...history, close: 1.1 }],
    });

    const { result } = renderHook(() => useCandles('SPCX', '15m', undefined, new Map()), {
      wrapper,
    });
    await waitFor(() => expect(result.current.bars[0].close).toBe(1.8));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.bars[0].close).toBe(1.8);
    expect(barCache.write).toHaveBeenCalledWith(
      'owner-a',
      expect.objectContaining({ capturedAt: 200 }),
    );
  });

  it('cannot repopulate memory or IndexedDB after its chart request is cancelled', async () => {
    const wrapper = sharedQueryWrapper();
    const next = deferred<typeof barsResponse>();
    getBars.mockReturnValue(next.promise);
    renderHook(() => useCandles('SPCX', '15m', undefined, new Map()), { wrapper });
    await waitFor(() => expect(getBars).toHaveBeenCalledOnce());

    // Without the session flag: which variant is requested follows the wall
    // clock (extended outside regular hours), and the test must not.
    const chart = ['market', 'bars', 'SPCX', '15m'];
    await act(async () => {
      await wrapper.client.cancelQueries({ queryKey: chart });
    });
    const publish = getBars.mock.calls[0][4] as (bars: typeof barsResponse) => void;
    act(() => publish({ ...barsResponse, stale: true }));
    next.resolve(barsResponse);
    await act(async () => {
      await Promise.resolve();
    });

    expect(wrapper.client.getQueriesData({ queryKey: chart }).map(([, data]) => data)).toEqual([
      undefined,
    ]);
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
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date((BASE_TIME + 30) * 1000));
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

  it('drops a live overlay superseded by a later history refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date((BASE_TIME + 30) * 1000));
    const wrapper = sharedQueryWrapper();
    const fresh = { ...barsResponse, bars: [{ ...history, close: 1.95, volume: 500 }] };
    getBars.mockResolvedValueOnce(barsResponse).mockResolvedValueOnce(fresh);
    const bars = new Map([['SPCX:15m:false', live]]);
    const { result } = renderHook(() => useCandles('SPCX', '15m', undefined, bars), { wrapper });
    await waitFor(() => expect(result.current.bars[0]?.volume).toBe(80));
    vi.setSystemTime(new Date((BASE_TIME + 120) * 1000));
    await act(async () => result.current.refetch());
    await waitFor(() => expect(result.current.bars[0]?.volume).toBe(500));
    expect(result.current.bars[0]?.close).toBe(1.95);
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

  it('loads a Binance pair only once outside the US session', async () => {
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
    expect(getBars).toHaveBeenCalledOnce();
    expect(getBars).toHaveBeenCalledWith(
      'BTCUSDT',
      '1m',
      false,
      expect.any(AbortSignal),
      expect.any(Function),
    );
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

  it('can retry an initially failed chart without changing selection', async () => {
    const wrapper = queryWrapper();
    getBars.mockRejectedValueOnce(new Error('upstream down')).mockResolvedValueOnce(barsResponse);
    const { result } = renderHook(() => useCandles('SPCX', '15m', undefined, new Map()), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    await act(async () => result.current.refetch());
    await waitFor(() => expect(result.current.bars).toEqual([history]));
    expect(result.current.isError).toBe(false);
  });
});
