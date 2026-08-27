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
  /** Intermediate airports in itinerary order; absent from older snapshots. */
  viaPoints?: string[] | null;
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
 * One departure date, what the cheapest seat on it costs, and when that was seen.
 *
 * `price` is `null` when the provider answered about the date and had nothing
 * to sell. A date absent from the list altogether was never answered for. Those
 * are two different facts — 12.154 — and the curve's `fromDate`/`toDate` are
 * what tell them apart, which is why they travel together below.
 *
 * `observedAt` is the third fact and the newest one. The horizon below is
 * assembled from every curve the server has stored, so two prices side by side
 * can be days apart in age — `a-curve-fills-what-newer-lost`.
 */
export type CalendarPoint = {
  departureDate: string;
  price: number | null;
  /**
   * When this date's price was collected. Equal to the horizon's `capturedAt`
   * for a price collected on the newest pass, and older for one inherited from
   * a curve that reached further than the newest one did.
   */
  observedAt: string;
};

/**
 * The whole booking horizon: a cheapest fare per departure date, out to the day
 * the provider stops answering.
 *
 * One number a day and nothing else — no carrier, no times, no itineraries —
 * so it is not a board and cannot be drawn on the same axis as one.
 *
 * **Not one collection.** It is assembled server-side from every curve stored
 * for the pair, because a curve can be shorter than the one before it and
 * serving the newest alone dropped months the archive still held. Each price
 * therefore carries its own `observedAt` and this object's `capturedAt` speaks
 * only for the freshest of them.
 */
export type CalendarCurve = {
  /**
   * The freshest observation in `prices`, and only that.
   *
   * It is not the age of the curve as a whole, because the curve as a whole has
   * no single age. A reader that spreads this over every point is claiming a
   * freshness most of the window may not have — compare `point.observedAt`.
   */
  capturedAt: string;
  source: string;
  currency: string;
  /**
   * The window this answer covers: the newest curve's near end, and the far end
   * of whichever stored curve reached furthest. A date inside it and missing
   * from `prices` was answered for by no collection at all.
   */
  fromDate: string;
  toDate: string;
  prices: CalendarPoint[];
};

