import { supabase } from '@/shared/supabase/client';
import type { Json } from '@/shared/supabase/database.types';
import type { BarsResponse, Quote, QuotesResponse, SymbolHit } from '@/shared/api/market';
import type { Tick } from './quoteStream';
import type { LiveBarUpdate } from './liveBars';

type CollectorOperation = 'market-bars' | 'market-search';
type RequestRow = { status: string; result: Json | null; error_code: string | null };

const REQUEST_TIMEOUT_MS = 90_000;
const FAST_RECONCILE_INTERVAL_MS = 750;
const FAST_RECONCILE_DURATION_MS = 8_000;
const RECONCILE_INTERVAL_MS = 2_000;
const FOCUS_TIMEOUT_MS = 8_000;
const ERROR_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class CollectorRequestError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'CollectorRequestError';
    this.code = code;
  }
}

function withDeadline<T>(
  work: (signal: AbortSignal, deadline: number) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new CollectorRequestError('aborted'));
  const controller = new AbortController();
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
      if ('error' in result) {
        reject(
          result.error instanceof Error
            ? result.error
            : new CollectorRequestError('request_unavailable'),
        );
      } else resolve(result.value);
    };
    const abort = () => finish({ error: new CollectorRequestError('aborted') });
    const timer = setTimeout(
      () => finish({ error: new CollectorRequestError('request_timeout') }),
      REQUEST_TIMEOUT_MS,
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    void work(controller.signal, deadline).then(
      (value) => finish({ value }),
      (error) =>
        finish({ error: controller.signal.aborted ? new CollectorRequestError('aborted') : error }),
    );
  });
}

function focusDeadline<T>(work: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new CollectorRequestError('focus_unavailable')),
        FOCUS_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function getQuotes(symbols: string[], signal?: AbortSignal): Promise<QuotesResponse> {
  return withDeadline(async (requestSignal) => {
    const wanted = [
      ...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)),
    ];
    if (!wanted.length) return { quotes: [], failed: [] };
    const { data, error } = await supabase
      .from('market_quotes')
      .select('symbol, provider, market_time, payload')
      .in('symbol', wanted)
      .abortSignal(requestSignal);
    if (error) throw new CollectorRequestError('quotes_unavailable');
    return { quotes: (data ?? []).flatMap(quoteFromRow), failed: [] };
  }, signal);
}

export async function getBars(
  symbol: string,
  timeframe: string,
  extended = false,
  signal?: AbortSignal,
  onStored?: (bars: BarsResponse) => void,
): Promise<BarsResponse> {
  return withDeadline(async (requestSignal, deadline) => {
    const request = supabase
      .from('market_bars')
      .select('provider, payload, fetched_at, expires_at')
      .eq('symbol', symbol)
      .eq('timeframe', timeframe)
      .eq('extended', extended);
    const { data, error } = await request.abortSignal(requestSignal).maybeSingle();
    requestSignal.throwIfAborted();
    if (error) throw new CollectorRequestError('bars_unavailable');
    if (data) {
      const cached = barsFromJson(data.payload);
      if (cached) {
        const saved = {
          ...cached,
          provider: data.provider,
          capturedAt: Date.parse(data.fetched_at),
        };
        if (Date.parse(data.expires_at) > Date.now()) return saved;
        onStored?.({ ...saved, stale: true });
      }
    }
    return enqueue(
      'market-bars',
      { symbol, timeframe, extended },
      barsFromJson,
      requestSignal,
      deadline,
    );
  }, signal);
}

/** Read every saved variant for a symbol without starting provider work. */
export async function getStoredBars(
  symbol: string,
  extended: boolean,
  signal?: AbortSignal,
): Promise<BarsResponse[]> {
  return withDeadline(async (requestSignal) => {
    const { data, error } = await supabase
      .from('market_bars')
      .select('timeframe, provider, payload, fetched_at, expires_at')
      .eq('symbol', symbol)
      .eq('extended', extended)
      .abortSignal(requestSignal);
    requestSignal.throwIfAborted();
    if (error) throw new CollectorRequestError('bars_unavailable');
    return decodeStoredBars(data ?? [], new Set([symbol]), extended);
  }, signal);
}

