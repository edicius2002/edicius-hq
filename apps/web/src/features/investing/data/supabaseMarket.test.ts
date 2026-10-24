import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const single = vi.fn();
  const insertAbortSignal = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ abortSignal: insertAbortSignal }));
  const insert = vi.fn(() => ({ select }));
  const maybeSingle = vi.fn();
  const requestSingle = vi.fn();
  const requestAbortSignal = vi.fn(() => ({ single: requestSingle }));
  const eq = vi.fn(() => ({ abortSignal: requestAbortSignal }));
  const quotesAbortSignal = vi.fn();
  const quotesIn = vi.fn(() => ({ abortSignal: quotesAbortSignal }));
  const quotesSelect = vi.fn(() => ({ in: quotesIn }));
  const bulkAbortSignal = vi.fn();
  const bulkSymbolIn = vi.fn(() => ({ eq: bulkExtendedEq }));
  const bulkExtendedEq = vi.fn(() => ({ abortSignal: bulkAbortSignal }));
  const bulkSymbolEq = vi.fn(() => ({ eq: bulkExtendedEq }));
  const from = vi.fn((table: string) => {
    if (table === 'collector_requests') return { insert, select: vi.fn(() => ({ eq })) };
    if (table === 'market_bars')
      return {
        select: vi.fn((columns: string) =>
          columns.includes('timeframe,')
            ? { eq: bulkSymbolEq, in: bulkSymbolIn }
            : {
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    eq: vi.fn(() => ({ abortSignal: vi.fn(() => ({ maybeSingle })) })),
                  })),
                })),
              },
        ),
      };
    return { select: quotesSelect };
  });
  const subscribe = vi.fn();
  const on = vi.fn((...args: unknown[]) => {
    void args;
    return { on, subscribe };
  });
  const send = vi.fn().mockResolvedValue('ok');
  const channelSubscribe = vi.fn();
  const channel = vi.fn(() => ({ on, send, subscribe: channelSubscribe }));
  const removeChannel = vi.fn();
  const getSession = vi.fn();
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
  return {
    auth: { getSession },
    from,
    insert,
    select,
    single,
    maybeSingle,
    quotesIn,
    quotesAbortSignal,
    channel,
    on,
    subscribe,
    send,
    channelSubscribe,
    removeChannel,
    getSession,
    rpc,
    eq,
    requestSingle,
    bulkAbortSignal,
    bulkSymbolEq,
    bulkSymbolIn,
    bulkExtendedEq,
  };
});

vi.mock('@/shared/supabase/client', () => ({ supabase: state }));

import {
  getBars,
  getQuotes,
  openChartFocus,
  searchSymbols,
  subscribeMarketUpdates,
} from './supabaseMarket';
import * as market from './supabaseMarket';
import type { LiveBarUpdate } from './liveBars';

afterEach(() => vi.clearAllMocks());

const BARS = {
  symbol: 'AAPL',
  timeframe: '1d',
  provider: 'worker',
  extended: false,
  hasSession: true,
  stale: false,
  bars: [{ time: 1, open: 1, high: 2, low: 1, close: 2, volume: 3 }],
};

