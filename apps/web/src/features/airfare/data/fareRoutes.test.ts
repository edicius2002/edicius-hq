import { describe, expect, it } from 'vitest';

import {
  addRoute,
  collectableMonths,
  collectableMonthsOf,
  collidesWith,
  editRoute,
  formatFlightMonths,
  monthHasDeparted,
  openingMonth,
  plannedRequests,
  readingMonth,
  hasDeparted,
  collectableYears,
  EMPTY_FARE_ROUTES,
  formatFlightDate,
  formatFlightMonth,
  isCalendarDate,
  isMonth,
  lastCollectableDay,
  lastCollectableMonth,
  nextMonth,
  normalizeFareRoutes,
  removeRoute,
  reorderRoutes,
  routeId,
  type FareRoute,
  type FareRoutes,
} from '@/features/airfare/data/fareRoutes';

const LIM_SCL: FareRoute = {
  origin: 'LIM',
  destination: 'SCL',
  months: ['2026-10'],
  currency: 'USD',
};

describe('isMonth', () => {
  it('accepts a month the calendar has and rejects one it does not', () => {
    expect(isMonth('2026-10')).toBe(true);
    expect(isMonth('2026-01')).toBe(true);
    expect(isMonth('2026-12')).toBe(true);
    // Thirteen months would expand to a departure no provider can parse.
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-00')).toBe(false);
    // A whole date is not a month, and treating it as one would silently
    // truncate the day the reader typed.
    expect(isMonth('2026-10-16')).toBe(false);
    expect(isMonth('2026-3')).toBe(false);
    expect(isMonth(202610)).toBe(false);
  });
});

describe('isCalendarDate', () => {
  it('accepts a real date and rejects one that only looks like a date', () => {
    expect(isCalendarDate('2026-10-16')).toBe(true);
    // A day the calendar does not have is a typo, and defaulting it would send
    // a request for a flight nobody asked about.
    expect(isCalendarDate('2026-02-31')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('16-10-2026')).toBe(false);
    expect(isCalendarDate(20261016)).toBe(false);
  });
});

