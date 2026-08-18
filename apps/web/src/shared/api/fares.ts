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

/** What the provider says this search usually costs. Context, not measurement. */
export type FareInsights = {
  typical: number | null;
  usualLow: number | null;
  usualHigh: number | null;
};

/**
 * One day of the provider's own history.
 *
 * Rounded to the whole unit and cheapest-only, with no airline and no
 * departure time — so it belongs behind our own series as context, never on
 * the same line as it.
 */
export type FarePricePoint = {
  date: string;
  price: number;
};

/**
 * Whether the collector has been looking, separately from what it found.
 *
 * A stretch of archive with no snapshots means either no price movement or no
 * collector. These counts come from the heartbeat written on every poll, and
 * they are what makes the difference visible.
 */
export type WatchHealth = {
  lastCheckedAt: string | null;
  checks: number;
  changes: number;
  errors: number;
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
  insights: FareInsights | null;
  offers: FareOffer[];
};

export type FareHistoryResponse = {
  origin: string;
  destination: string;
  snapshots: FareSnapshot[];
  baseline: FarePricePoint[];
  health: WatchHealth;
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
  /** Whether this look wrote a snapshot. False when the board had not moved. */
  changed: boolean;
  /** Days of provider history folded in — non-zero only on a first look. */
  seeded: number;
  offers: number;
  cheapest: number | null;
  currency: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type SkippedRoute = {
  what: string;
  reason: string;
};

export type CollectResponse = {
  startedAt: string;
  finishedAt: string;
  source: string;
  collected: number;
  changed: number;
  failed: number;
  results: CollectRouteResult[];
  /** Departures deliberately not polled, and why. */
  skipped: SkippedRoute[];
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
  options: { flightDate?: string; since?: string; until?: string; signal?: AbortSignal } = {},
): Promise<FareHistoryResponse> {
  const query = new URLSearchParams({ origin, destination });
  // Snapshots come back for the whole route; the baseline is per departure,
  // because two departure dates are two different series and the provider
  // reports a separate history for each.
  if (options.flightDate) query.set('flightDate', options.flightDate);
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
