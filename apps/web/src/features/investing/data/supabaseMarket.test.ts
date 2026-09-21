import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const single = vi.fn();
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const maybeSingle = vi.fn();
  const gt = vi.fn(() => ({ maybeSingle }));
  const requestSingle = vi.fn();
  const eq = vi.fn(() => ({ single: requestSingle }));
  const quotesIn = vi.fn();
  const quotesSelect = vi.fn(() => ({ in: quotesIn }));
  const from = vi.fn((table: string) => {
    if (table === 'collector_requests') return { insert, select: vi.fn(() => ({ eq })) };
    if (table === 'market_bars')
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ gt })) })) })),
        })),
      };
    return { select: quotesSelect };
  });
  const subscribe = vi.fn();
  const on = vi.fn((...args: unknown[]) => {
    void args;
    return { subscribe };
  });
  const channel = vi.fn(() => ({ on }));
  const removeChannel = vi.fn();
  const getSession = vi.fn();
  return {
    auth: { getSession },
    from,
    insert,
    select,
    single,
    maybeSingle,
    gt,
    quotesIn,
    channel,
    on,
    subscribe,
    removeChannel,
    getSession,
    eq,
    requestSingle,
  };
});

vi.mock('@/shared/supabase/client', () => ({ supabase: state }));

import { getBars, getQuotes, searchSymbols, subscribeQuoteTicks } from './supabaseMarket';

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
  it('reads owner-visible quote rows and preserves the shared wire shape', async () => {
    state.quotesIn.mockResolvedValue({
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
    state.quotesIn.mockResolvedValue({ data: null, error: { message: 'policy detail: owner-42' } });

    await expect(getQuotes(['AAPL'])).rejects.toMatchObject({ code: 'quotes_unavailable' });
  });

  it('returns a fresh cached bars result without creating a collector request', async () => {
    state.maybeSingle.mockResolvedValue({
      data: { provider: 'worker', payload: BARS },
      error: null,
    });

    await expect(getBars('AAPL', '1d')).resolves.toEqual(BARS);
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
    expect(state.gt).toHaveBeenCalledWith('expires_at', '2026-09-18T16:00:00.000Z');
    expect(state.insert).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'market-bars' }),
    );
    vi.useRealTimers();
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
    state.requestSingle.mockResolvedValue({ data: null, error: { message: 'RLS body' } });

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

  it('times out at twenty seconds and removes its channel exactly once', async () => {
    vi.useFakeTimers();
    state.maybeSingle.mockResolvedValue({ data: null, error: null });
    state.single.mockResolvedValue({ data: { request_id: 'request-5' }, error: null });
    state.subscribe.mockReturnValue({ id: 'request' });

    const pending = getBars('AAPL', '1d');
    const rejection = expect(pending).rejects.toThrow('request_timeout');
    await vi.advanceTimersByTimeAsync(20_000);

    await rejection;
    expect(state.removeChannel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('joins the authenticated owner private topic and emits only valid ticks', async () => {
    state.getSession.mockResolvedValue({
      data: { session: { user: { id: 'owner-42' } } },
      error: null,
    });
    let receive!: (event: { payload: unknown }) => void;
    state.on.mockImplementation((...args: unknown[]) => {
      receive = args[2] as (event: { payload: unknown }) => void;
      return { subscribe: state.subscribe };
    });
    const onTicks = vi.fn();
    const close = subscribeQuoteTicks(onTicks);
    await vi.waitFor(() => expect(state.channel).toHaveBeenCalledOnce());

    expect(state.channel).toHaveBeenCalledWith('market-quotes:owner-42', {
      config: { private: true },
    });
    expect(state.on).toHaveBeenCalledWith('broadcast', { event: 'ticks' }, expect.any(Function));
    receive({
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

  it('reports CHANNEL_ERROR and opens no channel when the session is missing', async () => {
    state.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const onStatus = vi.fn();

    subscribeQuoteTicks(vi.fn(), onStatus);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith('CHANNEL_ERROR'));

    expect(state.channel).not.toHaveBeenCalled();
  });

  it('reports a sanitized CHANNEL_ERROR when session lookup rejects', async () => {
    state.getSession.mockRejectedValue(new Error('secret session detail'));
    const onStatus = vi.fn();

    subscribeQuoteTicks(vi.fn(), onStatus);
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

    const close = subscribeQuoteTicks(vi.fn());
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

      subscribeQuoteTicks(vi.fn(), onStatus);
      await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(status));

      expect(onStatus).toHaveBeenCalledOnce();
    },
  );
});