describe('normalizeFareRoutes', () => {
  it('returns an empty document for anything that is not one', () => {
    expect(normalizeFareRoutes(null)).toEqual(EMPTY_FARE_ROUTES);
    expect(normalizeFareRoutes('routes')).toEqual(EMPTY_FARE_ROUTES);
    expect(normalizeFareRoutes({ routes: 'LIM-SCL' })).toEqual(EMPTY_FARE_ROUTES);
  });

  it('upper-cases codes and fills in the default currency', () => {
    const { routes } = normalizeFareRoutes({
      routes: [{ origin: 'lim', destination: 'scl', month: '2026-10' }],
    });
    expect(routes).toEqual([LIM_SCL]);
  });

  it('repairs a route stored with a departure date into the month it falls in', () => {
    // Every entry written before 12.110 carries `flightDate`, and the month is
    // stated by that value rather than guessed. Dropping them would have
    // emptied the watchlist on the first read after the upgrade.
    const { routes } = normalizeFareRoutes({
      routes: [{ origin: 'LIM', destination: 'SCL', flightDate: '2026-10-16', returnDate: null }],
    });
    expect(routes).toEqual([LIM_SCL]);
  });

  it('drops a departure date that names no month rather than inventing one', () => {
    // `2026-02-31` is a typo, not a day, so it is not evidence of February
    // either — repairing it would be inventing.
    const { routes } = normalizeFareRoutes({
      routes: [{ origin: 'LIM', destination: 'SCL', flightDate: '2026-02-31' }],
    });
    expect(routes).toEqual([]);
  });

  it('collapses a whole month of old entries into the one watch they became', () => {
    // Three departures inside October were three watches and are now one, and
    // a reader upgrading with three of them should not find three identical
    // rows collecting October three times over.
    const { routes } = normalizeFareRoutes({
      routes: [
        { origin: 'LIM', destination: 'SCL', flightDate: '2026-10-16' },
        { origin: 'LIM', destination: 'SCL', flightDate: '2026-10-17' },
        { origin: 'LIM', destination: 'SCL', flightDate: '2026-10-30' },
      ],
    });
    expect(routes).toEqual([LIM_SCL]);
  });

  it('drops entries it cannot repair rather than inventing a value', () => {
    const { routes } = normalizeFareRoutes({
      routes: [
        { origin: 'LIMA', destination: 'SCL', month: '2026-10' },
        { origin: 'LIM', destination: 'LIM', months: ['2026-10'] },
        { origin: 'LIM', destination: 'SCL', month: 'soon' },
        { origin: 'LIM', destination: 'SCL', months: ['2026-13'] },
        { origin: 'LIM', destination: 'SCL' },
        null,
        LIM_SCL,
      ],
    });
    expect(routes).toEqual([LIM_SCL]);
  });

  it('merges two months of one city pair into one watch', () => {
    /*
     * The inversion — `a-watch-is-a-pair-and-its-months`. This asserted the
     * opposite, and the sentence under it ("the price of a city pair is not a
     * thing; the price of a month of it is") is still true and is not what was
     * wrong. What was wrong was making the unit of *reading* the unit of
     * *identity*: two months of one pair are two things to read and one thing
     * to watch, and the document is the watch.
     */
    const { routes } = normalizeFareRoutes({
      routes: [LIM_SCL, { ...LIM_SCL, months: ['2026-12'] }],
    });
    expect(routes).toEqual([{ ...LIM_SCL, months: ['2026-10', '2026-12'] }]);
  });

  it('gives a merged route the position of the first entry for its pair', () => {
    /*
     * Order is not decoration: the collector spends its budget down the list. A
     * later duplicate is a row the reader never promoted, so folding it in must
     * not move the row that holds the place.
     */
    const { routes } = normalizeFareRoutes({
      routes: [
        LIM_SCL,
        { ...LIM_SCL, destination: 'MAD' },
        { ...LIM_SCL, months: ['2026-12'], currency: 'PEN' },
      ],
    });
    expect(routes.map((route) => route.destination)).toEqual(['SCL', 'MAD']);
    expect(routes[0].months).toEqual(['2026-10', '2026-12']);
    // And the currency comes from the entry that held the place, because a
    // currency is a property of the pair and one row cannot honour two.
    expect(routes[0].currency).toBe('USD');
  });

  it('sorts months ascending however the document listed them', () => {
    const { routes } = normalizeFareRoutes({
      routes: [{ ...LIM_SCL, months: ['2026-12', '2026-10', '2026-11'] }],
    });
    expect(routes[0].months).toEqual(['2026-10', '2026-11', '2026-12']);
  });

  it('reads every month an entry states, in all three shapes at once', () => {
    /*
     * A union rather than a fallback chain, and the departure from the focus
     * migration's idiom is deliberate: there one key superseded another, here
     * they are the same fact written by two generations of this app and a
     * hand-edited document can carry both.
     */
    const { routes } = normalizeFareRoutes({
      routes: [
        {
          origin: 'LIM',
          destination: 'SCL',
          months: ['2026-12'],
          month: '2026-10',
          flightDate: '2026-11-17',
          currency: 'USD',
        },
      ],
    });
    expect(routes[0].months).toEqual(['2026-10', '2026-11', '2026-12']);
  });

  it('keeps the readable months of an entry and drops only the rest', () => {
    const { routes } = normalizeFareRoutes({
      routes: [{ ...LIM_SCL, months: ['2026-10', 'soon', '2026-13'] }],
    });
    expect(routes[0].months).toEqual(['2026-10']);
  });

  it('falls back to the older keys when `months` is not a list', () => {
    const { routes } = normalizeFareRoutes({
      routes: [{ origin: 'LIM', destination: 'SCL', months: 'March', month: '2026-10' }],
    });
    expect(routes[0].months).toEqual(['2026-10']);
  });

  it('normalizing twice is normalizing once', () => {
    /*
     * Load-bearing rather than tidy: `useStoredDocument` normalizes on read
     * *and again inside `edit`*, so a merge that was not idempotent would give
     * a different document to the writer than to the reader.
     */
    const stored = {
      routes: [LIM_SCL, { ...LIM_SCL, months: ['2026-12'] }, { ...LIM_SCL, destination: 'MAD' }],
    };
    const once = normalizeFareRoutes(stored);
    expect(normalizeFareRoutes(once)).toEqual(once);
  });

  it('de-duplicates identical watches, which would collect the same month twice', () => {
    const { routes } = normalizeFareRoutes({ routes: [LIM_SCL, { ...LIM_SCL }] });
    expect(routes).toHaveLength(1);
  });

  it('carries no return leg through, however the stored entry spelled one', () => {
    // 12.113: a month of departures has no single return date to share, so a
    // stored one is not repaired into anything — it is simply not part of a
    // watch any more.
    const { routes } = normalizeFareRoutes({
      routes: [{ ...LIM_SCL, returnDate: '2026-10-23' }],
    });
    expect(routes).toEqual([LIM_SCL]);
  });
});

