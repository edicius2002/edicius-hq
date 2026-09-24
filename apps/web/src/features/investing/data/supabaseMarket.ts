import { supabase } from '@/shared/supabase/client';
import { REALTIME_SUBSCRIBE_STATES } from '@supabase/realtime-js';
import type { Json } from '@/shared/supabase/database.types';
import type { BarsResponse, Quote, QuotesResponse, SymbolHit } from '@/shared/api/market';
import type { Tick } from './quoteStream';
import type { LiveBarUpdate } from './liveBars';

type CollectorOperation = 'market-bars' | 'market-search';
type RequestRow = { status: string; result: Json | null; error_code: string | null };

const REQUEST_TIMEOUT_MS = 20_000;
const ERROR_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class CollectorRequestError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'CollectorRequestError';
    this.code = code;
  }
}

export async function getQuotes(symbols: string[], signal?: AbortSignal): Promise<QuotesResponse> {
  if (signal?.aborted) throw new CollectorRequestError('aborted');
  const wanted = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return { quotes: [], failed: [] };
  const { data, error } = await supabase
    .from('market_quotes')
    .select('symbol, provider, market_time, payload')
    .in('symbol', wanted);
  if (error) throw new CollectorRequestError('quotes_unavailable');
  return { quotes: (data ?? []).flatMap(quoteFromRow), failed: [] };
}

export async function getBars(
  symbol: string,
  timeframe: string,
  extended = false,
  signal?: AbortSignal,
): Promise<BarsResponse> {
  const { data, error } = await supabase
    .from('market_bars')
    .select('provider, payload')
    .eq('symbol', symbol)
    .eq('timeframe', timeframe)
    .eq('extended', extended)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) throw new CollectorRequestError('bars_unavailable');
  if (data) {
    const cached = barsFromJson(data.payload);
    if (cached) return { ...cached, provider: data.provider };
  }
  return enqueue('market-bars', { symbol, timeframe, extended }, barsFromJson, signal);
}

export async function searchSymbols(
  query: string,
  signal?: AbortSignal,
): Promise<{ results: SymbolHit[] }> {
  return enqueue('market-search', { query }, searchFromJson, signal);
}

async function enqueue<T>(
  operation: CollectorOperation,
  payload: Json,
  decode: (value: Json) => T | null,
  signal?: AbortSignal,
): Promise<T> {
  const { data, error } = await supabase
    .from('collector_requests')
    // owner_id intentionally omitted: database default + RLS bind this request to auth.uid().
    .insert({ operation, payload })
    .select('request_id')
    .single();
  if (error) throw new CollectorRequestError('request_unavailable');
  return waitForCollectorResult(data.request_id, decode, signal);
}

function waitForCollectorResult<T>(
  requestId: string,
  decode: (value: Json) => T | null,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let closed = false;
    const timer = setTimeout(() => fail('request_timeout'), REQUEST_TIMEOUT_MS);
    const subscription: { channel: ReturnType<typeof supabase.channel> | undefined } = {
      channel: undefined,
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
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
      const { data, error } = await supabase
        .from('collector_requests')
        .select('status, result, error_code')
        .eq('request_id', requestId)
        .single();
      if (closed) return;
      if (error) fail('request_unavailable');
      else accept(data);
    };
    const abort = () => fail('aborted');
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
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
        if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) void reconcile();
      });
  });
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
  void supabase.auth.getSession().then(
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
    ({ data, error } = await supabase.auth.getSession());
  } catch {
    throw new CollectorRequestError('focus_unavailable');
  }
  const owner = data.session?.user.id;
  if (error || !owner) throw new CollectorRequestError('focus_unavailable');

  const channel = supabase.channel(`market-focus:${owner}`, { config: { private: true } });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      channel.subscribe((status) => {
        if (settled) return;
        if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
          settled = true;
          resolve();
        } else if (
          status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
          status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
          status === REALTIME_SUBSCRIBE_STATES.CLOSED
        ) {
          settled = true;
          reject(new CollectorRequestError('focus_unavailable'));
        }
      });
    });
  } catch {
    await supabase.removeChannel(channel);
    throw new CollectorRequestError('focus_unavailable');
  }

  let closed = false;
  return {
    publish: async (payload) => {
      if (closed) throw new CollectorRequestError('focus_unavailable');
      const result = await channel.send({ type: 'broadcast', event: 'focus', payload });
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
