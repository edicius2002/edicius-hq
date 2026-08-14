import { apiRequest } from '@/shared/api/http';

/**
 * Market data — Path B. Which upstream answered is the API's business, not
 * this file's: nothing here names a provider, and nothing that imports it can
 * tell Yahoo from Binance except by reading the `provider` field back.
 */

/** The API waits up to 12s on an unofficial upstream; give it room to answer. */
const MARKET_TIMEOUT_MS = 15_000;

export type Quote = {
  symbol: string;
  price: number;
  currency: string;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  provider: string;
  /** Provider market time in Unix seconds; null when it did not provide one. */
  time: number | null;
  /** What the exchange says about its own session; absent where there is none. */
  marketState: string | null;
  name: string | null;
  /**
   * Whether `price` came from a pre- or post-market session. The change is
   * still measured against the regular close, so the percentage answers
   * "how is it doing today" either way.
   */
  extended: boolean;
};

/** A symbol that could not be served, beside the ones that could. */
export type QuoteFailure = {
  symbol: string;
  code: string;
  message: string;
};

export type QuotesResponse = {
  quotes: Quote[];
  failed: QuoteFailure[];
};

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
  /** Whether the series includes pre- and post-market bars. */
  extended: boolean;
  /**
   * Whether this instrument's market closes at all.
   *
   * Served rather than inferred: the client used to answer it by testing
   * `provider !== 'binance'`, which is reading a provider's name to decide
   * behaviour — the thing decision 8.3 exists to prevent, and the last place
   * it leaked.
   */
  hasSession: boolean;
  /** The API preserved the last valid series during a temporary provider failure. */
  stale: boolean;
  bars: Bar[];
};

export type SymbolHit = {
  symbol: string;
  name: string;
  kind: string;
  exchange: string | null;
};

/**
 * One request for many symbols. The batch exists so a watchlist is a single
 * round trip rather than one per row — see plan decision 8.2.
 */
export function getQuotes(symbols: string[], signal?: AbortSignal): Promise<QuotesResponse> {
  const query = encodeURIComponent(symbols.join(','));
  return apiRequest<QuotesResponse>(`/api/market/quotes?symbols=${query}`, {
    signal,
    timeoutMs: MARKET_TIMEOUT_MS,
  });
}

export function getBars(
  symbol: string,
  timeframe: string,
  extended = false,
  signal?: AbortSignal,
): Promise<BarsResponse> {
  const query =
    `symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}` +
    (extended ? '&extended=true' : '');
  return apiRequest<BarsResponse>(`/api/market/bars?${query}`, {
    signal,
    timeoutMs: MARKET_TIMEOUT_MS,
  });
}

export function searchSymbols(
  query: string,
  signal?: AbortSignal,
): Promise<{ results: SymbolHit[] }> {
  return apiRequest<{ results: SymbolHit[] }>(`/api/market/search?q=${encodeURIComponent(query)}`, {
    signal,
    timeoutMs: MARKET_TIMEOUT_MS,
  });
}

export function getTimeframes(signal?: AbortSignal): Promise<{ timeframes: string[] }> {
  return apiRequest<{ timeframes: string[] }>('/api/market/timeframes', { signal });
}