describe('route transitions', () => {
  it('adds a route and normalizes it on the way in', () => {
    const next = addRoute(EMPTY_FARE_ROUTES, { ...LIM_SCL, origin: 'lim' });
    expect(next.routes).toEqual([LIM_SCL]);
  });

  it('adding one that is already watched is a no-op, not a move', () => {
    const once = addRoute(EMPTY_FARE_ROUTES, LIM_SCL);
    expect(addRoute(once, LIM_SCL)).toBe(once);
  });

  it('adding a month to a pair already watched merges it without moving the row', () => {
    /*
     * Under the old identity this built a second row. Under this one it is a
     * second month for a watch that exists, and a no-op would swallow the
     * request with no row anywhere to show for it. Asserted against a two-route
     * document because the failure worth catching is the row jumping to the end
     * of a list whose order the collector spends its budget down.
     */
    const document = addRoute(addRoute(EMPTY_FARE_ROUTES, LIM_SCL), {
      ...LIM_SCL,
      destination: 'MAD',
    });
    const next = addRoute(document, { ...LIM_SCL, months: ['2026-12'] });
    expect(next.routes.map((route) => route.destination)).toEqual(['SCL', 'MAD']);
    expect(next.routes[0].months).toEqual(['2026-10', '2026-12']);
  });

  it('re-adding a watched route changes nothing at all, not even its place', () => {
    /*
     * It used to carry a focus date over, which was the one thing re-adding
     * could still change; with the focus gone (12.260) an identical watch is
     * an identical watch. Asserted against a two-route document because the
     * failure worth catching is the route jumping to the end of a list whose
     * order the collector spends its budget down.
     */
    const document = addRoute(addRoute(EMPTY_FARE_ROUTES, LIM_SCL), {
      ...LIM_SCL,
      destination: 'MAD',
    });
    expect(addRoute(document, LIM_SCL)).toBe(document);
    expect(document.routes.map((route) => route.destination)).toEqual(['SCL', 'MAD']);
  });

  it('refuses a route it could not repair', () => {
    expect(addRoute(EMPTY_FARE_ROUTES, { ...LIM_SCL, months: ['whenever'] })).toBe(
      EMPTY_FARE_ROUTES,
    );
  });

  it('removes by id and leaves the document alone when nothing matched', () => {
    const document = addRoute(EMPTY_FARE_ROUTES, LIM_SCL);
    expect(removeRoute(document, routeId(LIM_SCL)).routes).toEqual([]);
    expect(removeRoute(document, 'LIM|MAD')).toBe(document);
  });

  it('gives two months of one pair the same id, because they are one watch', () => {
    // The inversion, at the identity itself. It asserted `not.toBe`.
    expect(routeId(LIM_SCL)).toBe(routeId({ origin: 'LIM', destination: 'SCL' }));
    expect(routeId(LIM_SCL)).toBe('LIM|SCL');
  });
});

