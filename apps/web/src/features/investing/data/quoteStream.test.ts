import { describe, expect, it, vi } from 'vitest';

import {
  applyTicks,
  mergeTick,
  openQuoteStream,
  streamUrl,
  type Tick,
} from '@/features/investing/data/quoteStream';
import type { Quote } from '@/shared/api/market';

function quote(over: Partial<Quote> = {}): Quote {
  return {
    symbol: 'AAPL',
    price: 311,
    currency: 'USD',
    previousClose: 300,
    change: 11,
    changePercent: 3.67,
    provider: 'yahoo',
    marketState: 'REGULAR',
    name: 'Apple Inc.',
    extended: false,
    ...over,
  };
}

function tick(over: Partial<Tick> = {}): Tick {
  return { symbol: 'AAPL', price: 312, marketState: 'REGULAR', changePercent: 4, time: 1, ...over };
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

  it('marks the price extended when the tick says the session is', () => {
    expect(mergeTick(quote(), tick({ marketState: 'PRE' })).extended).toBe(true);
    expect(mergeTick(quote(), tick({ marketState: 'POST' })).extended).toBe(true);
    expect(mergeTick(quote(), tick({ marketState: 'REGULAR' })).extended).toBe(false);
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

describe('streamUrl', () => {
  it('asks for every symbol in one connection', () => {
    // Ten symbols must cost one socket, for the same reason quotes are batched.
    expect(streamUrl(['AAPL', 'MSFT'])).toContain('symbols=AAPL%2CMSFT');
  });
});

class FakeSource {
  listeners = new Map<string, (event: Event) => void>();
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, handler: (event: Event) => void) {
    this.listeners.set(type, handler);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: string) {
    this.listeners.get(type)?.(
      data === undefined ? new Event(type) : (new MessageEvent(type, { data }) as Event),
    );
  }
}

describe('openQuoteStream', () => {
  function open(onTicks = vi.fn()) {
    let source!: FakeSource;
    const close = openQuoteStream(['AAPL'], {
      onTicks,
      create: (url) => {
        source = new FakeSource(url);
        return source as unknown as EventSource;
      },
    });
    return { source, close, onTicks };
  }

  it('hands on the batch it was sent', () => {
    const { source, onTicks } = open();

    source.emit('quotes', JSON.stringify([tick({ price: 500 })]));

    expect(onTicks).toHaveBeenCalledWith([expect.objectContaining({ price: 500 })]);
  });

  it('ignores a frame it cannot read rather than throwing', () => {
    // The stream is an optimisation over the sweep. It must never be able to
    // break the thing it is optimising.
    const { source, onTicks } = open();

    expect(() => source.emit('quotes', 'not json')).not.toThrow();
    expect(() => source.emit('quotes', JSON.stringify({ nope: true }))).not.toThrow();
    expect(onTicks).not.toHaveBeenCalled();
  });

  it('opens nothing when there is nothing to follow', () => {
    const create = vi.fn();

    openQuoteStream([], { onTicks: vi.fn(), create });

    expect(create).not.toHaveBeenCalled();
  });

  it('closes the connection when told to', () => {
    const { source, close } = open();

    close();

    expect(source.closed).toBe(true);
  });
});
