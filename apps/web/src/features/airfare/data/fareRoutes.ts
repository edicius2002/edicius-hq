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
  /*
   * There is no `focusDate` beside it, and there is not going to be — 12.260,
   * superseding 12.130 and everything built on it. A watch named one departure
   * inside its month for about a day; the whole read side narrowed onto that
   * day, the form asked for it, the detail panel offered a way back out of it
   * and the collector kept it first when a pass ran short. All of that is
   * gone. A watched route is a city pair and a month, and the page reads the
   * month — which is what 12.110 said it was for.
   */
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

/**
 * How many days ahead the provider will answer about a departure at all.
 *
 * The same 330 the API holds in `MAX_DEPARTURE_HORIZON_DAYS`, and the same
 * measurement is written beside it: +330 days returned itineraries, while
 * +340, +348, +355 and +370 all answered `upstream-error`.
 *
 * Copied across the boundary rather than fetched — 12.184. There is no config
 * endpoint to ask, and adding one would put a round trip on every page load in
 * front of a single integer that has moved once. The server stays the
 * authority: a departure past this still comes back `beyond-horizon` in the
 * collector's skip list whatever the form believes. What this copy buys is a
 * refusal while the reader is still standing in front of the field that caused
 * it, instead of a route that looks added and quietly never collects.
 */
export const COLLECTABLE_HORIZON_DAYS = 330;

/**
 * The furthest departure worth watching, as `YYYY-MM-DD`.
 *
 * What bounds the departure picker, so the browser itself refuses a date the
 * provider will not answer about rather than the form catching it afterwards.
 *
 * `Date` appears here and it is safe, for the one reason it ever is: the value
 * is built with `Date.UTC` and read back through the `getUTC*` accessors, so
 * it is never in a zone Lima could shift it out of. Adding days to a UTC
 * midnight rolls the month and the year for us, which is why the arithmetic is
 * here rather than a string split — a day count is the one thing that cannot
 * be done by slicing.
 */