describe('a stored focus date', () => {
  /*
   * The migration, and the only thing left of the focus — 12.261.
   *
   * Entries written while a watch could name one departure inside its month
   * are on the owner's disk right now. Every one of them carries the month
   * beside the day, so there is nothing to derive and nothing to invent: the
   * normalizer stops reading the key and the route is already its month.
   */

  it('loads as simply its month, with the route and everything else intact', () => {
    // The owner's own watchlist, as it stood when this change was written.
    const { routes } = normalizeFareRoutes({
      routes: [
        {
          origin: 'LIM',
          destination: 'SCL',
          month: '2027-03',
          focusDate: '2027-03-09',
          currency: 'USD',
        },
      ],
    });
    expect(routes).toEqual([
      { origin: 'LIM', destination: 'SCL', months: ['2027-03'], currency: 'USD' },
    ]);
    // Asserted on the keys as well, because `toEqual` ignores an undefined
    // property: a `focusDate: undefined` left behind would be written back
    // into the stored document and come back as a key on the next read.
    expect(Object.keys(routes[0])).not.toContain('focusDate');
  });

  it('is not pinned to the first of the month, which would hide the other thirty', () => {
    /*
     * The tempting migration and the wrong one. `2027-03-09` names a day, and
     * a day is a legal departure key, so a month pinned to `2027-03-01` would
     * load, collect and draw — one departure, with the thirty others the watch
     * is actually on nowhere on the page. Dropping the focus means reading the
     * month, not moving the focus to a day nobody chose.
     */
    const { routes } = normalizeFareRoutes({
      routes: [{ ...LIM_SCL, focusDate: '2026-10-16' }],
    });
    expect(routes[0].months).toEqual(['2026-10']);
    expect(JSON.stringify(routes[0])).not.toContain('2026-10-01');
  });

  it('survives a day that was never inside its month, rather than going down with it', () => {
    // It could not be stored — the normalizer dropped it on read even when the
    // focus existed (12.132) — but a hand-edited document can hold anything,
    // and a route is not worth losing over a key nothing reads.
    const { routes } = normalizeFareRoutes({
      routes: [
        { ...LIM_SCL, focusDate: '2026-11-16' },
        { ...LIM_SCL, months: ['2026-12'], focusDate: 'nonsense' },
        { ...LIM_SCL, months: ['2027-01'], focusDate: 41 },
      ],
    });
    // One watch now rather than three, because they are one city pair —
    // `a-watch-is-a-pair-and-its-months`. What this test is about is unchanged:
    // an unreadable focus is a key nothing reads, and no route is lost over one.
    expect(routes).toEqual([{ ...LIM_SCL, months: ['2026-10', '2026-12', '2027-01'] }]);
  });

  it('two entries for one month collapse to one, as they always did', () => {
    // `routeId` never included the focus, so this is unchanged — but two
    // stored entries differing only by a dead key must not survive as two
    // watches collecting the same thirty-one departures twice.
    const { routes } = normalizeFareRoutes({
      routes: [
        { ...LIM_SCL, focusDate: '2026-10-16' },
        { ...LIM_SCL, focusDate: '2026-10-28' },
      ],
    });
    expect(routes).toEqual([LIM_SCL]);
  });

  it('loads a route stored before any of it existed, untouched', () => {
    /*
     * The pre-12.110 shape, which has a `flightDate` and no month at all. The
     * month that date falls in is not a guess — the value states it — and it
     * is still the only thing taken from it. This function takes no clock and
     * writes nothing back by itself (12.133), so a stored document keeps its
     * dead `focusDate` until the reader's next edit rewrites it, and every
     * read in between produces the same month.
     */
    const { routes } = normalizeFareRoutes({
      routes: [
        { origin: 'LIM', destination: 'SCL', months: ['2026-10'], currency: 'USD' },
        { origin: 'LIM', destination: 'MAD', flightDate: '2026-10-16' },
      ],
    });
    expect(routes).toEqual([
      { origin: 'LIM', destination: 'SCL', months: ['2026-10'], currency: 'USD' },
      { origin: 'LIM', destination: 'MAD', months: ['2026-10'], currency: 'USD' },
    ]);
  });
});

describe('nextMonth', () => {
  it('is the month after this one, which is what the add form opens on', () => {
    expect(nextMonth('2026-08-19')).toBe('2026-09');
    expect(nextMonth('2026-08-31')).toBe('2026-09');
  });

  it('rolls the year in December, so the two dropdowns move together', () => {
    // The case the form cannot get wrong quietly: a month that rolled while
    // its year stayed behind would put the reader eleven months in the past.
    expect(nextMonth('2026-12-01')).toBe('2027-01');
    expect(nextMonth('2026-12-31')).toBe('2027-01');
  });
});

