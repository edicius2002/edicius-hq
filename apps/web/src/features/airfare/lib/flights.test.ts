import { describe, expect, it } from 'vitest';

import { changesBetween, flightKey, trackFlights, variation } from '@/features/airfare/lib/flights';
import type { FareOffer, FareSnapshot } from '@/shared/api/fares';

function offer(overrides: Partial<FareOffer> = {}): FareOffer {
  return {
    airline: 'JA',
    airlineName: 'JetSMART',
    flightNumber: '7029',
    departureAt: '2026-10-17T19:55',
    arrivalAt: null,
    transfers: 0,
    durationMinutes: 80,
    price: 59.82,
    currency: 'USD',
    ...overrides,
  };
}

function snapshot(capturedAt: string, offers: FareOffer[]): FareSnapshot {
  return {
    capturedAt,
    source: 'google-flights',
    origin: 'LIM',
    destination: 'CUZ',
    flightDate: '2026-10-17',
    returnDate: null,
    currency: 'USD',
    insights: null,
    offers,
  };
}

describe('flightKey', () => {
  it('tells two departures of the same carrier apart', () => {
    expect(flightKey(offer())).not.toBe(flightKey(offer({ departureAt: '2026-10-17T06:00' })));
  });

  it('survives a missing flight number rather than collapsing every such flight into one', () => {
    expect(flightKey(offer({ flightNumber: null }))).toBe('JA||2026-10-17T19:55');
  });
});

describe('trackFlights', () => {
  it('follows one flight across observations', () => {
    const tracks = trackFlights([
      snapshot('2026-08-18T04:00:00+00:00', [offer({ price: 96 })]),
      snapshot('2026-08-18T16:00:00+00:00', [offer({ price: 87 })]),
    ]);

    expect(tracks).toHaveLength(1);
    expect(tracks[0].price).toBe(87);
    expect(tracks[0].previousPrice).toBe(96);
    expect(tracks[0].firstPrice).toBe(96);
  });

  it('does not record a price that did not move as a new observation', () => {
    // Four of five real snapshots were identical to the one before. Counting
    // those would make "moved twice" and "looked at twice" the same number.
    const tracks = trackFlights([
      snapshot('2026-08-18T04:00:00+00:00', [offer({ price: 96 })]),
      snapshot('2026-08-18T04:30:00+00:00', [offer({ price: 96 })]),
      snapshot('2026-08-18T05:00:00+00:00', [offer({ price: 96 })]),
    ]);

    expect(tracks[0].observations).toHaveLength(1);
    expect(tracks[0].previousPrice).toBeNull();
  });

  it('keeps a flight that has left the board, marked absent', () => {
    // A flight that disappeared is a fact about the route. Dropping it would
    // make the board look like it never held one.
    const tracks = trackFlights([
      snapshot('2026-08-18T04:00:00+00:00', [offer(), offer({ flightNumber: '7031', price: 120 })]),
      snapshot('2026-08-18T16:00:00+00:00', [offer()]),
    ]);

    const gone = tracks.find((track) => track.flightNumber === '7031');
    expect(gone?.present).toBe(false);
    expect(tracks[0].present).toBe(true);
  });

  it('orders the flights still on the board before the ones that left', () => {
    const tracks = trackFlights([
      snapshot('2026-08-18T04:00:00+00:00', [
        offer({ flightNumber: '1', departureAt: '2026-10-17T23:00' }),
        offer({ flightNumber: '2', departureAt: '2026-10-17T06:00' }),
      ]),
      snapshot('2026-08-18T16:00:00+00:00', [
        offer({ flightNumber: '1', departureAt: '2026-10-17T23:00' }),
      ]),
    ]);

    expect(tracks.map((track) => track.flightNumber)).toEqual(['1', '2']);
  });
});

describe('variation', () => {
  it('reads a real move as a percentage', () => {
    expect(variation(96, 87)).toBeCloseTo(-9.375);
    expect(variation(200, 227)).toBeCloseTo(13.5);
  });

  it('is null when there is nothing to compare against', () => {
    // Not zero: "did not move" and "seen once" are different facts, and 0%
    // would claim a stability nobody observed.
    expect(variation(null, 87)).toBeNull();
    expect(variation(0, 87)).toBeNull();
  });
});

describe('changesBetween', () => {
  const before = snapshot('2026-08-18T04:00:00+00:00', [
    offer({ flightNumber: '7037', price: 96 }),
    offer({ flightNumber: '2266', price: 128 }),
    offer({ flightNumber: '2120', price: 200 }),
  ]);
  const after = snapshot('2026-08-18T16:00:00+00:00', [
    offer({ flightNumber: '7037', price: 87 }),
    offer({ flightNumber: '2266', price: 148 }),
    offer({ flightNumber: '9999', price: 310 }),
  ]);

  it('reports what moved, what appeared and what left', () => {
    const changes = changesBetween([before, after]);
    const kinds = Object.fromEntries(
      changes.map((change) => [change.track.flightNumber, change.kind]),
    );

    expect(kinds).toEqual({
      '7037': 'moved',
      '2266': 'moved',
      '9999': 'appeared',
      '2120': 'left',
    });
  });

  it('puts the biggest move first', () => {
    // On a board of thirty flights the eye should land on the one that
    // jumped, not on whichever carrier sorts first.
    const changes = changesBetween([before, after]).filter((change) => change.kind === 'moved');
    expect(changes[0].track.flightNumber).toBe('2266'); // +15.6% beats -9.4%
  });

  it('says nothing when there is only one observation', () => {
    expect(changesBetween([before])).toEqual([]);
    expect(changesBetween([])).toEqual([]);
  });

  it('reads the two most recent observations, whatever order they arrived in', () => {
    const changes = changesBetween([after, before]);
    expect(changes.some((change) => change.kind === 'appeared')).toBe(true);
  });
});
