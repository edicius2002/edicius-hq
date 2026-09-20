export { getBars, getQuotes, searchSymbols } from '@/features/investing/data/supabaseMarket';

/** The browser owns the supported chart choices; no provider route is needed. */
export function getTimeframes(_signal?: AbortSignal): Promise<{ timeframes: string[] }> {
  void _signal;
  return Promise.resolve({ timeframes: ['1m', '5m', '15m', '1h', '1d', '1w', '1M'] });
}

export type Quote = {
  symbol: string;
  price: number;
  currency: string;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  provider: string;
  time: number | null;
  marketState: string | null;
  name: string | null;
  extended: boolean;
};
export type QuoteFailure = { symbol: string; code: string; message: string };
export type QuotesResponse = { quotes: Quote[]; failed: QuoteFailure[] };
export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type BarsResponse = {
  symbol: string;
  timeframe: string;
  provider: string;
  extended: boolean;
  hasSession: boolean;
  stale: boolean;
  bars: Bar[];
};
export type SymbolHit = { symbol: string; name: string; kind: string; exchange: string | null };