describe('the collectable window the form offers', () => {
  it('runs to the month the horizon lands in, part of a month being enough', () => {
    // 330 days past 2026-08-19 is 2027-07-15. July is half collectable and is
    // on offer: the collector polls the days it can reach and reports the rest
    // as `beyond-horizon` by name, exactly as it does for the days of this
    // month that have gone.
    expect(lastCollectableDay('2026-08-19')).toBe('2027-07-15');
    expect(lastCollectableMonth('2026-08-19')).toBe('2027-07');
  });

  it('offers the two years the window spans, rather than two years written down', () => {
    // 12.263. `[2026, 2027]` today, and the point is where it comes from: a
    // literal pair would be right until 2027 and silently wrong after it.
    expect(collectableYears('2026-08-19')).toEqual([2026, 2027]);
    expect(collectableYears('2027-03-01')).toEqual([2027, 2028]);
  });

  it('offers one year in January, because 330 days from January stays inside it', () => {
    // Not a shortfall — the list is whatever the window spans, and from
    // 2026-01-05 the horizon ends 2026-12-01.
    expect(lastCollectableMonth('2026-01-05')).toBe('2026-12');
    expect(collectableYears('2026-01-05')).toEqual([2026]);
  });

  it('starts at this year, so the month the reader is standing in can be watched', () => {
    // Its remaining days are collectable, and the default is next month rather
    // than a refusal to name this one.
    expect(collectableYears('2026-12-15')).toEqual([2026, 2027]);
  });
});

describe('lastCollectableDay', () => {
  it('lands 330 days ahead, rolling the month and the year on the way', () => {
    // The horizon the API measured: +330 returned itineraries and +340 did
    // not. 2026-08-19 plus 330 days is 2027-07-15, which crosses eleven month
    // boundaries and one year end.
    expect(lastCollectableDay('2026-08-19')).toBe('2027-07-15');
  });

  it('counts through a leap day rather than around it', () => {
    // 2027-04-05 plus 330 days lands in 2028, whose February has 29 days —
    // the arithmetic is a day count, so nothing has to remember that.
    expect(lastCollectableDay('2027-04-05')).toBe('2028-02-29');
  });

  it('reads the same day in Lima as it does in UTC', () => {
    // The whole reason `Date.UTC` and `getUTC*` are paired: built and read in
    // the same frame, the answer cannot be shifted by the reader's zone. A
    // date one day short of a month end is where a west-of-Greenwich slip
    // would show.
    expect(lastCollectableDay('2026-01-01')).toBe('2026-11-27');
  });

  it('hands back anything that is not a date, untouched', () => {
    expect(lastCollectableDay('whenever')).toBe('whenever');
  });
});

describe('hasDeparted', () => {
  it('counts a route as departed only once every month of it has gone', () => {
    /*
     * The whole-route answer is built from the per-month one, and this is why:
     * its one caller prints "Departed" *and withholds the collect control*. A
     * watch with one stale month beside two live ones has real work a press can
     * do, and the word beside a route whose October is still coming is false.
     */
    expect(hasDeparted({ ...LIM_SCL, months: ['2026-07', '2026-10'] }, '2026-08-17')).toBe(false);
    expect(hasDeparted({ ...LIM_SCL, months: ['2026-06', '2026-07'] }, '2026-08-17')).toBe(true);
  });

  it('counts the month we are in as still to come, and every one before it as gone', () => {
    // A month is over only once the calendar has left it. The 17th of August
    // is halfway through August and August is still worth collecting — the
    // days inside it that have gone are skipped one at a time by the
    // collector, which is the only side that can say so by name.
    expect(hasDeparted({ ...LIM_SCL, months: ['2026-07'] }, '2026-08-17')).toBe(true);
    expect(hasDeparted({ ...LIM_SCL, months: ['2026-08'] }, '2026-08-17')).toBe(false);
    expect(hasDeparted({ ...LIM_SCL, months: ['2026-10'] }, '2026-08-17')).toBe(false);
  });

  it('reads the first and the last day of a month the same way', () => {
    // The comparison is on `YYYY-MM`, so nothing inside a month can move the
    // answer — which is the whole reason a row cannot decide this day by day.
    expect(hasDeparted({ ...LIM_SCL, months: ['2026-08'] }, '2026-08-01')).toBe(false);
    expect(hasDeparted({ ...LIM_SCL, months: ['2026-08'] }, '2026-08-31')).toBe(false);
    expect(hasDeparted({ ...LIM_SCL, months: ['2026-08'] }, '2026-09-01')).toBe(true);
  });
});

