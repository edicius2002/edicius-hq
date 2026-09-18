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
  const on = vi.fn(() => ({ subscribe }));
  const channel = vi.fn(() => ({ on }));
  const removeChannel = vi.fn();
  return {
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
    eq,
    requestSingle,
  };
});

vi.mock('@/shared/supabase/client', () => ({ supabase: state }));

import { getBars, getQuotes, searchSymbols, subscribeQuotes } from './supabaseMarket';

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

  it('returns a fresh cached bars result without creating a collector request', async () => {
    state.maybeSingle.mockResolvedValue({
      data: { provider: 'worker', payload: BARS },
      error: null,
    });

    await expect(getBars('AAPL', '1d')).resolves.toEqual(BARS);
    expect(state.insert).not.toHaveBeenCalled();
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

  it('maps owner-visible quote updates and removes the Realtime channel', () => {
    const receive = vi.fn();
    let handler!: (event: { new: unknown }) => void;
    (
      state.on as unknown as { mockImplementation: (fn: (...args: unknown[]) => unknown) => void }
    ).mockImplementation((_, __, next) => {
      handler = next as (event: { new: unknown }) => void;
      return { subscribe: state.subscribe };
    });
    state.subscribe.mockImplementation(() => ({ id: 'quotes' }));
    const close = subscribeQuotes(receive);

    handler({
      new: {
        symbol: 'AAPL',
        provider: 'worker',
        market_time: 2,
        payload: { price: 201, currency: 'USD', previousClose: 190, extended: false },
      },
    });
    close();

    expect(receive).toHaveBeenCalledWith([
      expect.objectContaining({ symbol: 'AAPL', time: 2, price: 201 }),
    ]);
    expect(state.removeChannel).toHaveBeenCalled();
  });
});
