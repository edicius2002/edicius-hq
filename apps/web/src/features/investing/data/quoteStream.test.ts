import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/auth/supabaseAuth', () => ({
  clearLocalSession: vi.fn(),
  getAccessToken: vi.fn(),
}));

const quoteBusState = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock('@/features/investing/data/quoteBus', () => ({ quoteBus: quoteBusState }));

import {
  applyTicks,
  mergeTick,
  openQuoteStream,
  type Tick,
} from '@/features/investing/data/quoteStream';
import type { Quote } from '@/shared/api/market';

afterEach(() => vi.clearAllMocks());

function quote(over: Partial<Quote> = {}): Quote {
  return {
    symbol: 'AAPL',
    price: 311,
    currency: 'USD',
    previousClose: 300,
    change: 11,
    changePercent: 3.67,
    provider: 'yahoo',
    time: 100,
    marketState: 'REGULAR',
    name: 'Apple Inc.',
    extended: false,
    ...over,
  };
}

function tick(over: Partial<Tick> = {}): Tick {
  return {
    symbol: 'AAPL',
    price: 312,
    marketState: 'REGULAR',
    extended: false,
    changePercent: 4,
    time: 1,
    ...over,
  };
}

describe('mergeTick', () => {
  it('takes the price from the tick and everything else from the sweep', () => {
    // A tick carries no previous close, no name and no currency — those are
    // what the sweep is for, and losing them would empty the row.
    const merged = mergeTick(quote(), tick({ price: 315 }));

    expect(merged.price).toBe(315);
    expect(merged.previousClose).toBe(300);
    expect(merged.name).toBe('Apple Inc.');
    expect(merged.currency).toBe('USD');
  });

  it('recomputes the change against the previous close rather than trusting the tick', () => {
    // Decision 8.16: the percentage answers "how is it doing today". A tick's
    // own percentage answers a different question during extended hours, and
    // taking it would let the two disagree on screen.
    const merged = mergeTick(
      quote({ previousClose: 300 }),
      tick({ price: 330, changePercent: 99 }),
    );

    expect(merged.change).toBe(30);
    expect(merged.changePercent).toBeCloseTo(10);
  });

  it('takes the extended flag from the tick rather than reading the words', () => {
    // The API decides this, because the REST path already did and two answers
    // to one question is how the vocabularies drifted apart in the first place.
    expect(mergeTick(quote(), tick({ marketState: 'PRE', extended: true })).extended).toBe(true);
    expect(mergeTick(quote(), tick({ marketState: 'REGULAR', extended: false })).extended).toBe(
      false,
    );
  });

  it('leaves the change unknown when there is nothing to measure against', () => {
    const merged = mergeTick(quote({ previousClose: null }), tick());

    expect(merged.change).toBeNull();
    expect(merged.changePercent).toBeNull();
  });
});

describe('applyTicks', () => {
  it('drops a tick for a symbol the sweep has not delivered', () => {
    // Half a row — a price with no close to measure it against — is worse
    // than no row.
    const before = new Map([['AAPL', quote()]]);

    const after = applyTicks(before, [tick({ symbol: 'NVDA', price: 1 })]);

    expect(after.has('NVDA')).toBe(false);
  });

  it('returns the same map when nothing moved, so React can skip the render', () => {
    const before = new Map([['AAPL', quote({ price: 311 })]]);

    expect(applyTicks(before, [tick({ price: 311 })])).toBe(before);
    expect(applyTicks(before, [])).toBe(before);
  });

  it('applies a session change even when its price is unchanged', () => {
    const before = new Map([['AAPL', quote({ price: 311, marketState: 'REGULAR' })]]);

    const after = applyTicks(before, [tick({ price: 311, marketState: 'POST', extended: true })]);

    expect(after).not.toBe(before);
    expect(after.get('AAPL')).toMatchObject({ marketState: 'POST', extended: true });
  });

  it('keeps the newest tick for a symbol when a batch is out of order', () => {
    const before = new Map([['AAPL', quote()]]);

    const after = applyTicks(before, [
      tick({ price: 320, time: 20 }),
      tick({ price: 315, time: 10 }),
    ]);

    expect(after.get('AAPL')?.price).toBe(320);
  });

  it('applies every symbol that moved', () => {
    const before = new Map([
      ['AAPL', quote()],
      ['MSFT', quote({ symbol: 'MSFT', price: 400, previousClose: 400 })],
    ]);

    const after = applyTicks(before, [tick({ price: 320 }), tick({ symbol: 'MSFT', price: 410 })]);

    expect(after.get('AAPL')?.price).toBe(320);
    expect(after.get('MSFT')?.price).toBe(410);
  });
});

describe('openQuoteStream', () => {
  function open(onTicks = vi.fn()) {
    const stop = vi.fn();
    let receive!: (ticks: Tick[]) => void;
    let status!: (status: string) => void;
    const subscribe = vi.fn(
      (next: (ticks: Tick[]) => void, nextStatus: (value: string) => void) => {
        receive = next;
        status = nextStatus;
        return stop;
      },
    );
    const close = openQuoteStream(['AAPL'], {
      onTicks,
      subscribe,
    });
    return { receive, status, close, onTicks, subscribe, stop };
  }

  it('hands on a thin Broadcast batch unchanged', () => {
    const { receive, onTicks } = open();
    const incoming = [tick({ price: 500, time: 200 })];

    receive(incoming);

    expect(onTicks).toHaveBeenCalledWith(incoming);
  });

  it('opens nothing when there is nothing to follow', () => {
    const subscribe = vi.fn();

    openQuoteStream([], { onTicks: vi.fn(), subscribe });

    expect(subscribe).not.toHaveBeenCalled();
  });

  it('filters Broadcast ticks to followed symbols and closes exactly once', () => {
    const { close, receive, onTicks, stop } = open();

    receive([tick({ symbol: 'MSFT' }), tick({ symbol: 'AAPL', price: 320 })]);
    close();
    close();

    expect(onTicks).toHaveBeenCalledWith([expect.objectContaining({ symbol: 'AAPL', price: 320 })]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not ingest an incomplete live tick into the full quote cache', () => {
    const { receive } = open();

    receive([tick()]);

    expect(quoteBusState.ingest).not.toHaveBeenCalled();
  });

  it('does not report live until Supabase confirms the subscription', () => {
    const onOpen = vi.fn();
    let status!: (value: string) => void;
    openQuoteStream(['AAPL'], {
      onTicks: vi.fn(),
      onOpen,
      subscribe: (_: (ticks: Tick[]) => void, nextStatus: (value: string) => void) => {
        status = nextStatus;
        return () => {};
      },
    });

    expect(onOpen).not.toHaveBeenCalled();
    status('SUBSCRIBED');
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('lowers the live latch on a terminal Realtime status and ignores later tick callbacks', () => {
    const onError = vi.fn();
    const onTicks = vi.fn();
    let receive!: (ticks: Tick[]) => void;
    let status!: (value: string) => void;
    openQuoteStream(['AAPL'], {
      onTicks,
      onError,
      subscribe: (next: (ticks: Tick[]) => void, nextStatus: (value: string) => void) => {
        receive = next;
        status = nextStatus;
        return () => {};
      },
    });

    status('CHANNEL_ERROR');
    receive([tick()]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onTicks).not.toHaveBeenCalled();
  });
});
