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
    const pre = epoch('2026-09-22T09:00:00-04:00');
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
      ['1w', '2026-09-21T00:00:00-04:00'],
      ['1M', '2026-09-01T00:00:00-04:00'],
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

/** A New York wall-clock time, with the zone's offset on that date. */
function ny(value: string): number {
  const summer = value >= '2026-03-08T02:00:00' && value < '2026-11-01T02:00:00';
  return epoch(`${value}${summer ? '-04:00' : '-05:00'}`);
}

function ohlcv(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): Bar {
  return { time, open, high, low, close, volume };
}

describe('Yahoo candle boundaries', () => {
  // The same vectors `services/api/app/adapters/yahoo_buckets.py` is tested
  // against, so the browser and the API agree on where each candle starts.
  const vectors: [string, string, string][] = [
    ['2026-09-24T10:14:35', '1m', '2026-09-24T10:14:00'],
    ['2026-09-24T10:14:35', '5m', '2026-09-24T10:10:00'],
    ['2026-09-24T10:14:35', '15m', '2026-09-24T10:00:00'],
    ['2026-09-24T10:14:35', '1h', '2026-09-24T09:30:00'],
    ['2026-09-24T09:15:00', '1h', '2026-09-24T09:00:00'],
    ['2026-09-24T16:45:00', '1h', '2026-09-24T16:00:00'],
    ['2026-09-24T15:59:59', '1h', '2026-09-24T15:30:00'],
    ['2026-09-24T05:00:00', '1d', '2026-09-24T09:30:00'],
    ['2026-09-24T18:00:00', '1d', '2026-09-24T09:30:00'],
    ['2026-09-24T10:14:35', '1w', '2026-09-21T00:00:00'],
    ['2026-09-08T10:00:00', '1w', '2026-09-07T00:00:00'], // Labor Day Monday
    ['2026-08-14T10:00:00', '1M', '2026-08-01T00:00:00'], // Saturday the 1st
    ['2026-11-04T10:00:00', '1w', '2026-11-02T00:00:00'], // after DST ends Nov 1
    ['2026-11-04T10:00:00', '1d', '2026-11-04T09:30:00'],
  ];

  it.each(vectors)('starts the candle for %s %s at %s', (input, timeframe, expected) => {
    const result = mergeLiveBars(
      [bar(ny('2026-01-02T09:30:00'))],
      undefined,
      tick({ time: ny(input), marketState: null, extended: true }),
      { ...CONTEXT, timeframe, extended: true },
    );

    expect(result.at(-1)?.time).toBe(ny(expected));
  });

  it.each([
    '2026-09-24T03:59:00',
    '2026-09-24T20:00:00',
    '2026-09-26T10:00:00', // Saturday
    '2026-09-27T10:00:00', // Sunday
  ])('has no intraday candle outside every session (%s)', (input) => {
    const base = [bar(ny('2026-09-23T15:55:00'))];
    const result = mergeLiveBars(
      base,
      undefined,
      tick({ time: ny(input), marketState: null, extended: true }),
      { ...CONTEXT, timeframe: '5m', extended: true },
    );

    expect(result).toEqual(base);
  });

  it('anchors an extended daily candle at 09:30, like Yahoo, not at the pre-market open', () => {
    const today = ny('2026-09-24T09:30:00');
    const base = [bar(ny('2026-09-23T09:30:00')), bar(today, 100, 500)];
    const result = mergeLiveBars(
      base,
      undefined,
      tick({ time: ny('2026-09-24T17:00:00'), marketState: 'POST', extended: true, price: 104 }),
      { ...CONTEXT, timeframe: '1d', extended: true },
    );

    expect(result).toHaveLength(2);
    expect(result.at(-1)).toEqual(ohlcv(today, 100, 104, 99, 104, 500));
  });
});

