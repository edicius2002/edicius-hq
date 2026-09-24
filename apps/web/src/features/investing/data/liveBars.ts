import type { Bar } from '@/shared/api/market';

import type { Tick } from './quoteStream';

const TIMEFRAMES = new Set(['1m', '5m', '15m', '1h', '1d', '1w', '1M']);
const NEW_YORK = 'America/New_York';
const INTRADAY_MINUTES: Record<string, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
};
const SESSION_ANCHORS: Record<Session, [number, number]> = {
  PRE: [4, 0],
  REGULAR: [9, 30],
  POST: [16, 0],
};

type Session = 'PRE' | 'REGULAR' | 'POST';
type CalendarParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type LiveBarContext = {
  symbol: string;
  timeframe: string;
  extended: boolean;
  hasSession: boolean;
};

export type LiveBarUpdate = {
  symbol: string;
  timeframe: string;
  extended: boolean;
  asOf: number;
  bar: Bar;
};

/** A stable identity for a live-bar focus and its browser overlay. */
export function liveBarKey(
  value: Pick<LiveBarUpdate, 'symbol' | 'timeframe' | 'extended'>,
): string {
  return `${value.symbol}:${value.timeframe}:${value.extended}`;
}

/**
 * Reconcile historical candles, an authoritative live candle, and one quote
 * tick without mutating any of the input layers.
 */
export function mergeLiveBars(
  base: Bar[],
  authoritative: LiveBarUpdate | null | undefined,
  tick: Tick | null | undefined,
  context: LiveBarContext,
): Bar[] {
  // A quote before the historical query has completed is retained by the
  // caller, but must not fabricate a chart candle.
  if (!base.length) return base;

  const usableAuthoritative = isMatchingUpdate(authoritative, context) ? authoritative : null;
  const withBar = usableAuthoritative ? applyAuthoritative(base, usableAuthoritative) : base;

  if (
    !tick ||
    tick.symbol !== context.symbol ||
    tick.time === null ||
    !Number.isFinite(tick.time)
  ) {
    return withBar;
  }
  if (usableAuthoritative && tick.time <= usableAuthoritative.asOf) return withBar;

  return applyTick(withBar, tick, context);
}

function isMatchingUpdate(
  update: LiveBarUpdate | null | undefined,
  context: LiveBarContext,
): update is LiveBarUpdate {
  return (
    !!update &&
    update.symbol === context.symbol &&
    update.timeframe === context.timeframe &&
    update.extended === context.extended &&
    Number.isFinite(update.asOf) &&
    isBar(update.bar)
  );
}

function isBar(value: Bar | undefined): value is Bar {
  return (
    !!value &&
    Number.isFinite(value.time) &&
    Number.isFinite(value.open) &&
    Number.isFinite(value.high) &&
    Number.isFinite(value.low) &&
    Number.isFinite(value.close) &&
    Number.isFinite(value.volume)
  );
}

function applyAuthoritative(base: Bar[], update: LiveBarUpdate): Bar[] {
  const lastIndex = base.length - 1;
  const last = base[lastIndex];
  if (last && last.time === update.bar.time) {
    const next = base.slice();
    next[lastIndex] = update.bar;
    return next;
  }

  if (!last || update.bar.time <= last.time) return base;
  return [...base, update.bar];
}

function applyTick(base: Bar[], tick: Tick, context: LiveBarContext): Bar[] {
  if (context.hasSession && !context.extended && tick.extended) return base;

  const bucket = bucketStart(tick.time as number, context.timeframe, context, tick.marketState);
  if (bucket === null) return base;

  const last = base.at(-1);
  if (!last || bucket < last.time) return base;

  const next = base.slice();
  if (bucket === last.time) {
    next[next.length - 1] = updateBar(last, tick.price);
    return next;
  }
  next.push(provisional(bucket, tick.price));
  return next;
}

function updateBar(bar: Bar, price: number): Bar {
  return {
    ...bar,
    high: Math.max(bar.high, price),
    low: Math.min(bar.low, price),
    close: price,
  };
}

function provisional(time: number, price: number): Bar {
  return { time, open: price, high: price, low: price, close: price, volume: 0 };
}

/**
 * Find the provider/session bucket for a quote timestamp. The function is
 * intentionally private: bucket identity is an implementation detail of the
 * merge and should not become a second public wire contract.
 */
