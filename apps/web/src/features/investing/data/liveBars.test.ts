import { describe, expect, it } from 'vitest';

import type { Bar } from '@/shared/api/market';

import { liveBarKey, mergeLiveBars, type LiveBarContext, type LiveBarUpdate } from './liveBars';
import type { Tick } from './quoteStream';

function epoch(value: string): number {
  return Math.floor(Date.parse(value) / 1000);
}

function bar(time: number, close = 100, volume = 50): Bar {
  return { time, open: 100, high: 101, low: 99, close, volume };
}

function liveBar(overrides: Partial<LiveBarUpdate> = {}): LiveBarUpdate {
  return {
    symbol: 'AAPL',
    timeframe: '1h',
    extended: false,
    asOf: 200,
    bar: bar(epoch('2026-09-22T09:30:00-04:00'), 101, 80),
    ...overrides,
  };
}

function tick(overrides: Partial<Tick> = {}): Tick {
  return {
    symbol: 'AAPL',
    price: 103,
    marketState: 'REGULAR',
    extended: false,
    changePercent: null,
    time: 201,
    ...overrides,
  };
}

const LAST_TIME = epoch('2026-09-22T09:30:00-04:00');
const BASE: Bar[] = [bar(epoch('2026-09-22T08:30:00-04:00'), 100, 70), bar(LAST_TIME)];
const CONTEXT: LiveBarContext = {
  symbol: 'AAPL',
  timeframe: '1h',
  extended: false,
  hasSession: true,
};