describe('reorderRoutes', () => {
  const LIST = normalizeFareRoutes({
    routes: [
      { origin: 'LIM', destination: 'CUZ', months: ['2026-10'] },
      { origin: 'LIM', destination: 'SCL', months: ['2026-10'] },
      { origin: 'LIM', destination: 'MAD', months: ['2026-12'] },
    ],
  });
  const ids = (document: FareRoutes) => document.routes.map(routeId);

  it('puts a route where another one sits rather than swapping them', () => {
    // A drop between rows is a request for a position. Swapping would move the
    // route that happened to be there, which nobody asked about.
    const [cuz, scl, mad] = ids(LIST);
    expect(ids(reorderRoutes(LIST, mad, cuz))).toEqual([mad, cuz, scl]);
  });

  it('moves a route down as readily as up', () => {
    const [cuz, scl, mad] = ids(LIST);
    expect(ids(reorderRoutes(LIST, cuz, mad))).toEqual([scl, mad, cuz]);
  });

  it('leaves the document alone when either end is unknown', () => {
    expect(reorderRoutes(LIST, 'nope', ids(LIST)[0])).toBe(LIST);
    expect(reorderRoutes(LIST, ids(LIST)[0], 'nope')).toBe(LIST);
  });

  it('is a no-op on a route dropped onto itself', () => {
    expect(reorderRoutes(LIST, ids(LIST)[0], ids(LIST)[0])).toBe(LIST);
  });

  it('keeps every route it was given', () => {
    const moved = reorderRoutes(LIST, ids(LIST)[2], ids(LIST)[0]);
    expect(moved.routes).toHaveLength(LIST.routes.length);
    expect(new Set(ids(moved))).toEqual(new Set(ids(LIST)));
  });
});

describe('formatFlightDate', () => {
  it('writes a stored date the way this reader writes one', () => {
    expect(formatFlightDate('2026-10-17')).toBe('17/10/2026');
  });

  it('does not go through a Date, which would move the day west of Greenwich', () => {
    /*
     * `new Date('2026-01-01')` is midnight UTC, and rendering that in Lima —
     * the default origin of this whole feature — shows the 31st of December.
     * A string split cannot make that mistake.
     */
    expect(formatFlightDate('2026-01-01')).toBe('01/01/2026');
    expect(formatFlightDate('2026-12-31')).toBe('31/12/2026');
  });

  it('hands back anything that is not a plain calendar date, untouched', () => {
    // A date the reader can see and puzzle over beats a silent blank.
    for (const odd of ['', 'tomorrow', '2026-13-40x', '17/10/2026']) {
      expect(formatFlightDate(odd)).toBe(odd);
    }
  });
});

describe('formatFlightMonth', () => {
  it('names the month rather than numbering it, so it cannot be read as a day', () => {
    // 12.114: `03/2027` sits inside this page's own `dd/mm/yyyy` pattern well
    // enough that a reader has to work out which half is which. A name cannot.
    expect(formatFlightMonth('2027-03')).toBe('March 2027');
    expect(formatFlightMonth('2026-01')).toBe('January 2026');
    expect(formatFlightMonth('2026-12')).toBe('December 2026');
  });

  it('does not go through a Date, which would move the month west of Greenwich', () => {
    // `new Date('2026-01')` is midnight UTC on the 1st, and reading the month
    // back in Lima gives December — the same trap `formatFlightDate` avoids.
    expect(formatFlightMonth('2026-01')).toBe('January 2026');
  });

  it('hands back anything that is not a plain month, untouched', () => {
    for (const odd of ['', 'soon', '2026-13', '2026-10-16']) {
      expect(formatFlightMonth(odd)).toBe(odd);
    }
  });
});