/** Read saved series for several assets without creating collector requests. */
export async function getStoredBarsForSymbols(
  symbols: string[],
  extended: boolean,
  signal?: AbortSignal,
): Promise<BarsResponse[]> {
  return withDeadline(async (requestSignal) => {
    const wanted = [
      ...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)),
    ];
    if (!wanted.length) return [];
    const { data, error } = await supabase
      .from('market_bars')
      .select('symbol, timeframe, provider, payload, fetched_at, expires_at')
      .in('symbol', wanted)
      .eq('extended', extended)
      .abortSignal(requestSignal);
    requestSignal.throwIfAborted();
    if (error) throw new CollectorRequestError('bars_unavailable');
    return decodeStoredBars(data ?? [], new Set(wanted), extended);
  }, signal);
}

function decodeStoredBars(
  rows: {
    symbol?: string;
    timeframe: string;
    provider: string;
    payload: Json;
    fetched_at: string;
    expires_at: string;
  }[],
  wanted: Set<string>,
  extended: boolean,
): BarsResponse[] {
  const now = Date.now();
  return rows.flatMap((row) => {
    const bars = barsFromJson(row.payload);
    const capturedAt = Date.parse(row.fetched_at);
    const expiresAt = Date.parse(row.expires_at);
    if (
      !bars ||
      (row.symbol !== undefined && bars.symbol !== row.symbol) ||
      !wanted.has(bars.symbol) ||
      bars.timeframe !== row.timeframe ||
      bars.extended !== extended ||
      !Number.isFinite(capturedAt)
    )
      return [];
    return [
      {
        ...bars,
        provider: row.provider,
        capturedAt,
        stale: !Number.isFinite(expiresAt) || expiresAt <= now,
      },
    ];
  });
}

export async function searchSymbols(
  query: string,
  signal?: AbortSignal,
): Promise<{ results: SymbolHit[] }> {
  return withDeadline(
    (requestSignal, deadline) =>
      enqueue('market-search', { query }, searchFromJson, requestSignal, deadline),
    signal,
  );
}

async function enqueue<T>(
  operation: CollectorOperation,
  payload: Json,
  decode: (value: Json) => T | null,
  signal: AbortSignal,
  deadline: number,
): Promise<T> {
  signal.throwIfAborted();
  const { data, error } = await supabase
    .from('collector_requests')
    // owner_id intentionally omitted: database default + RLS bind this request to auth.uid().
    .insert({ operation, payload })
    .select('request_id')
    .abortSignal(signal)
    .single();
  if (signal.aborted) {
    if (data?.request_id) cancelQueuedRequest(data.request_id);
    throw new CollectorRequestError('aborted');
  }
  if (error || !data?.request_id) throw new CollectorRequestError('request_unavailable');
  return waitForCollectorResult(data.request_id, decode, signal, deadline);
}

