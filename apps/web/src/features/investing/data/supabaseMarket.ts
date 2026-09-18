import { supabase } from '@/shared/supabase/client';
import type { Json } from '@/shared/supabase/database.types';
import type { BarsResponse, Quote, QuotesResponse, SymbolHit } from '@/shared/api/market';

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let channel: ReturnType<typeof supabase.channel> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (channel) void supabase.removeChannel(channel);
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
    timer = setTimeout(() => fail('request_timeout'), REQUEST_TIMEOUT_MS);
    channel = supabase
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
        if (status === 'SUBSCRIBED') void reconcile();
      });
  });
}

export type QuoteSubscriptionStatus =
  'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' | string;

export function subscribeQuotes(
  onQuotes: (quotes: Quote[]) => void,
  onStatus?: (status: QuoteSubscriptionStatus) => void,
): () => void {
  let disposed = false;
  let channel: ReturnType<typeof supabase.channel> | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (channel) void supabase.removeChannel(channel);
  };
  channel = supabase
    .channel('market-quotes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'market_quotes' }, (event) => {
      const quote = quoteFromRow(
        event.new as {
          symbol: string;
          provider: string;
          market_time: number | null;
          payload: Json;
        },
      );
      if (!disposed && quote.length) onQuotes(quote);
    })
    .subscribe((status) => {
      if (!disposed) onStatus?.(status);
      if (status !== 'SUBSCRIBED') dispose();
    });
  if (disposed) void supabase.removeChannel(channel);
  return dispose;
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

function object(value: Json): { [key: string]: Json | undefined } | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
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