describe('editRoute', () => {
  const THREE = normalizeFareRoutes({
    routes: [
      { origin: 'LIM', destination: 'CUZ', months: ['2026-10'] },
      { origin: 'LIM', destination: 'SCL', months: ['2026-10'] },
      { origin: 'LIM', destination: 'MAD', months: ['2026-10'] },
    ],
  });
  const MIDDLE = 'LIM|SCL';

  it('changes the months of a watch and leaves it where it sits', () => {
    const next = editRoute(THREE, MIDDLE, {
      origin: 'LIM',
      destination: 'SCL',
      months: ['2026-12', '2026-10'],
      currency: 'USD',
    });
    expect(next.routes.map((route) => route.destination)).toEqual(['CUZ', 'SCL', 'MAD']);
    expect(next.routes[1].months).toEqual(['2026-10', '2026-12']);
  });

  it('changes the city pair and still leaves it where it sits', () => {
    /*
     * The whole reason this is a transition rather than `remove` then `add`:
     * that pair would send the row to the end of a list whose order the
     * collector spends its budget down, so an edit would quietly be a
     * reprioritisation nobody asked for.
     */
    const next = editRoute(THREE, MIDDLE, {
      origin: 'LIM',
      destination: 'BCN',
      months: ['2026-10'],
      currency: 'USD',
    });
    expect(next.routes.map((route) => route.destination)).toEqual(['CUZ', 'BCN', 'MAD']);
  });

  it('writes nothing when nothing differs', () => {
    const held = THREE.routes[1];
    expect(editRoute(THREE, MIDDLE, { ...held })).toBe(THREE);
  });

  it('refuses an edit that would leave the watch with no month', () => {
    // Clearing every chip is not how a watch ends — the control that ends one
    // says Remove on it — and deleting the row here would take the colour and
    // its place in the collector's order with it.
    expect(
      editRoute(THREE, MIDDLE, {
        origin: 'LIM',
        destination: 'SCL',
        months: [],
        currency: 'USD',
      }),
    ).toBe(THREE);
  });

  it('never appends when the row being edited is gone', () => {
    // The one silent write this function could make: re-creating a watch the
    // reader deleted in another tab, from a stale editor.
    expect(
      editRoute(THREE, 'LIM|NRT', {
        origin: 'LIM',
        destination: 'NRT',
        months: ['2026-10'],
        currency: 'USD',
      }),
    ).toBe(THREE);
  });

  it('merges into the earlier row when the edit collides with another watch', () => {
    // Editing the last row onto the first row's pair.
    const next = editRoute(THREE, 'LIM|MAD', {
      origin: 'LIM',
      destination: 'CUZ',
      months: ['2026-12'],
      currency: 'USD',
    });
    expect(next.routes.map((route) => route.destination)).toEqual(['CUZ', 'SCL']);
    expect(next.routes[0].months).toEqual(['2026-10', '2026-12']);
  });

  it('merges into the earlier row in the other direction too', () => {
    // Editing the first row onto the last row's pair. The survivor is still
    // the earlier index, which is where the first row already was.
    const next = editRoute(THREE, 'LIM|CUZ', {
      origin: 'LIM',
      destination: 'MAD',
      months: ['2026-12'],
      currency: 'USD',
    });
    expect(next.routes.map((route) => route.destination)).toEqual(['MAD', 'SCL']);
    expect(next.routes[0].months).toEqual(['2026-10', '2026-12']);
  });

  it('names the watch an edit would merge into, or nothing', () => {
    const held = THREE.routes[1];
    expect(collidesWith(THREE, MIDDLE, { ...held, months: ['2026-12'] })).toBeNull();
    expect(collidesWith(THREE, MIDDLE, { ...held, destination: 'BCN' })).toBeNull();
    expect(collidesWith(THREE, MIDDLE, { ...held, destination: 'MAD' })?.destination).toBe('MAD');
  });
});

describe('the months a watch can still be collected for', () => {
  const ROUTE: FareRoute = {
    origin: 'LIM',
    destination: 'SCL',
    months: ['2026-07', '2026-08', '2026-10'],
    currency: 'USD',
  };

  it('leaves out the ones that have gone', () => {
    expect(collectableMonthsOf(ROUTE, '2026-08-17')).toEqual(['2026-08', '2026-10']);
  });

  it('answers per month the same way the whole route does', () => {
    expect(monthHasDeparted('2026-07', '2026-08-17')).toBe(true);
    expect(monthHasDeparted('2026-08', '2026-08-17')).toBe(false);
  });
});

describe('collectableMonths', () => {
  it('runs from this month to the last the horizon reaches', () => {
    const months = collectableMonths('2026-08-19');
    expect(months[0]).toBe('2026-08');
    expect(months.at(-1)).toBe(lastCollectableMonth('2026-08-19'));
    expect(months).toHaveLength(12);
  });

  it('is eleven months from a January date, which is correct rather than short', () => {
    // 330 days from January lands inside the same year, so there is no twelfth
    // month to offer. Written down because "twelve chips" invites a literal.
    expect(collectableMonths('2026-01-01')).toHaveLength(11);
    expect(collectableMonths('2026-01-01').at(-1)).toBe('2026-11');
  });
});

