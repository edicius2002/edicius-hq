import { describe, expect, it } from 'vitest';

import {
  addRoute,
  collectableRoutes,
  EMPTY_FARE_ROUTES,
  focusDeparted,
  formatFlightDate,
  formatFlightMonth,
  formatReading,
  isCalendarDate,
  isMonth,
  lastDayOf,
  normalizeFareRoutes,
  readingPrefix,
  removeRoute,
  reorderRoutes,
  routeId,
  setFocus,
  type FareRoute,
  type FareRoutes,
} from '@/features/airfare/data/fareRoutes';

const LIM_SCL: FareRoute = {
  origin: 'LIM',
  destination: 'SCL',
  month: '2026-10',
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
        { origin: 'LIM', destination: 'LIM', month: '2026-10' },
        { origin: 'LIM', destination: 'SCL', month: 'soon' },
        { origin: 'LIM', destination: 'SCL', month: '2026-13' },
        { origin: 'LIM', destination: 'SCL' },
        null,
        LIM_SCL,
      ],
    });
    expect(routes).toEqual([LIM_SCL]);
  });

  it('keeps two months for one city pair as two separate watches', () => {
    const { routes } = normalizeFareRoutes({
      routes: [LIM_SCL, { ...LIM_SCL, month: '2026-12' }],
    });
    // The price of a city pair is not a thing; the price of a month of it is.
    expect(routes).toHaveLength(2);
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

  it('re-adding a watched route with a day sets its focus without moving it', () => {
    // The form is the only control that names a day, so re-adding a watch you
    // already have is how a focus is put on it — and with the day left blank,
    // how it comes off again. Still not a move: it stays where it was.
    const document = addRoute(addRoute(EMPTY_FARE_ROUTES, LIM_SCL), {
      ...LIM_SCL,
      destination: 'MAD',
    });
    const focused = addRoute(document, { ...LIM_SCL, focusDate: '2026-10-16' });
    expect(focused.routes[0]).toEqual({ ...LIM_SCL, focusDate: '2026-10-16' });
    expect(focused.routes.map((route) => route.destination)).toEqual(['SCL', 'MAD']);

    const cleared = addRoute(focused, LIM_SCL);
    expect(cleared.routes[0]).toEqual(LIM_SCL);
  });

  it('refuses a route it could not repair', () => {
    expect(addRoute(EMPTY_FARE_ROUTES, { ...LIM_SCL, month: 'whenever' })).toBe(EMPTY_FARE_ROUTES);
  });

  it('removes by id and leaves the document alone when nothing matched', () => {
    const document = addRoute(EMPTY_FARE_ROUTES, LIM_SCL);
    expect(removeRoute(document, routeId(LIM_SCL)).routes).toEqual([]);
    expect(removeRoute(document, 'LIM|MAD|2026-10')).toBe(document);
  });

  it('distinguishes two months for one pair by id', () => {
    expect(routeId(LIM_SCL)).not.toBe(routeId({ ...LIM_SCL, month: '2026-12' }));
  });
});

describe('the focus date', () => {
  const FOCUSED: FareRoute = { ...LIM_SCL, focusDate: '2026-10-16' };

  it('keeps a day that falls inside the watched month', () => {
    const { routes } = normalizeFareRoutes({ routes: [FOCUSED] });
    expect(routes).toEqual([FOCUSED]);
  });

  it('drops a day outside the month and keeps the route, rather than either invention', () => {
    /*
     * 12.132. Widening the month to November would change what is collected,
     * which a reading preference is not allowed to do; moving the day into
     * October would name a departure nobody typed. The entry states two things
     * that cannot both be true and does not say which is wrong, so the weaker
     * one goes and the route survives with no focus.
     */
    const { routes } = normalizeFareRoutes({
      routes: [{ ...LIM_SCL, focusDate: '2026-11-16' }],
    });
    expect(routes).toEqual([LIM_SCL]);
  });

  it('drops a day the calendar does not have rather than repairing it', () => {
    const { routes } = normalizeFareRoutes({
      routes: [
        { ...LIM_SCL, focusDate: '2026-10-32' },
        { ...LIM_SCL, month: '2026-12', focusDate: 41 },
      ],
    });
    expect(routes).toEqual([LIM_SCL, { ...LIM_SCL, month: '2026-12' }]);
  });

  it('loads a route stored before it existed with no focus at all', () => {
    // Every entry in the store today is one of these, and none of them must
    // look broken. The `flightDate` of a pre-12.110 entry is deliberately not
    // promoted into one either: it was the only day that entry could name
    // rather than one chosen out of thirty-one, and a focus everybody has is a
    // focus nobody chose.
    const { routes } = normalizeFareRoutes({
      routes: [
        { origin: 'LIM', destination: 'SCL', month: '2026-10' },
        { origin: 'LIM', destination: 'MAD', flightDate: '2026-10-16' },
      ],
    });
    expect(routes.every((route) => route.focusDate === undefined)).toBe(true);
  });

  it('is not part of what makes two entries the same watch', () => {
    // Two entries for one month with different focuses would be two watches
    // collecting the same thirty-one departures twice.
    expect(routeId(FOCUSED)).toBe(routeId(LIM_SCL));
    expect(normalizeFareRoutes({ routes: [LIM_SCL, FOCUSED] }).routes).toHaveLength(1);
  });

  it('narrows the reading prefix onto one day, and falls back to the month', () => {
    // The whole substitution, and it works because `2026-10-16` starts with
    // `2026-10` — the same property the archive's own filters lean on.
    expect(readingPrefix(LIM_SCL)).toBe('2026-10');
    expect(readingPrefix(FOCUSED)).toBe('2026-10-16');
    expect(readingPrefix(FOCUSED).startsWith(readingPrefix(LIM_SCL))).toBe(true);
  });

  it('writes the day as a date and the month as a name, never the two alike', () => {
    expect(formatReading(LIM_SCL)).toBe('October 2026');
    expect(formatReading(FOCUSED)).toBe('16/10/2026');
  });

  it('says when the focused day has gone instead of dropping it', () => {
    // A route with no focus never has a departed one, whatever the date.
    expect(focusDeparted(FOCUSED, '2026-10-16')).toBe(false);
    expect(focusDeparted(FOCUSED, '2026-10-17')).toBe(true);
    expect(focusDeparted(LIM_SCL, '2030-01-01')).toBe(false);
  });
});

