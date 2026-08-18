import type { StorageKey } from '@/shared/storage/keys';

/**
 * The routes being watched, as they are stored and as they are edited.
 *
 * Same shape as the Investing watchlist and for the same reason: pure
 * transitions over a value, so adding, removing and de-duplicating can be
 * tested without a browser, and neither the hook nor the UI holds a rule.
 *
 * A watched route is a route *and a date*. That is not incidental — the price
 * of "LIM to SCL" is not a thing, the price of "LIM to SCL on 16 October" is.
 * Two entries for the same pair on different dates are two different series
 * and must not collapse into one.
 */

export const FARE_ROUTES_KEY: StorageKey = 'airfare-routes';

/** Peru is where this reader flies from, so an empty form starts there. */
export const DEFAULT_ORIGIN = 'LIM';

/**
 * USD rather than PEN.
 *
 * A history is read across months, and a local-currency series moves when the
 * exchange rate moves — which looks exactly like a fare change and is not one.
 */
export const DEFAULT_CURRENCY = 'USD';

export type FareRoute = {
  /** IATA, upper case. */
  origin: string;
  destination: string;
  /** The departure being watched, `YYYY-MM-DD`. */
  flightDate: string;
  /** Absent means one way. */
  returnDate: string | null;
  currency: string;
};

export type FareRoutes = {
  version: 1;
  routes: FareRoute[];
};

export const EMPTY_FARE_ROUTES: FareRoutes = { version: 1, routes: [] };

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** `YYYY-MM-DD`, and a date that exists. `2026-02-31` is a typo, not a day. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Three letters. Airports have digits in other coding schemes, IATA does not. */
export function isAirportCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim());
}

/**
 * What makes two entries the same watch.
 *
 * The archive keys history by route alone, so two entries differing only by
 * date write into one file — which is correct, they are the same city pair —
 * but two *identical* entries would collect the same price twice a day and
 * double every point in the series.
 */
export function routeId(route: FareRoute): string {
  return [route.origin, route.destination, route.flightDate, route.returnDate ?? ''].join('|');
}

export function routeLabel(route: FareRoute): string {
  return `${route.origin} → ${route.destination}`;
}

/**
 * Parse whatever storage returns.
 *
 * Same guard the other documents use: repair what can be repaired, drop what
 * would break an invariant, never invent. A route with an unusable date is
 * dropped rather than defaulted to today — collecting a price for a day nobody
 * asked about would put a wrong point into a real series.
 */
export function normalizeFareRoutes(value: unknown): FareRoutes {
  if (typeof value !== 'object' || value === null) return EMPTY_FARE_ROUTES;

  const raw = (value as { routes?: unknown }).routes;
  if (!Array.isArray(raw)) return EMPTY_FARE_ROUTES;

  const routes: FareRoute[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Record<string, unknown>;

    if (!isAirportCode(candidate.origin) || !isAirportCode(candidate.destination)) continue;
    if (!isCalendarDate(candidate.flightDate)) continue;

    const origin = normalizeCode(candidate.origin);
    const destination = normalizeCode(candidate.destination);
    // A route to itself is a typo that would send a real request.
    if (origin === destination) continue;

    const returnDate = isCalendarDate(candidate.returnDate) ? candidate.returnDate : null;
    // A return before the departure is not a trip.
    const route: FareRoute = {
      origin,
      destination,
      flightDate: candidate.flightDate,
      returnDate: returnDate && returnDate >= candidate.flightDate ? returnDate : null,
      currency:
        typeof candidate.currency === 'string' && /^[A-Za-z]{3}$/.test(candidate.currency)
          ? normalizeCode(candidate.currency)
          : DEFAULT_CURRENCY,
    };

    const id = routeId(route);
    if (seen.has(id)) continue;
    seen.add(id);
    routes.push(route);
  }

  return { version: 1, routes };
}

export function addRoute(document: FareRoutes, route: FareRoute): FareRoutes {
  const normalized = normalizeFareRoutes({ routes: [route] }).routes[0];
  if (!normalized) return document;
  if (document.routes.some((existing) => routeId(existing) === routeId(normalized))) {
    // Already watched. A no-op rather than a move: you asked for it to be
    // present, not for it to jump to the end.
    return document;
  }
  return { ...document, routes: [...document.routes, normalized] };
}

/**
 * Move one watched route to where another sits.
 *
 * Same contract as `investing/data/watchlist.reorder`, and the same reason: a
 * drop between rows is a request for a position, not a swap with whatever
 * happened to be there.
 *
 * The order matters beyond taste — the collector spends its daily request
 * budget down the list, so a route the reader dragged to the top is one they
 * have said should be polled first when the budget will not cover everything.
 */
export function reorderRoutes(document: FareRoutes, from: string, to: string): FareRoutes {
  if (from === to) return document;

  const fromIndex = document.routes.findIndex((route) => routeId(route) === from);
  const toIndex = document.routes.findIndex((route) => routeId(route) === to);
  if (fromIndex < 0 || toIndex < 0) return document;

  const routes = [...document.routes];
  const [moved] = routes.splice(fromIndex, 1);
  routes.splice(toIndex, 0, moved);
  return { ...document, routes };
}

export function removeRoute(document: FareRoutes, id: string): FareRoutes {
  const routes = document.routes.filter((route) => routeId(route) !== id);
  return routes.length === document.routes.length ? document : { ...document, routes };
}

/**
 * The routes whose departure has not happened yet.
 *
 * A collection pass must not ask about a flight that has left: the provider
 * answers nothing, the route reports a failure every day forever, and the
 * failure is noise rather than news. They stay in the document — the history
 * already collected is still worth reading — they are simply not collected.
 */
export function collectableRoutes(document: FareRoutes, today: string): FareRoute[] {
  return document.routes.filter((route) => route.flightDate >= today);
}
