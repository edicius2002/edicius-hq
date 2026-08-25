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
 * A watch holds *several* months, and two entries for the same pair collapse
 * into one — `a-watch-is-a-pair-and-its-months`, reversing the rule that stood
 * here. 12.110's own argument survives the reversal intact: a month is still
 * the smallest unit that answers what October costs, the collector still
 * expands it into departures, and the chart still draws one month at a time.
 * What was wrong was making the unit of *reading* the unit of *identity*. It
 * left "watch April as well" indistinguishable from "watch another route", so
 * a reader tracking one city pair across three months got three rows, three
 * colours, three arcs and three presses for one thing they think of as one
 * thing — and no way to change their mind about a month short of removing a
 * watch and building another.
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
   * The departure months being watched, `YYYY-MM`, ascending, unique, and
   * never empty.
   *
   * **`months[0]` is not "the month this route is on".** The order carries no
   * privilege and there is no marker for a current one: it is sorted because a
   * set of months has no authored order to keep, and ascending because that is
   * the order the collector polls in (12.111, nearest first), so the document
   * reads the way the pass runs. Which month is being *read* is `openingMonth`
   * and the session's own record, and it is routinely not the first — the
   * first is the one most likely to have departed. Said here because
   * `months[0]` is exactly what a later reader will mistake for a focus.
   *
   * There is no return leg beside them, and the absence is a decision rather
   * than an omission — 12.113. A return date belongs to one departure; thirty
   * departures sharing one would be twenty-nine wrong trips, and a return that
   * moved with each departure would be a trip *length*, which is a different
   * product from the one being built.
   */
  months: string[];
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
 * What makes two entries the same watch: the city pair, and nothing else.
 *
 * The month used to be in here, and taking it out is the whole of
 * `a-watch-is-a-pair-and-its-months`. The archive was always keyed by city
 * pair — `route_stem(origin, destination)` in `fare_history.py`, with the
 * departure a field inside the file — so an id carrying a month was the one
 * place in the system where two months of one pair were two different things.
 * Every keyed map in this feature reads this string: the reports, the bars,
 * the notices, the colours, the arcs and the selection. Making it the pair
 * makes all of them agree with the archive they draw.
 *
 * It takes a `Pick` rather than a whole route so that a caller holding only a
 * pair — the collision check in the editor, an id being rebuilt from a
 * report — cannot be made to invent months it does not have.
 */
export function routeId(route: Pick<FareRoute, 'origin' | 'destination'>): string {
  return [route.origin, route.destination].join('|');
}

export function routeLabel(route: Pick<FareRoute, 'origin' | 'destination'>): string {
  return `${route.origin} → ${route.destination}`;
}

/*
 * `readingPrefix` and `focusDeparted` were here, and both went with the focus
 * — 12.260. What a route is read as is one of its months, chosen by
 * `readingMonth` below rather than by picking a day inside one; and a month
 * that has gone is `monthHasDeparted`, which is what the watchlist row and the
 * collect payload compare.
 *
 * The prefix property they leaned on is untouched and still load-bearing:
 * `snapshotsFor` filters departures with `startsWith` and the history
 * endpoint's `departure` parameter matches the same way — 12.112 — so the page
 * narrows on the month it is reading, one at a time.
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
 * a month for a heading; a heading names the month being read, and a control
 * that stands for a whole watch says `formatFlightMonths` instead — one for a
 * reading, one for a set. `formatFlightDate` stays, because the
 * departures inside a month are still real dates and the flight table, the
 * collector's reports and the horizon refusal all print them.
 */

/**
 * Months, ascending and without repeats.
 *
 * A plain string sort, because `YYYY-MM` sorts chronologically — the same
 * property the rest of this module leans on, and the reason no `Date` appears
 * in it. Sorting in one place rather than at every call site is also what
 * makes two routes holding the same months structurally equal, which is what
 * lets the transitions below hand back the document they were given when
 * nothing actually changed.
 */