describe('setFocus', () => {
  it('points a watch at one of its own days', () => {
    const document = addRoute(EMPTY_FARE_ROUTES, LIM_SCL);
    const next = setFocus(document, routeId(LIM_SCL), '2026-10-16');
    expect(next.routes).toEqual([{ ...LIM_SCL, focusDate: '2026-10-16' }]);
  });

  it('takes a focus off again and leaves no empty key behind', () => {
    const focused = addRoute(EMPTY_FARE_ROUTES, { ...LIM_SCL, focusDate: '2026-10-16' });
    const cleared = setFocus(focused, routeId(LIM_SCL), null);
    // `toEqual` ignores an undefined property, so the key itself is checked:
    // one written into the stored document would come back on the next read.
    expect(Object.keys(cleared.routes[0])).not.toContain('focusDate');
  });

  it('refuses a day from another month rather than moving the watch to it', () => {
    const document = addRoute(EMPTY_FARE_ROUTES, LIM_SCL);
    expect(setFocus(document, routeId(LIM_SCL), '2026-11-16').routes).toEqual([LIM_SCL]);
  });

  it('leaves the document alone when nothing would change', () => {
    const document = addRoute(EMPTY_FARE_ROUTES, LIM_SCL);
    expect(setFocus(document, routeId(LIM_SCL), null)).toBe(document);
    expect(setFocus(document, 'LIM|MAD|2026-10', '2026-10-16')).toBe(document);
  });

  it('keeps the route where it was, so a focus is not a reorder', () => {
    const document = addRoute(addRoute(EMPTY_FARE_ROUTES, LIM_SCL), {
      ...LIM_SCL,
      destination: 'MAD',
    });
    const next = setFocus(document, routeId(LIM_SCL), '2026-10-16');
    expect(next.routes.map((route) => route.destination)).toEqual(['SCL', 'MAD']);
  });
});

describe('lastDayOf', () => {
  it('asks the calendar rather than a table of twelve numbers', () => {
    expect(lastDayOf('2026-10')).toBe('2026-10-31');
    expect(lastDayOf('2026-11')).toBe('2026-11-30');
    expect(lastDayOf('2026-02')).toBe('2026-02-28');
    expect(lastDayOf('2028-02')).toBe('2028-02-29');
  });

  it('hands back anything that is not a month, untouched', () => {
    expect(lastDayOf('whenever')).toBe('whenever');
  });
});

describe('collectableRoutes', () => {
  it('keeps the month we are in and every one after it', () => {
    // A month is over only once the calendar has left it. The 17th of August
    // is halfway through August and August is still worth collecting — the
    // days inside it that have gone are skipped one at a time by the
    // collector, which is the only side that can say so by name.
    const document = {
      version: 1 as const,
      routes: [
        { ...LIM_SCL, month: '2026-07' },
        { ...LIM_SCL, month: '2026-08' },
        { ...LIM_SCL, month: '2026-10' },
      ],
    };
    expect(collectableRoutes(document, '2026-08-17').map((r) => r.month)).toEqual([
      '2026-08',
      '2026-10',
    ]);
    // The finished one stays in the document — its history is still worth
    // reading — it is simply never asked about again.
    expect(document.routes).toHaveLength(3);
  });
});

describe('reorderRoutes', () => {
  const LIST = normalizeFareRoutes({
    routes: [
      { origin: 'LIM', destination: 'CUZ', month: '2026-10' },
      { origin: 'LIM', destination: 'SCL', month: '2026-10' },
      { origin: 'LIM', destination: 'MAD', month: '2026-12' },
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
