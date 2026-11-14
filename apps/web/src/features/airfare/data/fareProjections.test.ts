import { describe, expect, it } from 'vitest';

import { parseFareMonthProjection, parseFareFlightPage } from './fareProjections';

describe('Airfare projection decoding', () => {
  it('keeps valid adjacent departures current while a confirmed empty date stays historical', () => {
    const board = (flightDate: string) => ({
      capturedAt: '2026-09-20T10:00:00Z',
      source: 'test',
      origin: 'AQP',
      destination: 'LIM',
      flightDate,
      returnDate: null,
      currency: 'USD',
      insights: null,
      offers: [],
    });
    const valid = board('2026-11-09');
    const empty = board('2026-11-10');
    const projection = parseFareMonthProjection(
      {
        origin: 'AQP',
        destination: 'LIM',
        month: '2026-11',
        revision: '2',
        latestCapture: valid.capturedAt,
        priceDays: [],
        providerDays: [],
        unsoldDays: [],
        latestBoards: [valid, empty],
        currentBoards: [valid],
        departureChecks: [
          {
            flightDate: '2026-11-09',
            checkedAt: '2026-09-20T11:00:00Z',
            outcome: 'changed',
            lastAttemptAt: '2026-09-20T11:00:00Z',
            lastErrorCode: null,
          },
          {
            flightDate: '2026-11-10',
            checkedAt: '2026-09-20T12:00:00Z',
            outcome: 'no-offers',
            lastAttemptAt: '2026-09-20T13:00:00Z',
            lastErrorCode: 'parse-drift',
          },
        ],
        viaSequences: [],
        health: { lastCheckedAt: '2026-09-20T13:00:00Z', checks: 3, changes: 1, errors: 1 },
        pairReference: null,
      },
      'AQP',
      'LIM',
      '2026-11',
    );
    expect(projection.currentBoards).toEqual([valid]);
    expect(projection.retention).toBeUndefined();
    expect(projection.latestBoards).toEqual([valid, empty]);
    expect(projection.departureChecks[1]).toMatchObject({
      outcome: 'no-offers',
      lastErrorCode: 'parse-drift',
    });
  });

  it('turns persisted daily buckets and last boards into the current chart inputs', () => {
    const board = {
      capturedAt: '2026-09-20T10:00:00Z',
      source: 'test',
      origin: 'AQP',
      destination: 'LIM',
      flightDate: '2026-11-09',
      returnDate: null,
      currency: 'USD',
      insights: null,
      offers: [],
    };
    const result = parseFareMonthProjection(
      {
        origin: 'AQP',
        destination: 'LIM',
        month: '2026-11',
        revision: '1',
        latestCapture: board.capturedAt,
        priceDays: [{ key: '2026-09-20', low: 100, high: 200, middle: 150, count: 2 }],
        providerDays: [{ key: '2026-09-20', low: 90, high: 90, middle: 90, count: 1 }],
        unsoldDays: [{ key: '2026-09-21', count: 1 }],
        latestBoards: [],
        viaSequences: [['LIM']],
        health: { lastCheckedAt: null, checks: 1, changes: 0, errors: 0 },
        pairReference: { value: 120, dates: 3 },
        retention: { cutoff: '2026-11-10', detailExpired: true },
      },
      'AQP',
      'LIM',
      '2026-11',
    );

    expect(result.priceDays[0]).toEqual({
      key: '2026-09-20',
      label: '09-20',
      low: 100,
      high: 200,
      middle: 150,
      count: 2,
    });
    expect(result.retention).toEqual({ cutoff: '2026-11-10', detailExpired: true });
    expect(result.providerDays[0].middle).toBe(90);
    expect(result.unsoldDays[0]).toEqual({ key: '2026-09-21', label: '09-21', count: 1 });
    expect(result.latestBoards).toEqual([]);
    expect(result.currentBoards).toEqual([]);
    expect(result.departureChecks).toEqual([]);
    expect(result.viaSequences).toEqual([['LIM']]);
  });

  it('rejects a projection for another route instead of showing the wrong board', () => {
    expect(() =>
      parseFareMonthProjection(
        { origin: 'ARI', destination: 'LIM', month: '2026-11' },
        'AQP',
        'LIM',
        '2026-11',
      ),
    ).toThrow();
  });

  it('decodes a paged flight with its last distinct price and visible counts', () => {
    const result = parseFareFlightPage({
      revision: '1',
      latestCapture: '2026-09-20T10:00:00Z',
      tracked: 2,
      inPeriod: 2,
      shown: 1,
      page: 1,
      pageCount: 1,
      facets: {
        airlines: [{ value: 'AA', label: 'Alpha' }],
        price: { low: 90, high: 200 },
        bands: ['morning'],
        stops: [0],
        durations: [120],
        categories: ['fell', 'gone'],
      },
      rows: [
        {
          key: 'AA|1|2026-11-09T10:00|2026-11-09T12:00',
          offer: {
            airline: 'AA',
            airlineName: 'Alpha',
            flightNumber: '1',
            departureAt: '2026-11-09T10:00',
            arrivalAt: '2026-11-09T12:00',
            transfers: 0,
            durationMinutes: 120,
            price: 90,
            currency: 'USD',
          },
          firstPrice: 100,
          price: 90,
          previousPrice: 100,
          sightings: 2,
          lastSeenAt: '2026-09-20T10:00:00Z',
          present: true,
          category: 'fell',
          change: -10,
        },
      ],
    });
    expect(result.rows[0].track.previousPrice).toBe(100);
    expect(result.rows[0].category).toBe('fell');
    expect(result.shown).toBe(1);
  });
});