describe('the month a watch opens on', () => {
  const ROUTE: FareRoute = {
    origin: 'LIM',
    destination: 'SCL',
    months: ['2026-07', '2026-10', '2026-12'],
    currency: 'USD',
  };

  it('is the earliest that has not departed, not simply the earliest', () => {
    // A live watch opening on a dead month would show a chart whose series
    // stopped, which is the failure `months[0]` invites.
    expect(openingMonth(ROUTE, '2026-08-17')).toBe('2026-10');
  });

  it('falls back to the last month when every one of them has gone', () => {
    expect(openingMonth(ROUTE, '2027-01-05')).toBe('2026-12');
  });

  it('honours a held month while it is still watched, and lets go when it is not', () => {
    expect(readingMonth(ROUTE, '2026-12', '2026-08-17')).toBe('2026-12');
    expect(readingMonth(ROUTE, '2026-11', '2026-08-17')).toBe('2026-10');
    expect(readingMonth(ROUTE, null, '2026-08-17')).toBe('2026-10');
  });
});

describe('plannedRequests', () => {
  it('counts every day of a whole future month', () => {
    expect(plannedRequests(['2026-10'], '2026-08-17')).toBe(31);
    expect(plannedRequests(['2026-11'], '2026-08-17')).toBe(30);
  });

  it('counts the current month only from today', () => {
    expect(plannedRequests(['2026-08'], '2026-08-17')).toBe(15);
  });

  it('stops at the horizon inside the month the horizon lands in', () => {
    const last = lastCollectableDay('2026-08-17');
    expect(plannedRequests([last.slice(0, 7)], '2026-08-17')).toBe(Number(last.slice(8, 10)));
  });

  it('counts a departed month as nothing, and sums the rest', () => {
    expect(plannedRequests(['2026-07'], '2026-08-17')).toBe(0);
    expect(plannedRequests(['2026-07', '2026-10', '2026-11'], '2026-08-17')).toBe(61);
  });
});

describe('formatFlightMonths', () => {
  it('writes one month the way one month has always been written', () => {
    expect(formatFlightMonths(['2027-03'])).toBe('March 2027');
  });

  it('states the count as well as the ends, so a gap is not claimed as a range', () => {
    // `March 2027 to July 2027` alone would claim five months; naming two is
    // what makes the sentence true of a selection with holes in it.
    expect(formatFlightMonths(['2027-03', '2027-04'])).toBe('2 months, March 2027 to April 2027');
    expect(formatFlightMonths(['2027-03', '2027-07'])).toBe('2 months, March 2027 to July 2027');
  });
});

describe('the stored watchlist this change was written against', () => {
  it('loads as one row per city pair, and the list gets shorter', () => {
    /*
     * Literal data, because this is the migration's proof: the document on
     * disk at `services/api/.local-data/kv/airfare-routes.json` when this
     * change was written. Five entries, one pair named twice.
     *
     * Five rows becoming four is the visible cost of the merge, and it is
     * asserted rather than glossed over.
     */
    const { routes } = normalizeFareRoutes({
      version: 1,
      routes: [
        { origin: 'ARI', destination: 'SCL', month: '2027-03', currency: 'USD' },
        { origin: 'SCL', destination: 'ARI', month: '2027-03', currency: 'USD' },
        { origin: 'SCL', destination: 'AEP', month: '2027-03', currency: 'USD' },
        { origin: 'AEP', destination: 'SCL', month: '2027-03', currency: 'USD' },
        { origin: 'AEP', destination: 'SCL', month: '2027-04', currency: 'USD' },
      ],
    });

    expect(routes).toEqual([
      { origin: 'ARI', destination: 'SCL', months: ['2027-03'], currency: 'USD' },
      { origin: 'SCL', destination: 'ARI', months: ['2027-03'], currency: 'USD' },
      { origin: 'SCL', destination: 'AEP', months: ['2027-03'], currency: 'USD' },
      { origin: 'AEP', destination: 'SCL', months: ['2027-03', '2027-04'], currency: 'USD' },
    ]);
  });
});