export type FareCalendarResponse = {
  origin: string;
  destination: string;
  /**
   * Every departure date any stored curve answered for, or null where this pair
   * has never been collected.
   *
   * This was `latest` and held the newest curve alone. The name went with the
   * behaviour: calling a merged answer "latest" would tell a reader every price
   * in it is the newest, which is the one belief this change exists to remove.
   */
  horizon: CalendarCurve | null;
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
  /*
   * `focusDate` was here and is gone from both sides at once — 12.266. It was
   * the one reading preference this client ever sent a collector, and the only
   * thing the collector did with it was keep that day first when a pass ran out
   * of budget. With no focus in the model nothing can set it, so the field and
   * the ordering it fed went together rather than one of them becoming a
   * branch the other could no longer reach.
   */
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
  codes: readonly string[] = [],
  options: { signal?: AbortSignal } = {},
): Promise<{ airports: Airport[] }> {
  const query = new URLSearchParams();
  for (const code of codes) query.append('codes', code);
  const suffix = query.size ? `?${query}` : '';
  return apiRequest<{ airports: Airport[] }>(`/api/fares/airports${suffix}`, {
    signal: options.signal,
  });
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
 *
 * `force` polls every departure in the month whether or not its turn has come
 * — `a-press-collects-the-month-it-is-on`. It is sent on every call rather than
 * only when true, because the server takes it as a field with a default and a
 * body that omits it is asking for the schedule: writing the word both ways
 * means a reader of a network log can see which of the two was asked for. The
 * server refuses it with anything but one route, so this is only ever set by a
 * press on one row.
 */
export function collectFares(
  routes: RouteRequest[],
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<CollectResponse> {
  return apiRequest<CollectResponse>('/api/fares/collect', {
    method: 'POST',
    body: { routes, force: options.force ?? false },
    signal: options.signal,
  });
}

/**
 * One city pair's whole-horizon curve, as a collection pass reports it.
 *
 * A different document from `CollectRouteResult` because it is a different unit
 * of work: that one is a board for a departure date, this is one number per
 * departure date across a year. `dates` is how many came back at all and
 * `priced` how many carried a fare — a date the provider answered about and had
 * nothing to sell is counted in the first and not the second, which is the
 * distinction the whole horizon is built to keep.
 */
export type CalendarRouteResult = {
  origin: string;
  destination: string;
  ok: boolean;
  /** Whether this look wrote a curve. False when nothing in the year moved. */
  changed: boolean;
  dates: number;
  priced: number;
  cheapest: number | null;
  cheapestOn: string | null;
  currency: string | null;
  /**
   * Upstream requests spent on this pair. Two where both windows answer first
   * time, and more where a far end was refused and walked back — 12.245.
   */
  requests: number;
  errorCode: string | null;
  errorMessage: string | null;
};

/**
 * A horizon collection pass, finished or not.
 *
 * Same shape from the press that starts one and from every poll that follows,
 * for `CollectResponse`'s reason: a client that can read the first can read the
 * second. It counts in its own units, though, and that is where the two part:
 * a board pass polls departures, and this one polls none. What it spends is
 * requests and what it achieves is windows priced.
 */
export type CalendarCollectResponse = {
  state: CollectState;
  startedAt: string | null;
  finishedAt: string | null;
  source: string;
  /** What this pass covers, as `LIM-SCL`. */
  watching: string[];
  completed: number;
  /**
   * How many date windows this pass means to price. Null until the plan
   * settles, which is a different fact from zero — zero is a pair already
   * collected inside its cadence, and a bar drawn at zero for the other one
   * would be claiming a denominator nobody has yet.
   */
  windows: number | null;
  /** Windows that have come back. The numerator for `windows`. */
  windowsPriced: number;
  /**
   * Upstream requests sent so far. Above `windowsPriced` whenever a far window
   * was refused and asked for again with a nearer end — 12.245. The two are
   * separate because one is what the pass is spending and the other is what it
   * is achieving, and a reader watching only one cannot tell a retry from a hang.
   */
  requests: number;
  /** Departure dates priced so far, across every window that has landed. */
  dates: number;
  collected: number;
  changed: number;
  failed: number;
  results: CalendarRouteResult[];
  skipped: SkippedRoute[];
  /** Why the pass fell over, when it did. A refused route is not this. */
  error: string | null;
};

/**
 * Start collecting one city pair's whole booking horizon — 12.247.
 *
 * Answers as soon as the pass has started, exactly as `collectFares` does, and
 * for the stronger version of the same reason: this call is fired by *adding a
 * route*, and a form that waited four seconds on an upstream before the row
 * appeared would make the watchlist feel like it was talking to the internet.
 * `fetchCalendarCollection` is where the rest of the pass is.
 */
export function collectCalendar(
  route: { origin: string; destination: string; currency?: string },
  options: { signal?: AbortSignal } = {},
): Promise<CalendarCollectResponse> {
  return apiRequest<CalendarCollectResponse>('/api/fares/calendar/collect', {
    method: 'POST',
    body: {
      origin: route.origin,
      destination: route.destination,
      ...(route.currency ? { currency: route.currency } : {}),
    },
    signal: options.signal,
  });
}

/** How the current horizon pass is getting on, or how the last one ended. */
export function fetchCalendarCollection(
  options: { signal?: AbortSignal } = {},
): Promise<CalendarCollectResponse> {
  return apiRequest<CalendarCollectResponse>('/api/fares/calendar/collect', {
    signal: options.signal,
  });
}

/** How many of today's requests one kind of look accounts for. */
export type SpendKind = {
  /** `board` or `calendar`, as the ledger wrote it — not a closed set. */
  kind: string;
  requests: number;
};

/**
 * What this address has already sent today — `spend-is-read-back-not-only-written`.
 *
 * The one figure on this page that is about **us** rather than about a fare.
 * The collector has kept a ledger since `a-day-is-what-the-budget-bounds` and
 * nothing read it back, so a scheduled pass spending badly would first show up
 * as the upstream declining to answer — and 12.9 records that the address it
 * would decline is a residential one with no replacement.
 */
export type FareSpend = {
  /**
   * The day these figures cover, `YYYY-MM-DD`, in **UTC**.
   *
   * Not the reader's today everywhere: the ledger names its file after the UTC
   * date, so in Lima the count starts again at seven in the evening. Render
   * `resetsAt` rather than this if the question is when.
   */
  day: string;
  /** When the count starts again, as an instant to be shown in the reader's zone. */
  resetsAt: string;
  /**
   * Requests recorded today, or `null` when the ledger cannot be read.
   *
   * **`null` is not zero, and rendering it as zero is the one thing this field
   * must never do.** The day's figure is not known: a `0` would draw a quiet
   * morning over a collector whose record of itself is broken — and, where a
   * `ceiling` is set, over a stopped one, because an unknown day is treated as
   * fully spent and nothing collects until the file can be read.
   */
  spent: number | null;
  /**
   * The day's ceiling, or `null` when there is none — **which is the default**.
   *
   * `null` is not zero and is nearly its opposite: no ceiling means every due
   * departure is polled, where zero would mean none is. The API's `config.py`
   * records why the old 600 went: it was a judgement rather than a measured
   * limit, the real limit is how much this address can send before Google stops
   * answering, and that is unknown and deliberately unprobed — so a count
   * nobody had measured no longer stops a pass, while the pacing and the
   * one-pass-at-a-time lock that actually protect the address are untouched.
   */
  ceiling: number | null;
  /**
   * What a pass starting now could still spend, or `null` when no ceiling
   * leaves anything to be left of. Zero on an unreadable ledger under a ceiling.
   */
  remaining: number | null;
  /**
   * The most this address has ever sent in one day, measured at 329 from 494
   * heartbeat lines across four days.
   *
   * **With no ceiling this is the only number here to judge `spent` against**,
   * which is why it is always sent. It is a high-water mark and not a limit: a
   * gauge, a percentage or a bar filling towards it would reinvent exactly the
   * unmeasured maximum that was removed.
   */
  busiestOnRecord: number;
  /**
   * Requests by kind, largest first. Can sum to **less** than `spent`: the total
   * is counted in lines and this is parsed, and a line a crash cut in half is
   * still a request that left.
   */
  kinds: SpendKind[];
};

/**
 * Today's request spend.
 *
 * Its own call rather than a field on the pass document, because the passes
 * that matter most are the ones nobody pressed: a scheduler runs one every
 * fifteen minutes with this page shut, and a figure carried on `/collect` would
 * only ever be as fresh as the last press somebody made.
 */
export function fetchFareSpend(options: { signal?: AbortSignal } = {}): Promise<FareSpend> {
  return apiRequest<FareSpend>('/api/fares/spend', { signal: options.signal });
}

/** How the current pass is getting on, or how the last one ended — 12.210. */
export function fetchCollectionProgress(
  options: { signal?: AbortSignal } = {},
): Promise<CollectResponse> {
  return apiRequest<CollectResponse>('/api/fares/collect', { signal: options.signal });
}
