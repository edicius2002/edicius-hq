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
// Yahoo appends a single off-grid row; one row of slack tolerates an odd tail
// while keeping each merge from scanning the whole history.
const MAX_OFF_GRID_TAIL = 2;
// Built once: every tick and every examined tail row reads New York time.
const NEW_YORK_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: NEW_YORK,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

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
  const withBar = reconcileHistory(base, usableAuthoritative, context);

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
    isBar(update.bar) &&
    onGrid(update.bar.time, context)
  );
}

/**
 * Whether a live candle starts where the history's candle for its period does.
 *
 * A collector still running older anchors — 09:30 Monday for a week, 04:00 for
 * an extended day — sends candles that match no historical one. Replacing
 * nothing, a later one would be appended as a second candle for the same
 * period, so it is refused and the tick keeps the candle moving instead.
 */
function onGrid(time: number, context: LiveBarContext): boolean {
  if (!context.hasSession || !TIMEFRAMES.has(context.timeframe)) return true;
  return yahooBucketStart(time, context.timeframe, null) === time;
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

/**
 * Apply the authoritative candle to history that may still end in rows which
 * are not candles of the series.
 *
 * Yahoo ends a chart response with a row stamped at the current quote time:
 * a zero-volume snapshot on intraday series, and today's daily bar on weekly
 * and monthly ones (whose period row then excludes today). The API folds that
 * row away now, but series cached before it did — in IndexedDB, Supabase, or
 * React Query — still carry it, and it outranks every live candle by `time`.
 * Only the tail can hold such a row, so only the last few rows are examined
 * rather than the whole series on every tick.
 */
function reconcileHistory(
  base: Bar[],
  authoritative: LiveBarUpdate | null,
  context: LiveBarContext,
): Bar[] {
  const normalizes = context.hasSession && TIMEFRAMES.has(context.timeframe);
  const offGridFrom = normalizes ? trailingOffGrid(base, context.timeframe) : base.length;
  const history = offGridFrom === base.length ? base : base.slice(0, offGridFrom);
  const withBar = authoritative ? applyAuthoritative(history, authoritative) : history;
  if (offGridFrom === base.length) return withBar;

  // The authoritative candle is the provider's whole aggregate for its bucket,
  // so an off-grid row in that bucket (or an earlier one) is a partial view of
  // what it already counts; folding it in would double today's volume.
  const supersededThrough = authoritative ? authoritative.bar.time : -Infinity;
  return foldOffGrid(withBar, base.slice(offGridFrom), context.timeframe, supersededThrough);
}

/** The index where the trailing run of off-grid rows begins, at most two rows back. */
function trailingOffGrid(base: Bar[], timeframe: string): number {
  let from = base.length;
  while (
    from > 0 &&
    base.length - from < MAX_OFF_GRID_TAIL &&
    yahooBucketStart(base[from - 1].time, timeframe, null) !== base[from - 1].time
  ) {
    from -= 1;
  }
  return from;
}

/**
 * Fold off-grid rows into candles, the same rule the API applies: a row joins
 * the candle its bucket names, starts the next candle when its bucket is new,
 * and is dropped when it has no bucket or its bucket is already behind. The
 * session is read from the clock, since a cached row carries no market state.
 */
function foldOffGrid(
  candles: Bar[],
  rows: Bar[],
  timeframe: string,
  supersededThrough: number,
): Bar[] {
  const next = candles.slice();
  for (const row of rows) {
    const start = yahooBucketStart(row.time, timeframe, null);
    if (start === null || start <= supersededThrough) continue;

    const previous = next.at(-1);
    if (previous && previous.time === start) {
      next[next.length - 1] = {
        ...previous,
        high: Math.max(previous.high, row.high),
        low: Math.min(previous.low, row.low),
        close: row.close,
        volume: previous.volume + row.volume,
      };
    } else if (!previous || start > previous.time) {
      next.push({ ...row, time: start });
    }
  }
  return next;
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
  if (!context.hasSession) return utcBucketStart(timestamp, timeframe);
  // A quote outside every session moves no candle, whatever the timeframe.
  if (!sessionAt(localParts(timestamp), marketState)) return null;
  return yahooBucketStart(timestamp, timeframe, marketState);
}

/**
 * Where Yahoo's own history starts the candle containing `timestamp`, in
 * America/New_York; the browser twin of `app/adapters/yahoo_buckets.py`.
 * Intraday candles start at a session anchor plus whole periods, and have no
 * bucket outside every session. A daily candle starts at 09:30 whether or not
 * the series is extended, and weekly and monthly candles at 00:00 on the
 * Monday or the first, even when that day is a holiday or a weekend.
 * `marketState` only chooses the intraday session; null reads it from the clock.
 */
function yahooBucketStart(
  timestamp: number,
  timeframe: string,
  marketState: string | null,
): number | null {
  const local = localParts(timestamp);
  if (timeframe === '1d') return fromNewYorkParts({ ...local, hour: 9, minute: 30, second: 0 });
  if (timeframe === '1w' || timeframe === '1M') {
    return fromNewYorkParts({ ...periodDate(local, timeframe), hour: 0, minute: 0, second: 0 });
  }

  const session = sessionAt(local, marketState);
  if (!session || !(timeframe in INTRADAY_MINUTES)) return null;

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
  // `getUTCDay` counts from Sunday, so the weekend is 0 and 6.
  const weekday = localDayOfWeek(local);
  if (weekday === 0 || weekday === 6) return null;

  const minutes = local.hour * 60 + local.minute;
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'PRE';
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'REGULAR';
  if (minutes >= 16 * 60 && minutes < 20 * 60) return 'POST';
  return null;
}

function localParts(timestamp: number): CalendarParts {
  const parts = Object.fromEntries(
    NEW_YORK_FORMAT.formatToParts(new Date(timestamp * 1000)).map(({ type, value }) => [
      type,
      value,
    ]),
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