export function lastCollectableDay(today: string): string {
  if (!isCalendarDate(today)) return today;
  const [year, month, day] = today.split('-').map(Number);
  const last = new Date(Date.UTC(year, month - 1, day + COLLECTABLE_HORIZON_DAYS));
  return [
    last.getUTCFullYear(),
    String(last.getUTCMonth() + 1).padStart(2, '0'),
    String(last.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * The month after the one `today` falls in, `YYYY-MM`.
 *
 * What the add form starts on — 12.262. Nobody watching fares is booking the
 * month they are standing in: the near end of it has already gone and the rest
 * is the part of the horizon where a price barely moves any more.
 *
 * String arithmetic, and the roll is the whole reason it is a function rather
 * than a slice. December's next month is January of the *next year*, so the
 * two dropdowns the form offers must both move, and a default that rolled the
 * month while leaving the year behind would put the reader on a month eleven
 * months in the past with nothing on screen saying so.
 *
 * A `Date` would roll it too, and is refused for the reason the rest of this
 * module refuses one: `new Date('2026-12-01')` is midnight UTC, and reading
 * the month back in Lima gives November.
 */
export function nextMonth(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return today;
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * The last month with any collectable departure in it, `YYYY-MM`.
 *
 * A month counts if *part* of it is inside the horizon, not all of it. The
 * horizon lands mid-month almost always — 15/07/2027 from today — and a month
 * whose first half can be collected is a month worth watching: the collector
 * expands it, polls the days it can reach and reports the rest as
 * `beyond-horizon` by name, which is the same thing it already does for the
 * days of the current month that have gone.
 */
export function lastCollectableMonth(today: string): string {
  return monthOf(lastCollectableDay(today));
}

/**
 * The years the form's year dropdown offers, ascending.
 *
 * Derived from the horizon rather than typed in — 12.263. `[26, 27]` is what
 * it yields today and writing those two down would be right until 2027 and
 * silently wrong after it, in a control whose whole job is to stop a reader
 * naming a month nobody can collect.
 *
 * It is two years for most of the year and **one** for part of it, and that is
 * correct rather than a shortfall: 330 days from a January date lands inside
 * the same year, so in January there is no second year to offer. The list is
 * whatever the window spans.
 *
 * It starts at today's own year rather than at the default month's, because
 * the current month is collectable — its remaining days are — and a reader
 * adding a watch on the month they are standing in must be able to say so.
 */
export function collectableYears(today: string): number[] {
  const first = Number(today.slice(0, 4));
  const last = Number(lastCollectableMonth(today).slice(0, 4));
  if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) return [];
  const years: number[] = [];
  for (let year = first; year <= last; year += 1) years.push(year);
  return years;
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

/*
 * `readingPrefix` and `focusDeparted` were here, and both went with the focus
 * — 12.260. What a route is read as is now its month and nothing else, so a
 * function to choose between two answers has one answer to choose from; and a
 * month that has gone is `route.month < monthOf(today)`, which is what the
 * watchlist row and `collectableRoutes` have always compared.
 *
 * The prefix property they leaned on is untouched and still load-bearing:
 * `snapshotsFor` filters departures with `startsWith` and the history
 * endpoint's `departure` parameter matches the same way — 12.112 — so the page
 * narrows on `route.month` directly.
 */

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

/**
 * The twelve, in order, exported because the add form offers all of them.
 *
 * One list rather than two: the form's dropdown and `formatFlightMonth` are
 * the two places a month is written out in words, and two arrays would be two
 * chances for the row above a chart and the control that added it to spell the
 * same month differently.
 */
export const MONTH_NAMES = [
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

/*
 * `formatReading` went with the focus too — 12.260. It chose between a day and
 * a month for a heading; there is one thing to name now, and every caller says
 * `formatFlightMonth(route.month)`. `formatFlightDate` stays, because the
 * departures inside a month are still real dates and the flight table, the
 * collector's reports and the horizon refusal all print them.
 */

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
 *
 * **A stored focus becomes simply its month, and this is the whole migration**
 * — 12.261. An entry written between 12.130 and now carries both `month` and
 * `focusDate`; the month is already there and already right, so dropping the
 * focus is a key this function stops reading rather than a repair it performs.
 * The owner's own watchlist is the case: `LIM→SCL 2027-03` with
 * `focusDate: 2027-03-09` loads as `LIM→SCL 2027-03`, route intact, and the
 * panel shows all thirty-one departures instead of the one.
 *
 * It is deliberately **not** pinned to `2027-03-01`. Keeping the day and
 * throwing away the thirty others would be the opposite of what taking the
 * focus away means, and the first of the month is a day nobody chose.
 *
 * This is also why the migration belongs here and nowhere else. 12.133's rule
 * still holds — the normalizer takes no clock and edits nothing by itself —
 * and nothing here breaks it: not reading a key needs no clock, invents
 * nothing, and writes nothing back. The stored JSON keeps its dead `focusDate`
 * until the reader's next add, remove or reorder rewrites the document, and
 * every read in between produces the same month. A migration that wrote on
 * load would be a document editing itself on a page view, which 12.133 refused
 * for the departed focus and refuses here for the same reason.
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

    // `candidate.focusDate` is not read, and that is the migration — 12.261.
    // The month beside it is what the watch always was.
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

/*
 * `setFocus` was here and is gone with the focus — 12.260. It was the one
 * mutation that could change a route in place, and with it goes the only
 * reason a watch had a state the reader could put it into and had to be given
 * a way back out of. A watch is now added and removed and reordered, and that
 * is all that can happen to one.
 */

export function addRoute(document: FareRoutes, route: FareRoute): FareRoutes {
  const normalized = normalizeFareRoutes({ routes: [route] }).routes[0];
  if (!normalized) return document;
  const id = routeId(normalized);
  // Already watched, so nothing to do — and deliberately not a move either:
  // you asked for it to be present, not for it to jump to the end of a list
  // whose order the collector spends its budget down. It used to carry the
  // focus over, which was the one thing re-adding could still change; with the
  // focus gone (12.260) an identical watch is an identical watch, and the same
  // document comes back.
  if (document.routes.some((existing) => routeId(existing) === id)) return document;
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
