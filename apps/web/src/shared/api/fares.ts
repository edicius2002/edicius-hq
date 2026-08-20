import { apiRequest } from '@/shared/api/http';

/**
 * Airfare prices — Path B, and the same rule as `market.ts`: which upstream
 * answered is the API's business. Nothing here names a provider, and nothing
 * that imports it can tell one from another except by reading `source` back.
 */

/**
 * A live search paces itself against an upstream that is neither documented nor
 * fast, so the default 5s deadline would abort it while the server was still
 * working.
 *
 * There was a five-minute companion to this for `/collect`, and it is gone with
 * 12.210 — that deadline was what decided how much of a watchlist one press
 * could cover, because forty paced requests was as much as would fit inside it.
 * A press that starts a pass and returns needs no more patience than any other
 * call.
 */
const FARES_TIMEOUT_MS = 20_000;

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

/**
 * Where an IATA code actually is.
 *
 * Collected free with every search — the provider ships coordinates, city and
 * country for the airports in the query. Without this the app would need a
 * bundled airport table larger than the map library that consumes it.
 */
export type Airport = {
  code: string;
  name: string | null;
  city: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
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
 *
 * `flightDate` is which departure the figure priced. A watched month brings
 * back one of these series per day of it, so `date` alone is not a key: the
 * same observation date arrives thirty-one times with thirty-one prices. The
 * pair is also the only thing a lead-time axis can be drawn from — the whole
 * days between the two are how far ahead of the flight that price was seen.
 */
export type FarePricePoint = {
  /** `YYYY-MM-DD`. The departure this figure priced. */
  flightDate: string;
  /** `YYYY-MM-DD`. When it was priced. */
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
  /** Only this route's two ends. The map asks for the rest separately. */
  airports: Airport[];
};

/**
 * One departure date and what the cheapest seat on it costs.
 *
 * `price` is `null` when the provider answered about the date and had nothing
 * to sell. A date absent from the list altogether was never answered for. Those
 * are two different facts — 12.154 — and the curve's `fromDate`/`toDate` are
 * what tell them apart, which is why they travel together below.
 */
export type CalendarPoint = {
  departureDate: string;
  price: number | null;
};

/**
 * One collection of the whole booking horizon: a cheapest fare per departure
 * date, out to the day the provider stops answering.
 *
 * One number a day and nothing else — no carrier, no times, no itineraries —
 * so it is not a board and cannot be drawn on the same axis as one.
 */
export type CalendarCurve = {
  /** When this curve was collected. The chart's domain comes from the row, not from this. */
  capturedAt: string;
  source: string;
  currency: string;
  /** The window that was asked for, so a missing date reads as a gap in the answer. */
  fromDate: string;
  toDate: string;
  prices: CalendarPoint[];
};

export type FareCalendarResponse = {
  origin: string;
  destination: string;
  /** The newest curve, or null where this pair has never been collected. */
  latest: CalendarCurve | null;
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

/**
 * One departure the pass decided not to poll, and why.
 *
 * `what` is `LIM-SCL 2027-03-09` — a sentence for a human rather than a key.
 * Routinely the longer of the two lists since a watched month expands to
 * thirty-one departures and a daily cadence polls one of them at a time.
 */
export type SkippedRoute = {
  what: string;
  reason: string;
};

/**
 * How far a collection pass has got — 12.210.
 *
 * `idle` is a machine that has never collected, which is an ordinary state and
 * not a failure. `failed` is the pass itself falling over; a route the provider
 * refused is not that, and travels in `results` with its own reason.
 */
export type CollectState = 'idle' | 'running' | 'finished' | 'failed';

/**
 * A collection pass, finished or not — 12.210.
 *
 * One shape answers both the press that starts a pass and every poll that
 * follows it, which is why `describeCollection` can stay the function it was:
 * `results` and `skipped` mean exactly what they always meant, and the fields
 * above them describe a pass that is still going.
 */
export type CollectResponse = {
  state: CollectState;
  /** Null only while `state` is `idle`. */
  startedAt: string | null;
  /** Null until the pass ends. */
  finishedAt: string | null;
  source: string;
  /**
   * What this pass covers, as `ARI-SCL 2027-03`. A press whose own route is
   * missing from here met a pass that was already running and was answered
   * with that one rather than served with its own — the row has no other way
   * to tell, and a row that reported somebody else's pass as its own would be
   * the quietest possible lie.
   */
  watching: string[];
  /** How many departures the pass means to poll. Null until the plan is settled. */
  polling: number | null;
  /** How many have come back so far. */
  completed: number;
  collected: number;
  changed: number;
  failed: number;
  results: CollectRouteResult[];
  /** Departures deliberately not polled, and why. */
  skipped: SkippedRoute[];
  /** Why the pass fell over, when it did. */
  error: string | null;
};

/** One watched route as `POST /collect` takes it: a city pair and a month. */
export type RouteRequest = {
  origin: string;
  destination: string;
  /** `YYYY-MM`. The server expands it into the departures inside it. */
  month: string;
  /**
   * `YYYY-MM-DD`, and inside `month` — the one departure this reader means to
   * take. Optional, and it does not change what is collected: every day of the
   * month is still expanded and scheduled at its own rate. It changes only who
   * survives a truncated pass, which is the whole reason a reading preference
   * is sent to a collector at all (12.130).
   *
   * A focus outside its month is a 422 rather than a silent drop: the client
   * cannot construct one, so one arriving is a bug worth seeing.
   */
  focusDate?: string;
  currency?: string;
};

/** One route on one day, as a live search takes it. */
export type SearchRequest = {
  origin: string;
  destination: string;
  flightDate: string;
  returnDate?: string | null;
  currency?: string;
};

export function fetchFareHistory(
  origin: string,
  destination: string,
  options: { departure?: string; since?: string; until?: string; signal?: AbortSignal } = {},
): Promise<FareHistoryResponse> {
  const query = new URLSearchParams({ origin, destination });
  // Snapshots come back for the whole city pair; the baseline and the health
  // figures are narrowed to `departure`, which the server matches as a prefix
  // — `2027-03` for a watched month, `2027-03-09` for one day of it.
  if (options.departure) query.set('departure', options.departure);
  if (options.since) query.set('since', options.since);
  if (options.until) query.set('until', options.until);

  return apiRequest<FareHistoryResponse>(`/api/fares/history?${query}`, {
    signal: options.signal,
  });
}

/**
 * The whole booking horizon for one city pair, as last collected.
 *
 * A separate call from `fetchFareHistory` because the server keeps them
 * separate on purpose: one is a series of boards for the month somebody
 * watches, the other is one number a day for all eleven they do not. There is
 * no `departure` narrowing here — a curve spans every month at once, which is
 * the whole of what it is for.
 */
export function fetchFareCalendar(
  origin: string,
  destination: string,
  options: { signal?: AbortSignal } = {},
): Promise<FareCalendarResponse> {
  const query = new URLSearchParams({ origin, destination });
  return apiRequest<FareCalendarResponse>(`/api/fares/calendar?${query}`, {
    signal: options.signal,
  });
}

/**
 * Every airport the archive knows, for drawing every watched route at once.
 *
 * Separate from the history call because that one only knows about its own two
 * ends, and the map needs both ends of all of them.
 */
export function fetchAirports(
  options: { signal?: AbortSignal } = {},
): Promise<{ airports: Airport[] }> {
  return apiRequest<{ airports: Airport[] }>('/api/fares/airports', { signal: options.signal });
}

/** One airport a search box can offer. */
export type AirportMatch = {
  code: string;
  city: string;
  country: string;
  name: string;
};

/**
 * Airports matching what is being typed, best match first.
 *
 * Distinct from `fetchAirports`, which lists only what the archive has
 * actually collected. This one searches every airport with scheduled service,
 * so a route can be added to somewhere nobody has watched yet.
 *
 * The table lives on the server: 4,162 airports is 71 kB gzipped, which would
 * have roughly doubled this page's download for a feature most visits never
 * touch. A keystroke costs about a kilobyte against localhost instead.
 */
export function searchAirports(
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<{ query: string; matches: AirportMatch[] }> {
  const params = new URLSearchParams({ q: query });
  if (options.limit) params.set('limit', String(options.limit));
  return apiRequest<{ query: string; matches: AirportMatch[] }>(
    `/api/fares/airports/search?${params}`,
    { signal: options.signal },
  );
}

export function searchFares(
  route: SearchRequest,
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

/**
 * Start a collection pass. Answers as soon as it has started — 12.210.
 *
 * The ordinary request deadline is right for this again: the call no longer
 * waits for minutes of paced upstream requests, it waits for a task to be
 * created. `fetchCollectionProgress` is where the rest of the pass is.
 */
export function collectFares(
  routes: RouteRequest[],
  options: { signal?: AbortSignal } = {},
): Promise<CollectResponse> {
  return apiRequest<CollectResponse>('/api/fares/collect', {
    method: 'POST',
    body: { routes },
    signal: options.signal,
  });
}

/** How the current pass is getting on, or how the last one ended — 12.210. */
export function fetchCollectionProgress(
  options: { signal?: AbortSignal } = {},
): Promise<CollectResponse> {
  return apiRequest<CollectResponse>('/api/fares/collect', { signal: options.signal });
}