describe("Yahoo's trailing off-grid row in cached history", () => {
  // Shapes copied from the real fixtures captured 2026-09-24 ~10:19 New York
  // (`services/api/tests/fixtures/yahoo_chart_aapl_*_2026-09-24.json`).
  const snapshot = (time: number, price: number) => ohlcv(time, price, price, price, price, 0);

  it('lets the authoritative candle replace its bucket instead of losing to a snapshot row', () => {
    const tenTen = ny('2026-09-24T10:10:00');
    const base = [
      bar(ny('2026-09-24T10:00:00')),
      bar(ny('2026-09-24T10:05:00')),
      bar(tenTen, 100, 280_609),
      snapshot(ny('2026-09-24T10:15:25'), 101),
    ];
    const authoritative = liveBar({
      timeframe: '5m',
      asOf: ny('2026-09-24T10:15:10'),
      bar: ohlcv(tenTen, 100, 102, 98, 101, 300_000),
    });
    const result = mergeLiveBars(base, authoritative, undefined, { ...CONTEXT, timeframe: '5m' });

    expect(result.filter((candle) => candle.time === tenTen)).toEqual([authoritative.bar]);
    expect(result.map((candle) => candle.time)).not.toContain(ny('2026-09-24T10:15:25'));
    expect(result.every((candle) => candle.time % 300 === 0)).toBe(true);
  });

  it('folds a snapshot row into the candle already in progress', () => {
    const tenFifteen = ny('2026-09-24T10:15:00');
    const base = [
      ohlcv(ny('2026-09-24T10:10:00'), 337.855, 337.88, 336.93, 337.33, 280_609),
      ohlcv(tenFifteen, 337.35, 337.84, 337.35, 337.62, 161_450),
      snapshot(1790259541, 337.625),
    ];

    expect(mergeLiveBars(base, undefined, undefined, { ...CONTEXT, timeframe: '5m' })).toEqual([
      base[0],
      ohlcv(tenFifteen, 337.35, 337.84, 337.35, 337.625, 161_450),
    ]);
  });

  it("replaces the current week with the authoritative candle, dropping Yahoo's today row", () => {
    const week = ny('2026-09-21T00:00:00');
    const base = [
      ohlcv(ny('2026-09-14T00:00:00'), 334.79, 338.49, 328.35, 336.13, 230_286_700),
      ohlcv(week, 335.28, 345.34, 333.05, 337.02, 107_298_800),
      ohlcv(ny('2026-09-24T10:15:27'), 336.32, 338.26, 334.3, 337.6, 5_109_582),
    ];
    const authoritative = liveBar({
      timeframe: '1w',
      asOf: ny('2026-09-24T10:15:30'),
      bar: ohlcv(week, 335.28, 345.34, 333.05, 337.61, 112_408_382),
    });
    const result = mergeLiveBars(base, authoritative, undefined, { ...CONTEXT, timeframe: '1w' });

    expect(result).toEqual([base[0], authoritative.bar]);
  });

  it("folds Yahoo's today row into the current week when there is no authoritative candle", () => {
    const week = ny('2026-09-21T00:00:00');
    const base = [
      ohlcv(week, 335.28, 345.34, 333.05, 337.02, 107_298_800),
      ohlcv(1790259542, 336.32, 338.26, 334.3, 337.6, 5_109_582),
    ];

    expect(mergeLiveBars(base, undefined, undefined, { ...CONTEXT, timeframe: '1w' })).toEqual([
      ohlcv(week, 335.28, 345.34, 333.05, 337.6, 112_408_382),
    ]);
  });

  it('does not mutate a legacy series while normalizing it', () => {
    const base = [bar(ny('2026-09-24T10:15:00')), snapshot(ny('2026-09-24T10:19:01'), 102)];
    const before = structuredClone(base);

    mergeLiveBars(base, undefined, tick({ time: ny('2026-09-24T10:19:30') }), {
      ...CONTEXT,
      timeframe: '5m',
    });

    expect(base).toEqual(before);
  });

  it('leaves a sessionless series untouched', () => {
    const base = [bar(epoch('2026-09-22T10:34:56Z'))];
    const context = { symbol: 'BTCUSDT', timeframe: '1m', extended: false, hasSession: false };

    expect(mergeLiveBars(base, undefined, undefined, context)).toBe(base);
  });

  // Each history tail is the fixture's last rows; the tick lands after them.
  const tails: [string, Bar[], string][] = [
    [
      '1m',
      [
        ohlcv(ny('2026-09-24T10:18:00'), 337.76, 337.8, 337.45, 337.62, 49_537),
        snapshot(1790259541, 337.625),
      ],
      '2026-09-24T10:19:00',
    ],
    [
      '5m',
      [
        ohlcv(ny('2026-09-24T10:10:00'), 337.855, 337.88, 336.93, 337.33, 280_609),
        ohlcv(ny('2026-09-24T10:15:00'), 337.35, 337.84, 337.35, 337.62, 161_450),
        snapshot(1790259541, 337.625),
      ],
      '2026-09-24T10:15:00',
    ],
    [
      '15m',
      [
        ohlcv(ny('2026-09-24T10:00:00'), 337.32, 338.26, 336.75, 337.33, 1_151_039),
        ohlcv(ny('2026-09-24T10:15:00'), 337.35, 337.84, 337.35, 337.62, 161_450),
        snapshot(1790259541, 337.63),
      ],
      '2026-09-24T10:15:00',
    ],
    [
      '1h',
      [
        ohlcv(ny('2026-09-23T15:30:00'), 336.33, 337.14, 335.61, 336.95, 4_117_350),
        ohlcv(ny('2026-09-24T09:30:00'), 336.32, 338.26, 334.3, 337.62, 5_106_366),
        snapshot(1790259541, 337.63),
      ],
      '2026-09-24T09:30:00',
    ],
    [
      '1d',
      [
        ohlcv(ny('2026-09-23T09:30:00'), 341.08, 341.8, 335.5, 337.02, 31_587_800),
        ohlcv(ny('2026-09-24T09:30:00'), 336.32, 338.26, 334.3, 337.63, 5_107_978),
      ],
      '2026-09-24T09:30:00',
    ],
    [
      '1w',
      [
        ohlcv(ny('2026-09-14T00:00:00'), 334.79, 338.49, 328.35, 336.13, 230_286_700),
        ohlcv(ny('2026-09-21T00:00:00'), 335.28, 345.34, 333.05, 337.02, 107_298_800),
        ohlcv(1790259542, 336.32, 338.26, 334.3, 337.6, 5_109_582),
      ],
      '2026-09-21T00:00:00',
    ],
    [
      '1M',
      [
        ohlcv(ny('2026-08-01T00:00:00'), 309.58, 322.37, 300.57, 316.85, 902_409_200),
        ohlcv(ny('2026-09-01T00:00:00'), 316.98, 345.34, 309.9, 337.02, 723_207_900),
        ohlcv(1790259542, 336.32, 338.26, 334.3, 337.6, 5_109_582),
      ],
      '2026-09-01T00:00:00',
    ],
  ];

  it.each(tails)(
    'moves the %s candle in progress with a tick alone',
    (timeframe, base, current) => {
      const result = mergeLiveBars(
        base,
        undefined,
        tick({ time: ny('2026-09-24T10:19:30'), price: 350 }),
        { ...CONTEXT, timeframe },
      );

      expect(result.at(-1)).toMatchObject({ time: ny(current), high: 350, close: 350 });
      expect(result.filter((candle) => candle.time === ny(current))).toHaveLength(1);
    },
  );

  it('moves the extended daily candle in progress rather than dropping the tick', () => {
    const today = ny('2026-09-24T09:30:00');
    const base = [bar(ny('2026-09-23T09:30:00')), bar(today)];
    const result = mergeLiveBars(base, undefined, tick({ time: ny('2026-09-24T10:19:30') }), {
      ...CONTEXT,
      timeframe: '1d',
      extended: true,
    });

    expect(result).toHaveLength(2);
    expect(result.at(-1)).toMatchObject({ time: today, close: 103 });
  });
});

