/**
 * The US equity session clock.
 *
 * Three regimes, not two. Between 20:00 and 04:00 ET nothing trades at all, so
 * polling then spends the upstream budget on data that does not exist — see the
 * cadence table in INV-02. The overlay of extended-hours candles is cleared at
 * the regular open, which is the other thing this has to be able to say.
 *
 * Everything is computed in `America/New_York` through `Intl`, so daylight
 * saving is handled by the platform rather than by an offset we would get wrong
 * twice a year.
 */

export type Regime = 'regular' | 'extended' | 'closed';

export const EXCHANGE_TIME_ZONE = 'America/New_York';

/** Minutes from midnight, in exchange time. */
const PRE_OPEN = 4 * 60;
const REGULAR_OPEN = 9 * 60 + 30;
const REGULAR_CLOSE = 16 * 60;
const POST_CLOSE = 20 * 60;

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: EXCHANGE_TIME_ZONE,
  weekday: 'short',
  hour: 'numeric',
  minute: 'numeric',
  hour12: false,
});

export type ExchangeTime = {
  /** Minutes from midnight in exchange time. */
  minutes: number;
  /** 0 is Sunday, matching `Date.getDay`. */
  weekday: number;
};

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function exchangeTime(at: Date): ExchangeTime {
  const parts = PARTS.formatToParts(at);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';

  // `hour12: false` renders midnight as 24 in some engines; both mean 0.
  const hour = Number(read('hour')) % 24;
  return {
    minutes: hour * 60 + Number(read('minute')),
    weekday: WEEKDAYS[read('weekday')] ?? 0,
  };
}

function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
}

/**
 * Which regime a moment falls in.
 *
 * Market holidays are not modelled: on one the exchange reports no trades, and
 * the rule that no candle is ever invented means an empty chart rather than a
 * wrong one. Polling a little on a holiday is cheaper than carrying a calendar
 * that goes stale.
 */
export function regimeAt(at: Date): Regime {
  const { minutes, weekday } = exchangeTime(at);
  if (isWeekend(weekday)) return 'closed';
  if (minutes >= REGULAR_OPEN && minutes < REGULAR_CLOSE) return 'regular';
  if (minutes >= PRE_OPEN && minutes < POST_CLOSE) return 'extended';
  return 'closed';
}

/** Whether a bar's own timestamp puts it outside the regular session. */
export function isExtendedBar(time: number): boolean {
  return regimeAt(new Date(time * 1000)) !== 'regular';
}

/** Timeframes where one bar covers a whole session or more. */
const SESSION_OR_LONGER = new Set(['1d', '1w', '1M']);

export function coversWholeSession(timeframe: string): boolean {
  return SESSION_OR_LONGER.has(timeframe);
}

/**
 * Whether a bar draws as an extended-hours one.
 *
 * Two rules, because a daily bar is not an intraday bar with a longer period.
 *
 * Intraday, a bar is asked whether *it* falls outside the session, which is what
 * an 08:00 or an 18:00 candle is.
 *
 * Daily and longer, that question is useless: every daily bar is stamped at the
 * regular open, so it would always answer "regular" and today's candle would
 * never fade. What makes the last one different is that it is still forming —
 * so it is the extended one whenever the market is not currently open, and
 * turns solid at the bell.
 */
export function makeIsExtended(
  timeframe: string,
  regime: Regime,
  barCount: number,
): (time: number, index: number) => boolean {
  if (coversWholeSession(timeframe)) {
    const lastIndex = barCount - 1;
    return (_time, index) => regime !== 'regular' && index === lastIndex;
  }
  return (time) => isExtendedBar(time);
}

/**
 * Whether the regular session opened between two moments.
 *
 * This is what clears the overlay: rather than scheduling a timer at 9:30 —
 * which a sleeping laptop would miss — each poll asks whether the open happened
 * since the last one.
 */
export function openedBetween(previous: Date, now: Date): boolean {
  if (now <= previous) return false;
  return regimeAt(previous) !== 'regular' && regimeAt(now) === 'regular';
}

export type Cadence = {
  /** How often to refetch bars, or null while nothing is trading. */
  barsMs: number | null;
  quotesMs: number;
};

/**
 * How often to ask, by regime. The numbers come from the measurement in INV-02:
 * one cadence around the clock is ~66k requests a day, three regimes is ~24.5k,
 * and the night alone falls from 48.3k to 6.6k.
 *
 * `streaming` slows the quote poll from a cadence to a **sweep**. With prices
 * arriving by push there is nothing left for a fast poll to discover, but the
 * sweep is not thereby optional: it covers the symbols that never trade and so
 * never tick, it carries the previous close and the name that a tick does not,
 * and its returning is what proves the stream is alive. See decision 8.18.
 */
export function cadenceFor(
  regime: Regime,
  timeframeMs: number,
  { streaming = false }: { streaming?: boolean } = {},
): Cadence {
  if (regime === 'regular') {
    return { barsMs: timeframeMs, quotesMs: streaming ? 60_000 : 15_000 };
  }
  if (regime === 'extended') {
    return { barsMs: 60_000, quotesMs: streaming ? 300_000 : 60_000 };
  }
  // Nothing trades, so bars are not asked for at all and quotes barely — and a
  // stream cannot improve on a market with no trades in it, so this is the one
  // regime the sweep rate does not change.
  return { barsMs: null, quotesMs: 900_000 };
}

/**
 * Crypto has no session. Everything above describes an exchange that closes,
 * and Binance does not — so a pair is always "regular" and never gets an
 * overlay.
 */
export function hasSession(provider: string): boolean {
  return provider !== 'binance';
}