function sortedMonths(months: readonly string[]): string[] {
  return [...new Set(months)].sort();
}

/**
 * Every departure month one stored entry names, in any of the three shapes
 * this document has ever been written in.
 *
 * - `months: ["2027-03", "2027-04"]` — what is written now.
 * - `month: "2027-03"` — 12.110's shape, one entry per pair and month.
 * - `flightDate: "2027-03-09"` — pre-12.110, read as the month it falls in.
 *
 * All three at once, deliberately: they are the same fact written by different
 * generations of this app rather than one key superseding another, a document
 * edited by hand can carry two of them, and a month the document states is not
 * a month this function gets to decide it did not mean. A `flightDate` that is
 * not a real date still names no month — `2026-02-31` is a typo rather than
 * evidence of February — and an entry that states nothing readable comes back
 * empty for its caller to drop.
 */
function statedMonths(candidate: Record<string, unknown>): string[] {
  const stated: string[] = [];

  const listed = candidate.months;
  if (Array.isArray(listed)) {
    for (const month of listed) if (isMonth(month)) stated.push(month);
  }
  if (isMonth(candidate.month)) stated.push(candidate.month);
  if (isCalendarDate(candidate.flightDate)) stated.push(monthOf(candidate.flightDate));

  return stated;
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
 * **A month becomes one of several, and two entries for a pair become one**
 * — `a-watch-is-a-pair-and-its-months`. Three things follow, and each is a
 * rule rather than a convenience:
 *
 * The months of one entry are the **union** of everything it states: a
 * `months` array, plus a `month`, plus the month a `flightDate` falls in. A
 * union and not the fallback chain the focus migration used, because there one
 * key superseded another and here they are the same fact written by two
 * generations of this app — a document edited by hand can hold both, and
 * "repair what can be repaired, never invent" points at keeping every month
 * the document actually says.
 *
 * **A merged route takes the position of the first entry for its pair**, and
 * its currency. The order is not decoration: `reorderRoutes` records that the
 * collector spends its budget down the list, so a route the reader dragged to
 * the top is one they said to poll first. A later duplicate is a row they
 * never promoted, and taking the last position would silently demote a watch
 * on an upgrade with nothing on screen saying why. Currency goes with it
 * because a currency is a property of the pair and not of a month — see
 * `DEFAULT_CURRENCY` — and one row cannot honour two.
 *
 * The owner's own document is the case, and the cost is visible rather than
 * hidden: `services/api/.local-data/kv/airfare-routes.json` holds `AEP-SCL`
 * twice, for `2027-03` and `2027-04`. Five rows load as four, `AEP-SCL` stays
 * fourth carrying both months, **and the list is one row shorter than it was**.
 *
 * This is also why the migration belongs here and nowhere else. 12.133's rule
 * still holds — the normalizer takes no clock and edits nothing by itself —
 * and nothing here breaks it: not reading a key needs no clock, invents
 * nothing, and writes nothing back. The argument is now stronger rather than
 * weaker, because this migration changes the *length* of the list and the
 * position of everything after a merge: a document that did that on load would
 * be a watchlist rearranging itself under a reader who only opened the tab.
 * The stored JSON keeps its old shape until the reader's next add, remove,
 * reorder or edit rewrites it, and every read in between produces the same
 * routes. `useStoredDocument` normalizes on read *and again inside `edit`*,
 * which is what makes running this twice having to mean the same as running it
 * once — a property with a test of its own.
 */
export function normalizeFareRoutes(value: unknown): FareRoutes {
  if (typeof value !== 'object' || value === null) return EMPTY_FARE_ROUTES;

  const raw = (value as { routes?: unknown }).routes;
  if (!Array.isArray(raw)) return EMPTY_FARE_ROUTES;

  // Keyed by pair, which is what turns the de-duplication that was already
  // here into the merge. Insertion order is the document's order, so the first
  // entry for a pair keeps its place however many later ones fold into it.
  const merged = new Map<string, FareRoute>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Record<string, unknown>;

    if (!isAirportCode(candidate.origin) || !isAirportCode(candidate.destination)) continue;

    const months = statedMonths(candidate);
    if (months.length === 0) continue;

    const origin = normalizeCode(candidate.origin);
    const destination = normalizeCode(candidate.destination);
    // A route to itself is a typo that would send a real request.
    if (origin === destination) continue;

    const id = routeId({ origin, destination });
    const held = merged.get(id);
    if (held) {
      // Union into the entry already there, so the position and the currency
      // both come from the row the reader placed rather than from the one that
      // happened to be written later.
      held.months = sortedMonths([...held.months, ...months]);
      continue;
    }

    // `candidate.focusDate` is not read, and that is the migration — 12.261.
    // `candidate.month` is read and then stops being written, which is this
    // one. Neither is a repair this function performs; both are keys it does
    // or does not go on reading.
    merged.set(id, {
      origin,
      destination,
      months: sortedMonths(months),
      currency:
        typeof candidate.currency === 'string' && /^[A-Za-z]{3}$/.test(candidate.currency)
          ? normalizeCode(candidate.currency)
          : DEFAULT_CURRENCY,
    });
  }

  return { version: 1, routes: [...merged.values()] };
}

