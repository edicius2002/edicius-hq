import { describe, expect, it } from 'vitest';

import {
  addRoute,
  collectableRoutes,
  EMPTY_FARE_ROUTES,
  isCalendarDate,
  normalizeFareRoutes,
  removeRoute,
  routeId,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';

const LIM_SCL: FareRoute = {
  origin: 'LIM',
  destination: 'SCL',
  flightDate: '2026-10-16',
  returnDate: null,
  currency: 'USD',
};

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
      routes: [{ origin: 'lim', destination: 'scl', flightDate: '2026-10-16' }],
    });
    expect(routes).toEqual([LIM_SCL]);
  });

  it('drops entries it cannot repair rather than inventing a value', () => {
    const { routes } = normalizeFareRoutes({
      routes: [
        { origin: 'LIMA', destination: 'SCL', flightDate: '2026-10-16' },
        { origin: 'LIM', destination: 'LIM', flightDate: '2026-10-16' },
        { origin: 'LIM', destination: 'SCL', flightDate: 'soon' },
        { origin: 'LIM', destination: 'SCL' },
        null,
        LIM_SCL,
      ],
    });
    expect(routes).toEqual([LIM_SCL]);
  });

  it('keeps two dates for one city pair as two separate watches', () => {
    const { routes } = normalizeFareRoutes({
      routes: [LIM_SCL, { ...LIM_SCL, flightDate: '2026-12-20' }],
    });
    // The price of a city pair is not a thing; the price of a departure is.
    expect(routes).toHaveLength(2);
  });

  it('de-duplicates identical watches, which would collect the same price twice', () => {
    const { routes } = normalizeFareRoutes({ routes: [LIM_SCL, { ...LIM_SCL }] });
    expect(routes).toHaveLength(1);
  });

  it('discards a return date that falls before the departure', () => {
    const { routes } = normalizeFareRoutes({
      routes: [{ ...LIM_SCL, returnDate: '2026-10-01' }],
    });
    expect(routes[0].returnDate).toBeNull();
  });

  it('keeps a valid return date', () => {
    const { routes } = normalizeFareRoutes({
      routes: [{ ...LIM_SCL, returnDate: '2026-10-23' }],
    });
    expect(routes[0].returnDate).toBe('2026-10-23');
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

  it('refuses a route it could not repair', () => {
    expect(addRoute(EMPTY_FARE_ROUTES, { ...LIM_SCL, flightDate: 'whenever' })).toBe(
      EMPTY_FARE_ROUTES,
    );
  });

  it('removes by id and leaves the document alone when nothing matched', () => {
    const document = addRoute(EMPTY_FARE_ROUTES, LIM_SCL);
    expect(removeRoute(document, routeId(LIM_SCL)).routes).toEqual([]);
    expect(removeRoute(document, 'LIM|MAD|2026-10-16|')).toBe(document);
  });

  it('distinguishes two dates for one pair by id', () => {
    expect(routeId(LIM_SCL)).not.toBe(routeId({ ...LIM_SCL, flightDate: '2026-12-20' }));
  });
});

describe('collectableRoutes', () => {
  it('keeps today and the future, and stops asking about a flight that has left', () => {
    const document = {
      version: 1 as const,
      routes: [
        { ...LIM_SCL, flightDate: '2026-08-01' },
        { ...LIM_SCL, flightDate: '2026-08-17' },
        { ...LIM_SCL, flightDate: '2026-10-16' },
      ],
    };
    expect(collectableRoutes(document, '2026-08-17').map((r) => r.flightDate)).toEqual([
      '2026-08-17',
      '2026-10-16',
    ]);
    // The departed one stays in the document — its history is still worth
    // reading — it is simply never asked about again.
    expect(document.routes).toHaveLength(3);
  });
});