describe('live candle reconciliation', () => {
  it('keys an authoritative bar by its chart identity', () => {
    expect(liveBarKey({ symbol: 'AAPL', timeframe: '15m', extended: true })).toBe('AAPL:15m:true');
  });

  it('replays a newer tick after replacing the authoritative OHLCV bar', () => {
    const result = mergeLiveBars(
      BASE,
      liveBar({ asOf: 200, bar: bar(LAST_TIME, 101, 80) }),
      tick({ time: epoch('2026-09-22T09:45:00-04:00'), price: 103 }),
      CONTEXT,
    );

    expect(result.at(-1)).toEqual({
      time: LAST_TIME,
      open: 100,
      high: 103,
      low: 99,
      close: 103,
      volume: 80,
    });
  });

  it('does not replay a tick at or before the authoritative watermark', () => {
    const authoritative = liveBar({ asOf: 200, bar: bar(LAST_TIME, 101, 80) });

    expect(
      mergeLiveBars(BASE, authoritative, tick({ time: 200, price: 103 }), CONTEXT).at(-1),
    ).toEqual(authoritative.bar);
    expect(
      mergeLiveBars(BASE, authoritative, tick({ time: 199, price: 103 }), CONTEXT).at(-1),
    ).toEqual(authoritative.bar);
  });

  it('accepts downward authoritative OHLCV corrections', () => {
    const corrected = bar(LAST_TIME, 98, 20);
    corrected.high = 99;
    corrected.low = 95;

    expect(
      mergeLiveBars(BASE, liveBar({ asOf: 210, bar: corrected }), undefined, CONTEXT).at(-1),
    ).toEqual(corrected);
  });

  it('replaces equal bars, appends newer bars, and ignores older bars', () => {
    const replacement = liveBar({ asOf: 220, bar: bar(LAST_TIME, 105, 90) });
    const appended = liveBar({ asOf: 221, bar: bar(LAST_TIME + 3600, 106, 91) });
    const older = liveBar({ asOf: 222, bar: bar(LAST_TIME - 3600, 70, 1) });

    expect(mergeLiveBars(BASE, replacement, undefined, CONTEXT).at(-1)).toEqual(replacement.bar);
    expect(mergeLiveBars(BASE, appended, undefined, CONTEXT).at(-1)).toEqual(appended.bar);
    expect(mergeLiveBars(BASE, older, undefined, CONTEXT)).toEqual(BASE);
  });

  it('does not mutate the base array or its bars', () => {
    const before = structuredClone(BASE);
    const result = mergeLiveBars(BASE, liveBar({ bar: bar(LAST_TIME, 101, 80) }), tick(), CONTEXT);

    expect(BASE).toEqual(before);
    expect(result).not.toBe(BASE);
  });

  it('does not invent a candle when history is empty', () => {
    const empty: Bar[] = [];

    expect(mergeLiveBars(empty, liveBar(), tick(), CONTEXT)).toBe(empty);
  });

  it('updates only OHLC for a tick in the current bucket', () => {
    const base = [bar(LAST_TIME, 100, 123)];

    expect(
      mergeLiveBars(
        base,
        undefined,
        tick({ time: epoch('2026-09-22T09:45:00-04:00'), price: 97 }),
        CONTEXT,
      ).at(-1),
    ).toEqual({ time: LAST_TIME, open: 100, high: 101, low: 97, close: 97, volume: 123 });
  });

  it('creates a zero-volume provisional candle for a later bucket', () => {
    const regular = epoch('2026-09-22T09:30:00-04:00');
    const result = mergeLiveBars(
      [bar(regular, 101)],
      undefined,
      tick({ time: epoch('2026-09-22T10:30:00-04:00'), price: 102 }),
      CONTEXT,
    );

    expect(result.at(-1)).toEqual({
      time: epoch('2026-09-22T10:30:00-04:00'),
      open: 102,
      high: 102,
      low: 102,
      close: 102,
      volume: 0,
    });
  });

  it('does not let an extended tick mutate a regular-only series', () => {
    const regular = epoch('2026-09-22T15:30:00-04:00');

    expect(
      mergeLiveBars(
        [bar(regular)],
        undefined,
        tick({ extended: true, marketState: 'POST', time: epoch('2026-09-22T16:15:00-04:00') }),
        { ...CONTEXT, timeframe: '15m' },
      ),
    ).toEqual([bar(regular)]);
  });

  it('keeps pre, regular, and post intraday buckets separate', () => {
    const pre = epoch('2026-09-22T08:30:00-04:00');
    const regular = epoch('2026-09-22T09:30:00-04:00');
    const post = epoch('2026-09-22T16:00:00-04:00');
    const context = { ...CONTEXT, extended: true, timeframe: '1h' };

    expect(
      mergeLiveBars(
        [bar(pre)],
        undefined,
        tick({ extended: false, marketState: 'REGULAR', time: regular, price: 102 }),
        context,
      ).at(-1),
    ).toEqual({ time: regular, open: 102, high: 102, low: 102, close: 102, volume: 0 });

    const regularBase = [bar(epoch('2026-09-22T15:30:00-04:00'))];
    const result = mergeLiveBars(
      regularBase,
      undefined,
      tick({
        extended: true,
        marketState: 'POST',
        time: epoch('2026-09-22T16:15:00-04:00'),
        price: 103,
      }),
      context,
    );
    expect(result[0]).toEqual(regularBase[0]);
    expect(result.at(-1)).toEqual({
      time: post,
      open: 103,
      high: 103,
      low: 103,
      close: 103,
      volume: 0,
    });
  });

  it('anchors New York regular candles at 09:30 through daylight-saving changes', () => {
    const context = { ...CONTEXT, timeframe: '1h' };
    const cases = [
      '2026-03-09T09:30:00-04:00', // first Monday after spring-forward
      '2026-11-02T09:30:00-05:00', // first Monday after fall-back
    ];

    for (const value of cases) {
      const start = epoch(value);
      const result = mergeLiveBars(
        [bar(1)],
        undefined,
        tick({ time: start + 120, marketState: 'REGULAR' }),
        context,
      );
      expect(result.at(-1)?.time).toBe(start);
    }
  });

  it('uses New York calendar boundaries for every supported Yahoo timeframe', () => {
    const expected = new Map([
      ['1m', '2026-09-22T10:34:00-04:00'],
      ['5m', '2026-09-22T10:30:00-04:00'],
      ['15m', '2026-09-22T10:30:00-04:00'],
      ['1h', '2026-09-22T10:30:00-04:00'],
      ['1d', '2026-09-22T09:30:00-04:00'],
      ['1w', '2026-09-21T09:30:00-04:00'],
      ['1M', '2026-09-01T09:30:00-04:00'],
    ]);

    for (const [timeframe, value] of expected) {
      const result = mergeLiveBars(
        [bar(1)],
        undefined,
        tick({ time: epoch('2026-09-22T10:34:56-04:00') }),
        { ...CONTEXT, timeframe },
      );
      expect(result.at(-1)?.time, timeframe).toBe(epoch(value));
    }
  });

  it('uses UTC calendar boundaries for every supported Binance timeframe', () => {
    const expected = new Map([
      ['1m', '2026-09-22T10:34:00Z'],
      ['5m', '2026-09-22T10:30:00Z'],
      ['15m', '2026-09-22T10:30:00Z'],
      ['1h', '2026-09-22T10:00:00Z'],
      ['1d', '2026-09-22T00:00:00Z'],
      ['1w', '2026-09-21T00:00:00Z'],
      ['1M', '2026-09-01T00:00:00Z'],
    ]);

    for (const [timeframe, value] of expected) {
      const result = mergeLiveBars(
        [bar(1)],
        undefined,
        tick({ symbol: 'BTCUSDT', time: epoch('2026-09-22T10:34:56Z') }),
        { symbol: 'BTCUSDT', timeframe, extended: false, hasSession: false },
      );
      expect(result.at(-1)?.time, timeframe).toBe(epoch(value));
    }
  });
});