/*
 * `setFocus` was here and went with the focus — 12.260. `editRoute` below is
 * not it coming back, and the difference is worth stating because the shapes
 * rhyme.
 *
 * The rule that stood here — a watch is added, removed and reordered, and that
 * is all that can happen to one — was never a preference. It was a
 * *consequence of identity*: while the month was part of `routeId`, every
 * field a reader might edit was part of the identity, so an edit was
 * arithmetically a remove and an add, and a fourth transition would have been
 * a second, ambiguous spelling of two that already existed. `setFocus` was
 * worse than redundant on top of that — it wrote a *reading state* into a
 * stored document, which is the thing 12.260 threw out.
 *
 * `editRoute` is neither. The months and the pair are the parts of a watch
 * that can change while it stays a watch the reader recognises, and both are
 * what gets *collected* rather than how it gets *read*.
 */

/** Whether two month lists hold the same months. Both are sorted already. */
function sameMonths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((month, at) => month === right[at]);
}

/**
 * Watch a route, or add months to one already watched.
 *
 * An existing pair **merges** rather than being refused. Under the old
 * identity, adding LIM→SCL for December while October was watched built a
 * second row; under this one it is a second month for a watch that exists, and
 * a no-op would swallow the request with no row anywhere to show for it.
 *
 * Half the old argument survives word for word, and now covers the merge too:
 * deliberately **not** a move either. You asked for those months to be
 * watched, not for the row to jump to the end of a list whose order the
 * collector spends its budget down. A pair that adds nothing new comes back as
 * the identical document, so the store writes nothing.
 */
export function addRoute(document: FareRoutes, route: FareRoute): FareRoutes {
  const normalized = normalizeFareRoutes({ routes: [route] }).routes[0];
  if (!normalized) return document;

  const id = routeId(normalized);
  const index = document.routes.findIndex((existing) => routeId(existing) === id);
  if (index < 0) return { ...document, routes: [...document.routes, normalized] };

  const held = document.routes[index];
  const months = sortedMonths([...held.months, ...normalized.months]);
  if (sameMonths(months, held.months)) return document;

  const routes = [...document.routes];
  routes[index] = { ...held, months };
  return { ...document, routes };
}

