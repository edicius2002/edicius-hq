import type { StorageKey } from '@/shared/storage/keys';

/**
 * The routes being watched, as they are stored and as they are edited.
 *
 * Same shape as the Investing watchlist and for the same reason: pure
 * transitions over a value, so adding, removing and de-duplicating can be
 * tested without a browser, and neither the hook nor the UI holds a rule.
 *
 * A watched route is a route *and a departure month* — 12.110, superseding
 * 12.6. The price of "LIM to SCL" is still not a thing, but neither was the
 * question the reader was actually asking: nobody wants to know what the 16th
 * of October costs, they want to know what October costs and which day of it
 * is the cheap one. A month is the smallest unit that can answer that, and the
 * collector expands it into its departures rather than the document holding
 * thirty entries a reader would have to add by hand and remove one at a time.
 *
 * Two entries for the same pair in different months are two different watches
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
  /**
   * The departure month being watched, `YYYY-MM`.
   *
   * There is no return leg beside it, and the absence is a decision rather
   * than an omission — 12.113. A return date belongs to one departure; thirty
   * departures sharing one would be twenty-nine wrong trips, and a return that
   * moved with each departure would be a trip *length*, which is a different
   * product from the one being built.
   */
  month: string;
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

/**
 * `YYYY-MM`, and a month the calendar has.
 *
 * The range is checked in the pattern rather than by building a date, because
 * unlike a day a month has no length to be wrong about: twelve of them exist
 * and `13` is the only way to miss.
 */
export function isMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/**
 * The month a `YYYY-MM-DD` date falls in.
 *
 * A string slice rather than a `Date`, for the reason `formatFlightDate` gives
 * below: parsing `2026-10-01` and reading the month back west of Greenwich
 * yields September.
 */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** Three letters. Airports have digits in other coding schemes, IATA does not. */
export function isAirportCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim());
}

/**
 * What makes two entries the same watch.
 *
 * The archive keys history by city pair, so two entries differing only by
 * month write into one file — which is correct, they are the same city pair,
 * and every snapshot in it carries the departure it belongs to — but two
 * *identical* entries would collect every departure in the month twice and
 * double every point in every series it holds.
 */
export function routeId(route: FareRoute): string {
  return [route.origin, route.destination, route.month].join('|');
}

export function routeLabel(route: FareRoute): string {
  return `${route.origin} → ${route.destination}`;
}

/**
 * A stored date, written the way this reader writes one.
 *
 * `YYYY-MM-DD` is what goes to disk and what sorts and compares correctly, so
 * it stays that everywhere except on screen. The conversion is a string split
 * rather than a `Date`: parsing `2026-10-17` gives midnight UTC, and rendering
 * that anywhere west of Greenwich — Lima, for one — shows the 16th.
 *
 * Anything that is not a plain calendar date comes back untouched, because a
 * date the reader can see and puzzle over beats a silent blank.
 */
export function formatFlightDate(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) return iso;
  const [, year, month, day] = parts;
  return `${day}/${month}/${year}`;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * A watched month, written so it cannot be mistaken for a day.
 *
 * `March 2027` rather than `03/2027` — 12.114. The rest of this feature writes
 * dates `dd/mm/yyyy`, and `03/2027` sits close enough inside that pattern that
 * a reader glancing down a list has to work out whether `03` is a day or a
 * month. A month name is the one form that can never be read as the other, and
 * the dd/mm/yyyy convention is untouched for the actual departure dates, which
 * are what the flight table and the collector's own reports print.
 *
 * Built from an array rather than `toLocaleString`, for the reason the rest of
 * this module avoids `Date`: a month is a string here, and handing it to a
 * date constructor is how `2027-03` becomes February for a reader in Lima.
 */
export function formatFlightMonth(month: string): string {
  const parts = /^(\d{4})-(\d{2})$/.exec(month);
  if (!parts) return month;
  const name = MONTH_NAMES[Number(parts[2]) - 1];
  return name ? `${name} ${parts[1]}` : month;
}

/**
 * Parse whatever storage returns.
 *
 * Same guard the other documents use: repair what can be repaired, drop what
 * would break an invariant, never invent.
 *
 * The repair that matters here is the old shape: an entry written before
 * 12.110 carries `flightDate: "2026-10-17"`, and the month that date falls in
 * is not a guess — the value states it. Dropping those would have emptied the
 * watchlist on the first read after the upgrade, and asking the reader to
 * retype what the document already says is not a migration, it is a data loss
 * with a form in front of it. A `flightDate` that is not a real date is still
 * dropped: `2026-02-31` names no month either.
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

    const month = isMonth(candidate.month)
      ? candidate.month
      : isCalendarDate(candidate.flightDate)
        ? monthOf(candidate.flightDate)
        : null;
    if (month === null) continue;

    const origin = normalizeCode(candidate.origin);
    const destination = normalizeCode(candidate.destination);
    // A route to itself is a typo that would send a real request.
    if (origin === destination) continue;

    const route: FareRoute = {
      origin,
      destination,
      month,
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
 * The order matters beyond taste — the collector spends its request budget
 * down the list, so a route the reader dragged to the top is one they have
 * said should be polled first when the budget will not cover everything.
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
 * The routes whose month has not finished.
 *
 * A collection pass must not ask about a flight that has left: the provider
 * answers nothing, the route reports a failure every day forever, and the
 * failure is noise rather than news. A month is over when the calendar has
 * moved past it, which is a string comparison against today's own month. The
 * days *inside* the current month that have already gone are the collector's
 * business, not this one's — it skips them one at a time and says why, which
 * is a thing only the side that expands the month can do.
 *
 * They stay in the document either way: the history already collected is still
 * worth reading.
 */
export function collectableRoutes(document: FareRoutes, today: string): FareRoute[] {
  const thisMonth = monthOf(today);
  return document.routes.filter((route) => route.month >= thisMonth);
}