describe('Supabase Investing market boundary', () => {
  it('reads saved bars for multiple assets in one request without queueing worker jobs', async () => {
    state.bulkAbortSignal.mockResolvedValue({
      data: [
        {
          symbol: 'BNO',
          timeframe: '1w',
          provider: 'worker',
          payload: { ...BARS, symbol: 'BNO', timeframe: '1w' },
          fetched_at: '2026-09-24T00:00:00Z',
          expires_at: '2026-09-25T00:00:00Z',
        },
        {
          symbol: 'OTHER',
          timeframe: '1d',
          provider: 'worker',
          payload: { ...BARS, symbol: 'OTHER' },
          fetched_at: '2026-09-24T00:00:00Z',
          expires_at: '2026-09-25T00:00:00Z',
        },
      ],
      error: null,
    });

    const result = await market.getStoredBarsForSymbols(['BNO', 'USO', 'BNO'], false);

    expect(state.bulkSymbolIn).toHaveBeenCalledWith('symbol', ['BNO', 'USO']);
    expect(result).toEqual([
      expect.objectContaining({ symbol: 'BNO', timeframe: '1w', stale: true }),
    ]);
    expect(state.insert).not.toHaveBeenCalled();
  });

  it('reads every saved timeframe in one owner-scoped query and marks expired rows stale', async () => {
    state.bulkAbortSignal.mockResolvedValue({
      data: [
        {
          timeframe: '1d',
          provider: 'worker',
          payload: BARS,
          fetched_at: '2026-09-24T00:00:00Z',
          expires_at: '2999-01-01T00:00:00Z',
        },
        {
          timeframe: '1w',
          provider: 'worker',
          payload: { ...BARS, timeframe: '1w', bars: [{ ...BARS.bars[0], close: 8 }] },
          fetched_at: '2026-09-20T00:00:00Z',
          expires_at: '2026-09-21T00:00:00Z',
        },
        {
          timeframe: '1M',
          provider: 'worker',
          payload: { ...BARS, symbol: 'OTHER', timeframe: '1M' },
          fetched_at: '2026-09-20T00:00:00Z',
          expires_at: '2026-09-21T00:00:00Z',
        },
        {
          timeframe: '1m',
          provider: 'worker',
          payload: { ...BARS, timeframe: '1m' },
          fetched_at: '2026-09-20T00:00:00Z',
          expires_at: 'invalid timestamp',
        },
      ],
      error: null,
    });

    await expect(market.getStoredBars('AAPL', false)).resolves.toEqual([
      { ...BARS, capturedAt: Date.parse('2026-09-24T00:00:00Z') },
      {
        ...BARS,
        timeframe: '1w',
        stale: true,
        bars: [{ ...BARS.bars[0], close: 8 }],
        capturedAt: Date.parse('2026-09-20T00:00:00Z'),
      },
      {
        ...BARS,
        timeframe: '1m',
        stale: true,
        capturedAt: Date.parse('2026-09-20T00:00:00Z'),
      },
    ]);
    expect(state.bulkSymbolEq).toHaveBeenCalledWith('symbol', 'AAPL');
    expect(state.bulkExtendedEq).toHaveBeenCalledWith('extended', false);
    expect(state.bulkAbortSignal).toHaveBeenCalledOnce();
    expect(state.insert).not.toHaveBeenCalled();
  });

  it('reads owner-visible quote rows and preserves the shared wire shape', async () => {
    state.quotesAbortSignal.mockResolvedValue({
      data: [
        {
          symbol: 'AAPL',
          provider: 'worker',
          market_time: 1,
          payload: {
            price: 200,
            currency: 'USD',
            previousClose: 190,
            change: 10,
            changePercent: 5,
            marketState: 'REGULAR',
            name: 'Apple',
            extended: false,
          },
        },
      ],
      error: null,
    });

    await expect(getQuotes(['AAPL'])).resolves.toEqual({
      quotes: [
        expect.objectContaining({ symbol: 'AAPL', price: 200, provider: 'worker', time: 1 }),
      ],
      failed: [],
    });
  });

  it('normalizes owner RLS quote-read errors without leaking the database body', async () => {
    state.quotesAbortSignal.mockResolvedValue({
      data: null,
      error: { message: 'policy detail: owner-42' },
    });

    await expect(getQuotes(['AAPL'])).rejects.toMatchObject({ code: 'quotes_unavailable' });
  });

  it('returns a fresh cached bars result without creating a collector request', async () => {
    state.maybeSingle.mockResolvedValue({
      data: {
        provider: 'worker',
        payload: BARS,
        fetched_at: '2026-09-24T00:00:00Z',
        expires_at: '2999-01-01T00:00:00Z',
      },
      error: null,
    });

    await expect(getBars('AAPL', '1d')).resolves.toEqual({
      ...BARS,
      capturedAt: Date.parse('2026-09-24T00:00:00Z'),
    });
    expect(state.insert).not.toHaveBeenCalled();
  });

  it('normalizes a bars RLS read error and enqueues nothing', async () => {
    state.maybeSingle.mockResolvedValue({ data: null, error: { message: 'owner-id leaked' } });

    await expect(getBars('AAPL', '1d')).rejects.toMatchObject({ code: 'bars_unavailable' });
    expect(state.insert).not.toHaveBeenCalled();
  });

  it('treats an expired cache row as a miss and replaces it with the completed result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T16:00:00.000Z'));
    state.maybeSingle.mockResolvedValue({ data: null, error: null });
    state.single.mockResolvedValue({ data: { request_id: 'request-expired-cache' }, error: null });
    state.subscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'request' };
    });
    state.requestSingle.mockResolvedValue({
      data: { status: 'complete', result: BARS, error_code: null },
      error: null,
    });

    await expect(getBars('AAPL', '1d')).resolves.toEqual(BARS);
    expect(state.insert).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'market-bars' }),
    );
    vi.useRealTimers();
  });

  it('offers an expired saved series before the collector finishes', async () => {
    const onStored = vi.fn();
    let complete!: (value: unknown) => void;
    state.maybeSingle.mockResolvedValue({
      data: {
        provider: 'worker',
        payload: BARS,
        fetched_at: '2020-01-01T00:00:00Z',
        expires_at: '2020-01-01T00:00:00Z',
      },
      error: null,
    });
    state.single.mockResolvedValue({ data: { request_id: 'request-stale' }, error: null });
    state.subscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'request' };
    });
    state.requestSingle.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );

    const pending = getBars('AAPL', '1d', false, undefined, onStored);
    await vi.waitFor(() =>
      expect(onStored).toHaveBeenCalledWith({
        ...BARS,
        capturedAt: Date.parse('2020-01-01T00:00:00Z'),
        stale: true,
      }),
    );
    expect(state.insert).toHaveBeenCalledOnce();
    complete({ data: { status: 'complete', result: BARS, error_code: null }, error: null });
    await expect(pending).resolves.toEqual(BARS);
  });

  it('treats a malformed fresh cache row as a miss and returns only a normalized completed result', async () => {
    state.maybeSingle.mockResolvedValue({
      data: { provider: 'worker', payload: { bad: true } },
      error: null,
    });
    state.single.mockResolvedValue({
      data: { request_id: 'request-malformed-cache' },
      error: null,
    });
    state.subscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'request' };
    });
    state.requestSingle.mockResolvedValue({
      data: { status: 'complete', result: BARS, error_code: null },
      error: null,
    });

    await expect(getBars('AAPL', '1d')).resolves.toEqual(BARS);
    expect(state.insert).toHaveBeenCalledOnce();
  });

  it('enqueues a stale bar request and resolves its completed result', async () => {
    state.maybeSingle.mockResolvedValue({ data: null, error: null });
    state.single.mockResolvedValue({ data: { request_id: 'request-1' }, error: null });
    state.subscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'request' };
    });
    state.requestSingle.mockResolvedValue({
      data: { status: 'complete', result: BARS, error_code: null },
      error: null,
    });

    await expect(getBars('AAPL', '1d')).resolves.toEqual(BARS);
    expect(state.insert).toHaveBeenCalledWith({
      operation: 'market-bars',
      payload: { symbol: 'AAPL', timeframe: '1d', extended: false },
    });
  });

  it('exposes only a collector failure code', async () => {
    state.single.mockResolvedValue({ data: { request_id: 'request-2' }, error: null });
    state.subscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'request' };
    });
    state.requestSingle.mockResolvedValue({
      data: { status: 'failed', result: { detail: 'secret' }, error_code: 'provider_down' },
      error: null,
    });

    await expect(searchSymbols('apple')).rejects.toThrow('provider_down');
  });

  it('rejects an expired request with the stable sanitized error', async () => {
    state.single.mockResolvedValue({ data: { request_id: 'request-expired' }, error: null });
    state.subscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'request' };
    });
    state.requestSingle.mockResolvedValue({
      data: { status: 'expired', result: null, error_code: 'internal provider detail' },
      error: null,
    });

    await expect(searchSymbols('apple')).rejects.toMatchObject({ code: 'request_expired' });
  });

  it('normalizes an insert error without opening a wait channel', async () => {
    state.single.mockResolvedValue({ data: null, error: { message: 'auth header body' } });

    await expect(searchSymbols('apple')).rejects.toMatchObject({ code: 'request_unavailable' });
    expect(state.channel).not.toHaveBeenCalled();
  });

  it('cleans its wait channel when collector request reconciliation cannot be selected', async () => {
    state.single.mockResolvedValue({ data: { request_id: 'request-select-error' }, error: null });
    state.subscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'request' };
    });
    state.requestSingle.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'RLS body' },
    });

    await expect(searchSymbols('apple')).rejects.toMatchObject({ code: 'request_unavailable' });
    expect(state.removeChannel).toHaveBeenCalledOnce();
  });

  it('sanitizes untrusted failure codes and expired requests', async () => {
    state.single.mockResolvedValue({ data: { request_id: 'request-3' }, error: null });
    state.subscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'request' };
    });
    state.requestSingle.mockResolvedValue({
      data: { status: 'failed', result: null, error_code: 'provider says: secret' },
      error: null,
    });

    await expect(searchSymbols('apple')).rejects.toThrow('request_failed');
  });

  it('rejects malformed completed results and tears down its request channel once', async () => {
    state.single.mockResolvedValue({ data: { request_id: 'request-4' }, error: null });
    state.subscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'request' };
    });
    state.requestSingle.mockResolvedValue({
      data: { status: 'complete', result: { result: 'not-bars' }, error_code: null },
      error: null,
    });

    await expect(getBars('AAPL', '1d')).rejects.toThrow('malformed_result');
    expect(state.removeChannel).toHaveBeenCalledOnce();
  });

  it('times out at ninety seconds and removes its channel exactly once', async () => {
    vi.useFakeTimers();
    state.maybeSingle.mockResolvedValue({ data: null, error: null });
    state.single.mockResolvedValue({ data: { request_id: 'request-5' }, error: null });
    state.requestSingle.mockResolvedValue({
      data: { status: 'queued', result: null, error_code: null },
      error: null,
    });
    state.subscribe.mockReturnValue({ id: 'request' });

    const pending = getBars('AAPL', '1d');
    const rejection = expect(pending).rejects.toThrow('request_timeout');
    await vi.advanceTimersByTimeAsync(90_000);

    await rejection;
    expect(state.removeChannel).toHaveBeenCalledOnce();
    expect(state.requestSingle.mock.calls.length).toBeLessThan(60);
    vi.useRealTimers();
  });

  it('bounds a stalled queue insert and honours cancellation before a row is created', async () => {
    vi.useFakeTimers();
    state.single.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = searchSymbols('AAPL', controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
    controller.abort();
    await rejected;
    expect(state.channel).not.toHaveBeenCalled();
    const timed = expect(searchSymbols('MSFT')).rejects.toMatchObject({ code: 'request_timeout' });
    await vi.advanceTimersByTimeAsync(90_000);
    await timed;
    vi.useRealTimers();
  });

  it('does not read cache or enqueue with an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getBars('AAPL', '1d', false, controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(state.maybeSingle).not.toHaveBeenCalled();
    expect(state.insert).not.toHaveBeenCalled();
  });

  it('bounds a stalled initial bar cache read without enqueueing', async () => {
    vi.useFakeTimers();
    state.maybeSingle.mockImplementation(() => new Promise(() => {}));
    const timed = expect(getBars('AAPL', '1d')).rejects.toMatchObject({ code: 'request_timeout' });
    await vi.advanceTimersByTimeAsync(90_000);
    await timed;
    expect(state.insert).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('bounds a stalled HTTP reconciliation and cancels the queued row', async () => {
    vi.useFakeTimers();
    state.single.mockResolvedValue({ data: { request_id: 'request-hung-read' }, error: null });
    state.requestSingle.mockImplementation(() => new Promise(() => {}));
    const timed = expect(searchSymbols('AAPL')).rejects.toMatchObject({ code: 'request_timeout' });
    await vi.advanceTimersByTimeAsync(90_000);
    await timed;
    expect(state.rpc).toHaveBeenCalledWith('cancel_market_request', {
      p_request_id: 'request-hung-read',
    });
    expect(state.removeChannel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('finds a completed request through HTTP after Realtime fails', async () => {
    state.single.mockResolvedValue({ data: { request_id: 'request-fallback' }, error: null });
    state.subscribe.mockImplementation((status: (value: string) => void) => {
      status('CHANNEL_ERROR');
      return { id: 'request' };
    });
    state.requestSingle.mockResolvedValue({
      data: { status: 'complete', result: { results: [] }, error_code: null },
      error: null,
    });
    await expect(searchSymbols('AAPL')).resolves.toEqual({ results: [] });
    expect(state.requestSingle).toHaveBeenCalled();
  });

  it('retries a transient result-read failure and recovers on the next HTTP check', async () => {
    vi.useFakeTimers();
    state.single.mockResolvedValue({ data: { request_id: 'request-retry' }, error: null });
    state.subscribe.mockReturnValue({ id: 'request' });
    state.requestSingle
      .mockResolvedValueOnce({ data: null, error: { code: 'PGRST000' } })
      .mockResolvedValueOnce({
        data: { status: 'complete', result: { results: [] }, error_code: null },
        error: null,
      });
    const pending = searchSymbols('AAPL');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ results: [] });
    expect(state.requestSingle).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('finds a completed collector result within the first second without a Realtime update', async () => {
    vi.useFakeTimers();
    state.maybeSingle.mockResolvedValue({ data: null, error: null });
    state.single.mockResolvedValue({ data: { request_id: 'request-fast-result' }, error: null });
    state.subscribe.mockReturnValue({ id: 'request' });
    state.requestSingle
      .mockResolvedValueOnce({
        data: { status: 'queued', result: null, error_code: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { status: 'complete', result: BARS, error_code: null },
        error: null,
      });

    const pending = getBars('AAPL', '1d');
    await vi.advanceTimersByTimeAsync(800);
    const readsBeforeOneSecond = state.requestSingle.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual(BARS);
    expect(readsBeforeOneSecond).toBe(2);
    vi.useRealTimers();
  });

  it('joins the authenticated owner private topic and emits only valid ticks', async () => {
    state.getSession.mockResolvedValue({
      data: { session: { user: { id: 'owner-42' } } },
      error: null,
    });
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    state.on.mockImplementation((...args: unknown[]) => {
      handlers.set(
        (args[1] as { event: string }).event,
        args[2] as (event: { payload: unknown }) => void,
      );
      return { on: state.on, subscribe: state.subscribe };
    });
    const onTicks = vi.fn();
    const onBars = vi.fn<(bars: LiveBarUpdate[]) => void>();
    const close = subscribeMarketUpdates(onTicks, onBars);
    await vi.waitFor(() => expect(state.channel).toHaveBeenCalledOnce());

    expect(state.channel).toHaveBeenCalledWith('market-quotes:owner-42', {
      config: { private: true },
    });
    expect(state.on).toHaveBeenCalledWith('broadcast', { event: 'ticks' }, expect.any(Function));
    handlers.get('ticks')?.({
      payload: {
        ticks: [
          {
            symbol: 'AAPL',
            price: 201,
            marketState: 'REGULAR',
            extended: false,
            changePercent: 1,
            time: 2,
          },
          {
            symbol: 'BAD',
            price: Number.NaN,
            marketState: null,
            extended: false,
            changePercent: null,
            time: null,
          },
          { symbol: 'NOFLAG', price: 3, marketState: null, changePercent: null, time: 3 },
        ],
      },
    });
    close();

    expect(onTicks).toHaveBeenCalledWith([
      {
        symbol: 'AAPL',
        price: 201,
        marketState: 'REGULAR',
        extended: false,
        changePercent: 1,
        time: 2,
      },
    ]);
    expect(state.removeChannel).toHaveBeenCalledOnce();
  });

  it('decodes valid live bars on the same channel and rejects malformed rows', async () => {
    state.getSession.mockResolvedValue({
      data: { session: { user: { id: 'owner-42' } } },
      error: null,
    });
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    state.on.mockImplementation((...args: unknown[]) => {
      handlers.set(
        (args[1] as { event: string }).event,
        args[2] as (event: { payload: unknown }) => void,
      );
      return { on: state.on, subscribe: state.subscribe };
    });
    const onTicks = vi.fn();
    const onBars = vi.fn();
    const onStatus = vi.fn();
    state.subscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'quotes' };
    });
    const close = subscribeMarketUpdates(onTicks, onBars, onStatus);
    await vi.waitFor(() => expect(handlers.size).toBe(2));

    handlers.get('ticks')?.({
      payload: {
        ticks: [
          {
            symbol: 'AAPL',
            price: 2,
            marketState: null,
            extended: false,
            changePercent: null,
            time: 5,
          },
        ],
      },
    });
    handlers.get('bars')?.({
      payload: {
        bars: [
          {
            symbol: 'AAPL',
            timeframe: '15m',
            extended: true,
            asOf: 100,
            bar: { time: 90, open: 1, high: 3, low: 1, close: 2, volume: 12 },
          },
          {
            symbol: 'NAN',
            timeframe: '15m',
            extended: true,
            asOf: Number.NaN,
            bar: { time: 90, open: 1, high: 3, low: 1, close: 2, volume: 12 },
          },
          {
            symbol: 'BOOL',
            timeframe: '15m',
            extended: 1,
            asOf: 100,
            bar: { time: 90, open: 1, high: 3, low: 1, close: 2, volume: 12 },
          },
          {
            symbol: 'BADTF',
            timeframe: '2m',
            extended: true,
            asOf: 100,
            bar: { time: 90, open: 1, high: 3, low: 1, close: 2, volume: 12 },
          },
          {
            symbol: 'PARTIAL',
            timeframe: '15m',
            extended: true,
            asOf: 100,
            bar: { time: 90, open: 1, high: 3, low: 1, close: 2 },
          },
        ],
      },
    });
    close();

    expect(onTicks).toHaveBeenCalledOnce();
    expect(onBars).toHaveBeenCalledWith([
      {
        symbol: 'AAPL',
        timeframe: '15m',
        extended: true,
        asOf: 100,
        bar: { time: 90, open: 1, high: 3, low: 1, close: 2, volume: 12 },
      },
    ]);
    expect(onStatus).toHaveBeenCalledWith('SUBSCRIBED');
  });

  it('reports CHANNEL_ERROR and opens no channel when the session is missing', async () => {
    state.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const onStatus = vi.fn();

    subscribeMarketUpdates(vi.fn(), vi.fn(), onStatus);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith('CHANNEL_ERROR'));

    expect(state.channel).not.toHaveBeenCalled();
  });

  it('reports a bounded quote channel failure when session lookup stalls', async () => {
    vi.useFakeTimers();
    state.getSession.mockImplementation(() => new Promise(() => {}));
    const onStatus = vi.fn();
    subscribeMarketUpdates(vi.fn(), vi.fn(), onStatus);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(onStatus).toHaveBeenCalledWith('CHANNEL_ERROR');
    expect(state.channel).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('opens one private focus publisher and removes its channel idempotently', async () => {
    state.getSession.mockResolvedValue({
      data: { session: { user: { id: 'owner-42' } } },
      error: null,
    });
    state.channelSubscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'focus' };
    });
    const focus = await openChartFocus();
    const message = {
      clientId: 'tab-id',
      symbol: 'AAPL',
      timeframe: '15m',
      extended: true,
      active: true,
    };
    await focus.publish(message);
    await focus.close();
    await focus.close();

    expect(state.channel).toHaveBeenCalledWith('market-focus:owner-42', {
      config: { private: true },
    });
    expect(state.send).toHaveBeenCalledWith({
      type: 'broadcast',
      event: 'focus',
      payload: message,
    });
    expect(state.removeChannel).toHaveBeenCalledOnce();
  });

  it('does not join a focus channel when session lookup fails', async () => {
    state.getSession.mockRejectedValue(new Error('session unavailable'));

    await expect(openChartFocus()).rejects.toThrow();

    expect(state.channel).not.toHaveBeenCalled();
    expect(state.removeChannel).not.toHaveBeenCalled();
  });

  it('bounds a focus session lookup that never settles', async () => {
    vi.useFakeTimers();
    state.getSession.mockImplementation(() => new Promise(() => {}));
    const timed = expect(openChartFocus()).rejects.toMatchObject({ code: 'focus_unavailable' });
    await vi.advanceTimersByTimeAsync(8_000);
    await timed;
    expect(state.channel).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('bounds focus channel joining and removes the stalled channel', async () => {
    vi.useFakeTimers();
    state.getSession.mockResolvedValue({
      data: { session: { user: { id: 'owner-42' } } },
      error: null,
    });
    state.channelSubscribe.mockImplementation(() => ({ id: 'focus' }));
    const timed = expect(openChartFocus()).rejects.toMatchObject({ code: 'focus_unavailable' });
    await vi.advanceTimersByTimeAsync(8_000);
    await timed;
    expect(state.removeChannel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('bounds a stalled focus publish', async () => {
    vi.useFakeTimers();
    state.getSession.mockResolvedValue({
      data: { session: { user: { id: 'owner-42' } } },
      error: null,
    });
    state.channelSubscribe.mockImplementation((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return { id: 'focus' };
    });
    state.send.mockImplementation(() => new Promise(() => {}));
    const focus = await openChartFocus();
    const timed = expect(
      focus.publish({
        clientId: 'tab',
        symbol: 'AAPL',
        timeframe: '1m',
        extended: false,
        active: true,
      }),
    ).rejects.toMatchObject({ code: 'focus_unavailable' });
    await vi.advanceTimersByTimeAsync(8_000);
    await timed;
    await focus.close();
    state.send.mockResolvedValue('ok');
    vi.useRealTimers();
  });

  it('reports a sanitized CHANNEL_ERROR when session lookup rejects', async () => {
    state.getSession.mockRejectedValue(new Error('secret session detail'));
    const onStatus = vi.fn();

    subscribeMarketUpdates(vi.fn(), vi.fn(), onStatus);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith('CHANNEL_ERROR'));

    expect(onStatus).toHaveBeenCalledOnce();
    expect(state.channel).not.toHaveBeenCalled();
  });

  it('does not open a channel when disposed before session resolution', async () => {
    let resolveSession!: (value: {
      data: { session: { user: { id: string } } };
      error: null;
    }) => void;
    state.getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );

    const close = subscribeMarketUpdates(vi.fn(), vi.fn());
    close();
    resolveSession({ data: { session: { user: { id: 'owner-42' } } }, error: null });
    await Promise.resolve();

    expect(state.channel).not.toHaveBeenCalled();
    expect(state.removeChannel).not.toHaveBeenCalled();
  });

  it.each(['SUBSCRIBED', 'TIMED_OUT', 'CHANNEL_ERROR', 'CLOSED'])(
    'forwards the %s Realtime status unchanged',
    async (status) => {
      state.getSession.mockResolvedValue({
        data: { session: { user: { id: 'owner-42' } } },
        error: null,
      });
      state.subscribe.mockImplementation((callback: (value: string) => void) => {
        callback(status);
        return { id: 'quotes' };
      });
      const onStatus = vi.fn();

      subscribeMarketUpdates(vi.fn(), vi.fn(), onStatus);
      await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(status));

      expect(onStatus).toHaveBeenCalledOnce();
    },
  );
});
