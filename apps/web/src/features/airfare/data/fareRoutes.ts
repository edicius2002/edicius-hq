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
  /**
   * The one departure inside `month` this reader actually means to take,
   * `YYYY-MM-DD` — 12.130, as 12.180 revised it.
   *
   * Still optional in the type, and the optionality now means something
   * narrower than it did. Every route the form adds carries one, because the
   * form asks for a date and derives the month from it — 12.180. What stays
   * optional is the two shapes the form no longer produces: a route stored
   * before 12.180 that has a month and never had a day, and one whose focus
   * the reader took back from the detail panel. Both must keep working and
   * neither may have a day invented for it, which is why this is not required
   * and why the normalizer still takes no clock — 12.133.
   *
   * What the focus buys is the two things a month cannot say. It is what the
   * page *reads* — `readingPrefix` narrows the detail, the chart and the
   * flight table onto it — and it is what the collector keeps first when a
   * pass's request budget will not stretch to every watched departure.
   *
   * It must fall inside `month`. That is not a convention the callers agree
   * to keep: `readingPrefix` only works because `2027-03-09` starts with
   * `2027-03`, so a focus outside its month would narrow the page onto an
   * empty set while the row above it still said March.
   */
  focusDate?: string;
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
 * The departures this route is *read* as, as a prefix — 12.131.
 *
 * `2027-03` for a watch with no focus, `2027-03-09` for one with. Both are
 * prefixes of the same `YYYY-MM-DD` departure key, which is the whole trick:
 * `snapshotsFor` filters with `startsWith` and the history endpoint's
 * `departure` parameter matches the same way, so narrowing the entire page
 * onto one day is one longer string rather than a second code path beside the
 * month. The same property 12.112 leaned on to leave the archive alone.
 *
 * The month is still what is collected. This is only what is looked at.
 */
export function readingPrefix(route: FareRoute): string {
  return route.focusDate ?? route.month;
}

/**
 * Whether the day this reader picked has already gone.
 *
 * `today` is passed in rather than read from a clock, for the reason the
 * normalizer takes none at all: a focus is not dropped when its day passes.
 * The archive it points at is still the archive of the flight they meant to
 * take, and a value that disappeared because the page was opened a day later
 * would be a document editing itself. It is said out loud instead.
 */
export function focusDeparted(route: FareRoute, today: string): boolean {
  return route.focusDate !== undefined && route.focusDate < today;
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
 * How this route's departures are written on screen.
 *
 * The focus date if there is one, `dd/mm/yyyy` like every other real date
 * here; the month name if there is not. The two forms are deliberately
 * unmistakable for each other — 12.114 chose `March 2027` over `03/2027`
 * precisely so a heading that switches between them cannot be misread as one
 * that changed its mind about the day.
 *
 * Paired with `readingPrefix` and used everywhere it is: a heading naming a
 * day over figures drawn from a month would be the worst of both.
 */
export function formatReading(route: FareRoute): string {
  return route.focusDate ? formatFlightDate(route.focusDate) : formatFlightMonth(route.month);
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
 *
 * A focus date is dropped rather than repaired when it falls outside its own
 * month, and rather than the route being dropped with it — 12.132. Both other
 * answers invent. Widening the month to the focus's month changes what gets
 * collected, which is not something a reading preference is allowed to do;
 * moving the day into the watched month names a departure nobody typed. The
 * entry states two things that cannot both be true and does not say which is
 * wrong, so the weaker of the two goes and the route survives with no focus —
 * a shape the whole feature already handles, because most routes have it.
 *
 * A pre-12.110 `flightDate` is **not** promoted into a focus, and 12.180 does
 * not change that. The form now asks for a date and so gives every route it
 * adds a focus — but that is a reader choosing a day, which is the whole of
 * what a focus means. A legacy `flightDate` was the only day that entry could
 * name rather than one picked out of thirty-one, and promoting it would put a
 * focus the reader never chose on every stored route at once, silently, on the
 * first read after an upgrade. This function still takes no clock and still
 * writes nothing back by itself — 12.133 — so a route stored with a month and
 * no focus loads with a month and no focus, untouched.
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

    // Hoisted so the type predicate narrows it: `candidate.focusDate` is
    // `unknown` off an index signature, and reading it twice would ask TypeScript
    // to remember a narrowing it does not keep across property accesses.
    const rawFocus = candidate.focusDate;
    const focus = isCalendarDate(rawFocus) && monthOf(rawFocus) === month ? rawFocus : null;

    const route: FareRoute = {
      origin,
      destination,
      month,
      ...(focus === null ? {} : { focusDate: focus }),
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

/**
 * Point a watch at one of its days, or at none of them.
 *
 * The only mutation that touches a focus, so the invariant is checked in one
 * place: a day outside the route's own month clears the focus rather than
 * setting it, which the form makes unreachable by refusing first — but a
 * transition that could be talked into breaking `readingPrefix` would be a
 * transition the normalizer had to defend against on every read.
 *
 * `routeId` deliberately does not include the focus, so this never changes
 * which watch a route is: the selection, the row's report and the archive it
 * points at all survive a focus being set, moved or dropped. Two entries for
 * one month with different focuses would be two watches collecting the same
 * thirty-one departures twice, which is the collision `routeId` exists to
 * stop.
 */
export function setFocus(document: FareRoutes, id: string, focus: string | null): FareRoutes {
  const index = document.routes.findIndex((route) => routeId(route) === id);
  if (index < 0) return document;

  const current = document.routes[index];
  const next =
    focus !== null && isCalendarDate(focus) && monthOf(focus) === current.month ? focus : null;
  if ((current.focusDate ?? null) === next) return document;

  // Rebuilt rather than spread-and-deleted, so clearing a focus leaves no
  // `focusDate: undefined` key behind to be written into the stored document.
  const bare: FareRoute = {
    origin: current.origin,
    destination: current.destination,
    month: current.month,
    currency: current.currency,
  };
  const routes = [...document.routes];
  routes[index] = next === null ? bare : { ...bare, focusDate: next };
  return { ...document, routes };
}

export function addRoute(document: FareRoutes, route: FareRoute): FareRoutes {
  const normalized = normalizeFareRoutes({ routes: [route] }).routes[0];
  if (!normalized) return document;
  const id = routeId(normalized);
  if (document.routes.some((existing) => routeId(existing) === id)) {
    // Already watched. Still not a move — you asked for it to be present, not
    // for it to jump to the end — but the focus travels, because the form is
    // the only control that names a day. Re-adding a watch you already have is
    // how its day is moved to another one. It is no longer how a day comes
    // *off*: under 12.180 the form's date is required, so it can never hand
    // over a route with no focus, and the way back to the whole month is the
    // detail panel's own control — 12.182. The `?? null` stays because this is
    // a pure transition over a value and callers other than the form exist;
    // making it unreachable in the UI is not a reason to let it invent a focus
    // here instead. With nothing to change it is the no-op it always was, down
    // to returning the same document.
    return setFocus(document, id, normalized.focusDate ?? null);
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