describe('an authoritative candle off the Yahoo grid', () => {
  // What a collector still running the old anchors sends: 09:30 Monday for a
  // week, 09:30 on the 1st for a month, 04:00 for an extended day.
  const week = ny('2026-09-21T00:00:00');
  const month = ny('2026-09-01T00:00:00');
  const thursday = tick({ time: ny('2026-09-24T10:20:00'), price: 340 });

  it.each([
    ['1w', week, ny('2026-09-21T09:30:00')],
    ['1M', month, ny('2026-09-01T09:30:00')],
  ])(
    'does not add a second %s candle, and the tick still moves the one in progress',
    (timeframe, current, offGrid) => {
      const base = [bar(current - 7 * 86_400), bar(current, 337)];
      const authoritative = liveBar({
        timeframe,
        asOf: ny('2026-09-24T10:19:00'),
        bar: bar(offGrid),
      });
      const result = mergeLiveBars(base, authoritative, thursday, { ...CONTEXT, timeframe });

      expect(result.map((candle) => candle.time)).toEqual([current - 7 * 86_400, current]);
      expect(result.at(-1)?.close).toBe(340);
    },
  );

  it('ignores a pre-market-anchored extended day rather than drawing it at 04:00', () => {
    const today = ny('2026-09-24T09:30:00');
    const base = [bar(ny('2026-09-23T09:30:00')), bar(today, 337)];
    const authoritative = liveBar({
      timeframe: '1d',
      extended: true,
      asOf: ny('2026-09-24T10:19:00'),
      bar: bar(ny('2026-09-24T04:00:00'), 999),
    });
    const result = mergeLiveBars(base, authoritative, undefined, {
      ...CONTEXT,
      timeframe: '1d',
      extended: true,
    });

    expect(result).toBe(base);
  });
});