function bucketStart(
  timestamp: number,
  timeframe: string,
  context: LiveBarContext,
  marketState: string | null,
): number | null {
  if (!TIMEFRAMES.has(timeframe)) return null;
  return context.hasSession
    ? yahooBucketStart(timestamp, timeframe, context.extended, marketState)
    : utcBucketStart(timestamp, timeframe);
}

function yahooBucketStart(
  timestamp: number,
  timeframe: string,
  extended: boolean,
  marketState: string | null,
): number | null {
  const local = localParts(timestamp);
  const session = sessionAt(local, marketState);
  if (!session) return null;

  if (!(timeframe in INTRADAY_MINUTES)) {
    const [hour, minute] = SESSION_ANCHORS[extended ? 'PRE' : 'REGULAR'];
    const date = timeframe === '1d' ? local : periodDate(local, timeframe);
    return fromNewYorkParts({ ...date, hour, minute, second: 0 });
  }

  const [anchorHour, anchorMinute] = SESSION_ANCHORS[session];
  const period = INTRADAY_MINUTES[timeframe];
  const elapsed = local.hour * 60 + local.minute - (anchorHour * 60 + anchorMinute);
  const minutes = anchorHour * 60 + anchorMinute + Math.floor(elapsed / period) * period;
  const date = addUtcDays({ year: local.year, month: local.month, day: local.day }, 0);
  const naive = new Date(Date.UTC(date.year, date.month - 1, date.day, 0, minutes));
  const bucketDate = {
    year: naive.getUTCFullYear(),
    month: naive.getUTCMonth() + 1,
    day: naive.getUTCDate(),
    hour: naive.getUTCHours(),
    minute: naive.getUTCMinutes(),
    second: 0,
  };
  return fromNewYorkParts(bucketDate);
}

function utcBucketStart(timestamp: number, timeframe: string): number {
  const seconds = Math.floor(timestamp);
  const date = new Date(seconds * 1000);

  if (timeframe === '1m' || timeframe === '5m' || timeframe === '15m' || timeframe === '1h') {
    const period =
      timeframe === '1m' ? 60 : timeframe === '5m' ? 300 : timeframe === '15m' ? 900 : 3600;
    return Math.floor(seconds / period) * period;
  }

  if (timeframe === '1d') {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
  }
  if (timeframe === '1w') {
    const weekday = date.getUTCDay();
    const daysFromMonday = (weekday + 6) % 7;
    return (
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysFromMonday) / 1000
    );
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
}

function sessionAt(local: CalendarParts, marketState: string | null): Session | null {
  const supplied = marketState?.toUpperCase();
  if (supplied === 'PRE' || supplied === 'REGULAR' || supplied === 'POST') return supplied;
  if (supplied === 'CLOSED') return null;
  if (localDayOfWeek(local) >= 5) return null;

  const minutes = local.hour * 60 + local.minute;
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'PRE';
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'REGULAR';
  if (minutes >= 16 * 60 && minutes < 20 * 60) return 'POST';
  return null;
}

function localParts(timestamp: number): CalendarParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp * 1000)).map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function fromNewYorkParts(parts: CalendarParts): number {
  // Treat the requested local date/time as a UTC calendar value first, then
  // derive the actual New York offset through Intl. This handles DST without
  // embedding an offset that would be wrong for half the year.
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const observed = localParts(naive / 1000);
  const observedAsUtc = Date.UTC(
    observed.year,
    observed.month - 1,
    observed.day,
    observed.hour,
    observed.minute,
    observed.second,
  );
  return Math.floor((naive + (naive - observedAsUtc)) / 1000);
}

function periodDate(
  local: CalendarParts,
  timeframe: string,
): Pick<CalendarParts, 'year' | 'month' | 'day'> {
  if (timeframe === '1M') return { year: local.year, month: local.month, day: 1 };
  const utcDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const weekday = utcDate.getUTCDay();
  const daysFromMonday = (weekday + 6) % 7;
  return addUtcDays({ year: local.year, month: local.month, day: local.day }, -daysFromMonday);
}

function addUtcDays(
  date: Pick<CalendarParts, 'year' | 'month' | 'day'>,
  days: number,
): Pick<CalendarParts, 'year' | 'month' | 'day'> {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localDayOfWeek(local: CalendarParts): number {
  return new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
}