/**
 * Change a watch in place: its months, its city pair, or both.
 *
 * Takes a whole route rather than a patch, because the editor is one form that
 * commits one value — it is the add form with a watch loaded into it — and a
 * patch would need a merge rule per field. A whole value also goes through the
 * same single-entry validation `addRoute` uses, so there is one door into this
 * document rather than two.
 *
 * **The position is kept**, and that is the entire reason this is a transition
 * rather than `removeRoute` followed by `addRoute`. That pair would send the
 * row to the end of a list whose order the collector spends its budget down,
 * so every edit would quietly be a reprioritisation the reader did not ask for.
 *
 * Four refusals, each of which returns the document unchanged:
 * - `next` states no readable month. Clearing every chip is not how a watch
 *   ends; the control that ends one says Remove on it, and answering a cleared
 *   strip by deleting the row would take the colour, the archive's reader and
 *   the place in the collector's order along with it.
 * - `id` names no row. **This must never append.** Re-creating a watch the
 *   reader deleted in another tab is the one silent write this function could
 *   make, and a stale editor is exactly how it would happen.
 * - Nothing actually differs, so the store writes nothing.
 * - A route to itself, or an unreadable pair — `normalizeFareRoutes` refuses
 *   those for the reasons written there.
 *
 * **Editing onto a pair that is already watched merges the two into one**, at
 * whichever of them sits earlier, and the list gets shorter. Refusing was the
 * alternative and it loses twice: this layer has no channel for a message —
 * every transition returns a document, and `useStoredDocument.edit` reads "gave
 * back what it was given" as "decided against editing" — and typing SCL→LIM
 * into a loaded editor is the same request as typing it into the add form,
 * which now answers by merging. Two answers to one question is how a reader
 * learns a form is arbitrary. The earlier position wins because
 * `normalizeFareRoutes` already answered "which of two entries for one pair
 * wins" with *first*, and one rule stated twice beats two rules; it is also
 * the answer that never promotes a watch past one being polled ahead of it.
 * `collidesWith` lets the form say so before the reader presses Save, because
 * a row disappearing is not something to discover afterwards.
 *
 * **Changing the pair strands an archive and destroys nothing.** History is
 * keyed by `route_stem(origin, destination)`, which the booking-horizon curve
 * shares, so the new pair reads a different file and its charts start empty.
 * Every snapshot, baseline and heartbeat the old pair collected stays on disk
 * and comes back whole if that pair is watched again — the same promise
 * dropping a month makes. It is a warning for the form to give rather than a
 * refusal for this function to make: a watchlist edit is a write to the
 * reader's own document, and must not be vetoed by facts about a server.
 */
export function editRoute(document: FareRoutes, id: string, next: FareRoute): FareRoutes {
  const normalized = normalizeFareRoutes({ routes: [next] }).routes[0];
  if (!normalized) return document;

  const index = document.routes.findIndex((route) => routeId(route) === id);
  if (index < 0) return document;

  const nextId = routeId(normalized);
  const collision = document.routes.findIndex(
    (route, at) => at !== index && routeId(route) === nextId,
  );

  if (collision < 0) {
    const held = document.routes[index];
    if (
      held.origin === normalized.origin &&
      held.destination === normalized.destination &&
      held.currency === normalized.currency &&
      sameMonths(held.months, normalized.months)
    ) {
      return document;
    }
    const routes = [...document.routes];
    routes[index] = normalized;
    return { ...document, routes };
  }

  // Both removed indices are at or after `survivor`, so what precedes it is
  // untouched by the filter and the splice lands where the earlier row sat.
  const survivor = Math.min(index, collision);
  const other = document.routes[collision];
  const routes = document.routes.filter((_, at) => at !== index && at !== collision);
  routes.splice(survivor, 0, {
    origin: normalized.origin,
    destination: normalized.destination,
    months: sortedMonths([...normalized.months, ...other.months]),
    currency: survivor === index ? normalized.currency : other.currency,
  });
  return { ...document, routes };
}

/**
 * The watch this edit would merge into, or `null` if it would merge into none.
 *
 * One rule with two readers: the form asks so it can warn, `editRoute` asks so
 * it can act, and neither gets to have its own idea of what a collision is.
 */