function waitForCollectorResult<T>(
  requestId: string,
  decode: (value: Json) => T | null,
  signal: AbortSignal,
  deadline: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let closed = false;
    let reading = false;
    let interval = setInterval(() => void reconcile(), FAST_RECONCILE_INTERVAL_MS);
    const slowdown = setTimeout(() => {
      clearInterval(interval);
      interval = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
    }, FAST_RECONCILE_DURATION_MS);
    const finalTimer = setTimeout(
      () => void reconcile(),
      Math.max(0, deadline - Date.now() - 5_000),
    );
    const subscription: { channel: ReturnType<typeof supabase.channel> | undefined } = {
      channel: undefined,
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      clearTimeout(slowdown);
      clearTimeout(finalTimer);
      signal.removeEventListener('abort', abort);
      if (subscription.channel) void supabase.removeChannel(subscription.channel);
    };
    const fail = (code: string) => {
      close();
      reject(new CollectorRequestError(safeCode(code)));
    };
    const accept = (row: RequestRow | null) => {
      if (!row || closed) return;
      if (row.status === 'complete') {
        const value = row.result === null ? null : decode(row.result);
        if (value === null) fail('malformed_result');
        else {
          close();
          resolve(value);
        }
      } else if (row.status === 'failed') fail(row.error_code ?? 'request_failed');
      else if (row.status === 'expired') fail('request_expired');
    };
    const reconcile = async () => {
      if (closed || reading || signal.aborted) return;
      reading = true;
      try {
        const { data, error } = await supabase
          .from('collector_requests')
          .select('status, result, error_code')
          .eq('request_id', requestId)
          .abortSignal(signal)
          .single();
        if (closed || signal.aborted) return;
        if (error?.code === '42501') {
          fail('request_unavailable');
        } else if (!error) accept(data);
      } catch {
        // Transient HTTP failure: another bounded reconciliation can still
        // recover a completed row, even if the Realtime channel is down.
      } finally {
        reading = false;
      }
    };
    const abort = () => {
      cancelQueuedRequest(requestId);
      fail('aborted');
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    subscription.channel = supabase
      .channel(`collector-request:${requestId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'collector_requests',
          filter: `request_id=eq.${requestId}`,
        },
        (event) => accept(event.new as RequestRow),
      )
      .subscribe((status) => {
        if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status))
          void reconcile();
      });
    void reconcile();
  });
}

function cancelQueuedRequest(requestId: string): void {
  // The RPC only marks this authenticated owner's still-queued market row.
  // A claimed request is left for the worker to settle normally.
  void supabase.rpc('cancel_market_request', { p_request_id: requestId }).then(
    () => undefined,
    () => undefined,
  );
}

export type QuoteSubscriptionStatus = string;

export function subscribeMarketUpdates(
  onTicks: (ticks: Tick[]) => void,
  onBars: (bars: LiveBarUpdate[]) => void,
  onStatus?: (status: QuoteSubscriptionStatus) => void,
): () => void {
  let disposed = false;
  let channel: ReturnType<typeof supabase.channel> | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (channel) void supabase.removeChannel(channel);
  };
  void focusDeadline(supabase.auth.getSession()).then(
    ({ data, error }) => {
      if (disposed) return;
      const owner = data.session?.user.id;
      if (error || !owner) {
        onStatus?.('CHANNEL_ERROR');
        return;
      }
      channel = supabase
        .channel(`market-quotes:${owner}`, { config: { private: true } })
        .on('broadcast', { event: 'ticks' }, ({ payload }) => {
          const ticks = ticksFromPayload(payload);
          if (!disposed && ticks.length) onTicks(ticks);
        })
        .on('broadcast', { event: 'bars' }, ({ payload }) => {
          const bars = liveBarsFromPayload(payload);
          if (!disposed && bars.length) onBars(bars);
        })
        .subscribe((status) => {
          if (!disposed) onStatus?.(status);
        });
      if (disposed) void supabase.removeChannel(channel);
    },
    () => {
      if (!disposed) onStatus?.('CHANNEL_ERROR');
    },
  );
  return dispose;
}

export type ChartFocusMessage = {
  clientId: string;
  symbol: string;
  timeframe: string;
  extended: boolean;
  active: boolean;
};

export type ChartFocusPublisher = {
  publish: (focus: ChartFocusMessage) => Promise<void>;
  close: () => Promise<void>;
};

export async function openChartFocus(): Promise<ChartFocusPublisher> {
  let data: Awaited<ReturnType<typeof supabase.auth.getSession>>['data'];
  let error: Awaited<ReturnType<typeof supabase.auth.getSession>>['error'];
  try {
    ({ data, error } = await focusDeadline(supabase.auth.getSession()));
  } catch {
    throw new CollectorRequestError('focus_unavailable');
  }
  const owner = data.session?.user.id;
  if (error || !owner) throw new CollectorRequestError('focus_unavailable');

  const channel = supabase.channel(`market-focus:${owner}`, { config: { private: true } });
  try {
    await focusDeadline(
      new Promise<void>((resolve, reject) => {
        let settled = false;
        channel.subscribe((status) => {
          if (settled) return;
          const name: string = status;
          if (name === 'SUBSCRIBED') {
            settled = true;
            resolve();
          } else if (name === 'CHANNEL_ERROR' || name === 'TIMED_OUT' || name === 'CLOSED') {
            settled = true;
            reject(new CollectorRequestError('focus_unavailable'));
          }
        });
      }),
    );
  } catch {
    await supabase.removeChannel(channel);
    throw new CollectorRequestError('focus_unavailable');
  }

  let closed = false;
  return {
    publish: async (payload) => {
      if (closed) throw new CollectorRequestError('focus_unavailable');
      const result = await focusDeadline(
        channel.send({ type: 'broadcast', event: 'focus', payload }),
      );
      if (result !== 'ok') throw new CollectorRequestError('focus_unavailable');
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await supabase.removeChannel(channel);
    },
  };
}

function liveBarsFromPayload(raw: unknown): LiveBarUpdate[] {
  const value = object(raw);
  return value && Array.isArray(value.bars) ? value.bars.flatMap(liveBarFromJson) : [];
}

function liveBarFromJson(raw: Json): LiveBarUpdate[] {
  const value = object(raw);
  const bar = object(value?.bar);
  const symbol = typeof value?.symbol === 'string' ? value.symbol.trim().toUpperCase() : '';
  const timeframe = value?.timeframe;
  if (
    !symbol ||
    typeof timeframe !== 'string' ||
    !['1m', '5m', '15m', '1h', '1d', '1w', '1M'].includes(timeframe) ||
    typeof value?.extended !== 'boolean' ||
    !number(value.asOf) ||
    !bar ||
    !number(bar.time) ||
    !number(bar.open) ||
    !number(bar.high) ||
    !number(bar.low) ||
    !number(bar.close) ||
    !number(bar.volume)
  ) {
    return [];
  }
  return [
    {
      symbol,
      timeframe,
      extended: value.extended,
      asOf: value.asOf,
      bar: {
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      },
    },
  ];
}

function ticksFromPayload(raw: unknown): Tick[] {
  const value = object(raw);
  return value && Array.isArray(value.ticks) ? value.ticks.flatMap(tickFromJson) : [];
}

function tickFromJson(raw: Json): Tick[] {
  const value = object(raw);
  const symbol = typeof value?.symbol === 'string' ? value.symbol.trim().toUpperCase() : '';
  if (
    !value ||
    !symbol ||
    !number(value.price) ||
    typeof value.extended !== 'boolean' ||
    !(value.marketState === null || typeof value.marketState === 'string') ||
    !(value.changePercent === null || number(value.changePercent)) ||
    !(value.time === null || number(value.time))
  )
    return [];
  return [
    {
      symbol,
      price: value.price,
      marketState: value.marketState,
      extended: value.extended,
      changePercent: value.changePercent,
      time: value.time,
    },
  ];
}

function quoteFromRow(row: {
  symbol: string;
  provider: string;
  market_time: number | null;
  payload: Json;
}): Quote[] {
  const value = object(row.payload);
  if (!value || !number(value.price) || typeof value.currency !== 'string') return [];
  return [
    {
      symbol: row.symbol,
      provider: row.provider,
      time: row.market_time,
      price: value.price,
      currency: value.currency,
      previousClose: nullableNumber(value.previousClose),
      change: nullableNumber(value.change),
      changePercent: nullableNumber(value.changePercent),
      marketState: nullableString(value.marketState),
      name: nullableString(value.name),
      extended: value.extended === true,
    },
  ];
}

function barsFromJson(raw: Json): BarsResponse | null {
  const value = object(raw);
  if (
    !value ||
    typeof value.symbol !== 'string' ||
    typeof value.timeframe !== 'string' ||
    typeof value.provider !== 'string' ||
    typeof value.extended !== 'boolean' ||
    typeof value.hasSession !== 'boolean' ||
    typeof value.stale !== 'boolean' ||
    !Array.isArray(value.bars)
  )
    return null;
  const bars = value.bars.flatMap((bar) => {
    const item = object(bar);
    return item &&
      number(item.time) &&
      number(item.open) &&
      number(item.high) &&
      number(item.low) &&
      number(item.close) &&
      number(item.volume)
      ? [
          {
            time: item.time,
            open: item.open,
            high: item.high,
            low: item.low,
            close: item.close,
            volume: item.volume,
          },
        ]
      : [];
  });
  return bars.length === value.bars.length
    ? {
        symbol: value.symbol,
        timeframe: value.timeframe,
        provider: value.provider,
        extended: value.extended,
        hasSession: value.hasSession,
        stale: value.stale,
        bars,
      }
    : null;
}

function searchFromJson(raw: Json): { results: SymbolHit[] } | null {
  const value = object(raw);
  if (!value || !Array.isArray(value.results)) return null;
  const results = value.results.flatMap((hit) => {
    const item = object(hit);
    return item &&
      typeof item.symbol === 'string' &&
      typeof item.name === 'string' &&
      typeof item.kind === 'string' &&
      (typeof item.exchange === 'string' || item.exchange === null)
      ? [{ symbol: item.symbol, name: item.name, kind: item.kind, exchange: item.exchange }]
      : [];
  });
  return results.length === value.results.length ? { results } : null;
}

function object(value: unknown): { [key: string]: Json | undefined } | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as { [key: string]: Json | undefined })
    : null;
}
function number(value: Json | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function nullableNumber(value: Json | undefined): number | null {
  return number(value) ? value : null;
}
function nullableString(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
function safeCode(code: string): string {
  return ERROR_CODE.test(code) ? code : 'request_failed';
}
