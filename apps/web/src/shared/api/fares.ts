import { apiRequest } from '@/shared/api/http';

/**
 * Airfare prices — Path B, and the same rule as `market.ts`: which upstream
 * answered is the API's business. Nothing here names a provider, and nothing
 * that imports it can tell one from another except by reading `source` back.
 */

/**
 * A live search paces itself against an upstream that is neither documented nor
 * fast, and a collect call sleeps between routes on purpose. The default 5s
 * deadline would abort both while the server was still working.
 */
const FARES_TIMEOUT_MS = 20_000;
const COLLECT_TIMEOUT_MS = 300_000;

export type FareOffer = {
  /** Marketing carrier, IATA. */
  airline: string;
  airlineName: string | null;
  flightNumber: string | null;
  /**
   * Local wall clock at the airport, ISO 8601 with no zone.
   *
   * Deliberately not a UTC instant: the provider reports what the departure
   * board says and no offset, so attaching one would be an invention that
   * later arithmetic would take seriously. Render it as text, never through
   * `new Date()`, which would read it in the browser's zone.
   */
  departureAt: string;
  arrivalAt: string | null;
  transfers: number;
  durationMinutes: number | null;
  price: number;
  currency: string;
};

export type FareSnapshot = {
  /** When the price was observed. The axis of the whole feature. */
  capturedAt: string;
  source: string;
  origin: string;
  destination: string;
  flightDate: string;
  returnDate: string | null;
  currency: string;
  offers: FareOffer[];
};

export type FareHistoryResponse = {
  origin: string;
  destination: string;
  snapshots: FareSnapshot[];
};

export type FareSearchResponse = {
  origin: string;
  destination: string;
  flightDate: string;
  returnDate: string | null;
  source: string;
  offers: FareOffer[];
};

/** One route's outcome in a collection pass — including the ones that failed. */
export type CollectRouteResult = {
  origin: string;
  destination: string;
  flightDate: string;
  returnDate: string | null;
  ok: boolean;
  /**
   * Who answered this route, or `null` when nobody did. Not always the
   * provider the pass asked for: a route the primary could not read is served
   * by the fallback, and the two answer different questions — one a live
   * itinerary list, the other a cached cheapest-of-the-day. A reader that
   * cannot tell them apart is reading a series that quietly changed meaning.
   */
  source: string | null;
  offers: number;
  cheapest: number | null;
  currency: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type CollectResponse = {
  startedAt: string;
  finishedAt: string;
  /**
   * The provider the pass asked for. `sources` containing anything else means
   * a route fell back — which is how the page can report it without naming a
   * provider it is not supposed to know about.
   */
  primary: string;
  /** Every provider that actually answered, in first-use order. */
  sources: string[];
  collected: number;
  failed: number;
  results: CollectRouteResult[];
};

export type RouteRequest = {
  origin: string;
  destination: string;
  flightDate: string;
  returnDate?: string | null;
  currency?: string;
};

export function fetchFareHistory(
  origin: string,
  destination: string,
  options: { since?: string; until?: string; signal?: AbortSignal } = {},
): Promise<FareHistoryResponse> {
  const query = new URLSearchParams({ origin, destination });
  if (options.since) query.set('since', options.since);
  if (options.until) query.set('until', options.until);

  return apiRequest<FareHistoryResponse>(`/api/fares/history?${query}`, {
    signal: options.signal,
  });
}

export function searchFares(
  route: RouteRequest,
  options: { signal?: AbortSignal } = {},
): Promise<FareSearchResponse> {
  const query = new URLSearchParams({
    origin: route.origin,
    destination: route.destination,
    flightDate: route.flightDate,
    currency: route.currency ?? 'USD',
  });
  if (route.returnDate) query.set('returnDate', route.returnDate);

  return apiRequest<FareSearchResponse>(`/api/fares/search?${query}`, {
    signal: options.signal,
    timeoutMs: FARES_TIMEOUT_MS,
  });
}

export function collectFares(
  routes: RouteRequest[],
  options: { signal?: AbortSignal } = {},
): Promise<CollectResponse> {
  return apiRequest<CollectResponse>('/api/fares/collect', {
    method: 'POST',
    body: { routes },
    signal: options.signal,
    timeoutMs: COLLECT_TIMEOUT_MS,
  });
}