export function collidesWith(document: FareRoutes, id: string, next: FareRoute): FareRoute | null {
  const normalized = normalizeFareRoutes({ routes: [next] }).routes[0];
  if (!normalized) return null;

  const nextId = routeId(normalized);
  if (nextId === id) return null;
  return document.routes.find((route) => routeId(route) === nextId) ?? null;
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
 *
 * A drag moves every month of a pair at once, which is what that argument
 * wanted all along: a pair's months are collected together, in one pass, so
 * they are one thing to prioritise rather than several that could be
 * interleaved with somebody else's.
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

/**
 * Stop watching a city pair — and every month of it.
 *
 * Worth stating now that a row draws its months as chips: Remove takes the
 * whole watch, not the month the reader happens to be reading. Dropping one
 * month is `editRoute`'s job, done in the strip where all twelve are visible,
 * and keeping this control unambiguous is worth more than the symmetry.
 *
 * The archive is untouched, as ever. What was collected for the pair stays on
 * disk and comes back whole if it is watched again.
 */
export function removeRoute(document: FareRoutes, id: string): FareRoutes {
  const routes = document.routes.filter((route) => routeId(route) !== id);
  return routes.length === document.routes.length ? document : { ...document, routes };
}

/**
 * Whether this route has been and gone — which it has only when **every** one
 * of its months has.
 *
 * Its one caller does two things with the answer: it prints "Departed", and it
 * withholds the collect control altogether. A watch holding one stale month
 * beside two live ones has real work a press can do, so hiding the control
 * would take it away from a watch that is very much alive, and the word beside
 * a route whose March is still coming would simply be false. Written as
 * `every(monthHasDeparted)` rather than as a comparison against the last month
 * so that the whole-route answer is stated in terms of the per-month one and
 * the two cannot drift apart.
 *
 * Nothing may ask a provider about a flight that has left: it answers nothing,
 * the route reports a failure every day forever, and the failure is noise
 * rather than news. A month is over when the calendar has moved past it, which
 * is a string comparison against today's own month. The days *inside* the
 * current month that have already gone are the collector's business, not this
 * one's — it skips them one at a time and says why, which only the side that
 * expands the month can do.
 *
 * A departed route stays in the document: the history already collected is
 * still worth reading, and the row that draws it says "Departed" and offers no
 * press rather than disappearing.
 *
 * This was `collectableRoutes`, which filtered a whole document and existed for
 * the page-wide collect button. That button is gone, and the one caller left
 * asks about a single row — so the rule is a predicate now rather than a filter
 * whose only remaining reader would have been a test.
 */
export function hasDeparted(route: FareRoute, today: string): boolean {
  return route.months.every((month) => monthHasDeparted(month, today));
}

/** Whether one month has been and gone. The whole-route answer is built on it. */
export function monthHasDeparted(month: string, today: string): boolean {
  return month < monthOf(today);
}

/**
 * The months of this watch a pass could still collect, ascending.
 *
 * What a press sends. A departed month is left out — not because the server
 * would mishandle it, it answers `departed` per day and says so, but because a
 * month that has wholly gone buys thirty-one skip lines that push the reasons
 * a reader needs out of the commonest-first summary the row prints. The
 * collector's day-level `departed` skips inside the *current* month are
 * untouched, and `hasDeparted` above says why they have to be: only the side
 * that expands a month can name the days of it that have gone.
 */
export function collectableMonthsOf(route: FareRoute, today: string): string[] {
  // Sorted rather than assumed sorted. The stored shape always is — the
  // normalizer sees to that — but this builds a request, and the order it goes
  // out in is the order a truncated pass keeps (12.111, nearest first). A
  // promise the caller has to have kept for it is not a promise.
  return sortedMonths(route.months.filter((month) => !monthHasDeparted(month, today)));
}

/**
 * Every month with a collectable departure in it, ascending — what the chip
 * strip offers.
 *
 * `collectableYears`' argument (12.263) one level down: derived from the
 * horizon rather than typed, because twelve written down is right until the
 * calendar moves and then silently wrong in the one control whose job is to
 * stop a reader naming a month nobody can collect.
 *
 * It is **eleven** months for part of the year and twelve for the rest — 330
 * days from a January date lands in November of the same year — and that is
 * correct rather than a shortfall. Worth saying plainly, because "twelve
 * chips" invites a literal twelve.
 */
export function collectableMonths(today: string): string[] {
  const first = monthOf(today);
  const last = lastCollectableMonth(today);
  const months: string[] = [];
  for (let month = first; month <= last; month = nextMonth(`${month}-01`)) months.push(month);
  return months;
}

/**
 * The month a watch opens on when the reader has not chosen one.
 *
 * The earliest month that has not departed, falling back to the last month
 * when every one of them has. A watch opens on what the reader is about to
 * buy: `months[0]` is the earliest full stop, which after a few months of
 * watching is a month that has gone and whose series has stopped — a live
 * watch opening on a dead chart. The fallback keeps a wholly departed route
 * showing its most recent archive rather than its oldest.
 *
 * A **seed and not a setting** — `useRouteView` only ever seeds a key it has
 * no record for, so a reader who opens April, walks to another watch and comes
 * back is still on April. Same half of `a-watch-opens-on-its-own-month` that
 * already holds for granularity.
 */
export function openingMonth(route: FareRoute, today: string): string {
  return (
    route.months.find((month) => !monthHasDeparted(month, today)) ??
    route.months[route.months.length - 1]
  );
}

/**
 * Which month of this watch is actually being read, given what the session
 * remembers.
 *
 * The held month wins while the route still holds it; otherwise the watch
 * opens where `openingMonth` says. Resolved when the value is *read* rather
 * than by writing a correction into the record: a stale entry is harmless
 * because it is only honoured while it is valid, an effect that patched the
 * record would have to decide every render whether what it is looking at is
 * the reader's choice or its own seed, and leaving it be means that re-adding
 * a month the reader dropped puts them back on the tab they were on.
 */
export function readingMonth(route: FareRoute, held: string | null, today: string): string {
  return held !== null && route.months.includes(held) ? held : openingMonth(route, today);
}

/**
 * How many board requests watching these months would put on one pass.
 *
 * One request per departure day, counting only the days a provider will answer
 * about: not the days of the current month that have gone, and not the days
 * past the booking horizon. The booking-horizon curve is deliberately outside
 * this figure — a curve covers every month of a pair in one observation, so it
 * costs the same whatever is ticked, and folding it in would move the number
 * for a reason the chips did not cause.
 *
 * It is a **ceiling**, and whatever quotes it should say so: the collector
 * also declines the days whose cadence is not up, which on a settled watch is
 * most of them. `Date` appears for the reason `lastCollectableDay` gives — a
 * day count is the one thing that cannot be done by slicing — and is built and
 * read entirely through `Date.UTC` and `getUTC*`.
 */
export function plannedRequests(months: readonly string[], today: string): number {
  if (!isCalendarDate(today)) return 0;
  const last = lastCollectableDay(today);

  let requests = 0;
  for (const month of months) {
    if (!isMonth(month)) continue;
    const year = Number(month.slice(0, 4));
    const ordinal = Number(month.slice(5, 7));
    const days = new Date(Date.UTC(year, ordinal, 0)).getUTCDate();
    for (let day = 1; day <= days; day += 1) {
      const departure = `${month}-${String(day).padStart(2, '0')}`;
      if (departure >= today && departure <= last) requests += 1;
    }
  }
  return requests;
}

/**
 * Watched months, written for a reader.
 *
 * One month is `formatFlightMonth` unchanged. Several state the **count** as
 * well as the two ends, because the ends alone would lie about a set with a
 * gap in it: `2 months, March 2027 to July 2027` claims no April, where
 * `March 2027 to July 2027` claims all five.
 */
export function formatFlightMonths(months: readonly string[]): string {
  if (months.length === 0) return '';
  if (months.length === 1) return formatFlightMonth(months[0]);
  const first = formatFlightMonth(months[0]);
  const last = formatFlightMonth(months[months.length - 1]);
  return `${months.length} months, ${first} to ${last}`;
}
