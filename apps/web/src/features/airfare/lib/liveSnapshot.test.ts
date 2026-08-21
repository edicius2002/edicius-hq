import { describe, expect, it } from 'vitest';

import { withSnapshot } from '@/features/airfare/lib/liveSnapshot';
import type { FareHistoryResponse, FareSnapshot } from '@/shared/api/fares';

function snapshot(over: Partial<FareSnapshot> = {}): FareSnapshot {
  return {
    capturedAt: '2026-08-21T14:00:03+00:00',
    source: 'google-flights',
    origin: 'LIM',
    destination: 'SCL',
    flightDate: '2027-03-09',
    returnDate: null,
    currency: 'USD',
    insights: null,
    offers: [
      {
        airline: 'LA',
        airlineName: 'LATAM',
        flightNumber: 'LA600',
        departureAt: '2027-03-09T08:00',
        arrivalAt: '2027-03-09T12:00',
        transfers: 0,
        durationMinutes: 240,
        price: 380,
        currency: 'USD',
      },
    ],
    ...over,
  };
}

function history(snapshots: FareSnapshot[]): FareHistoryResponse {
  return {
    origin: 'LIM',
    destination: 'SCL',
    snapshots,
    baseline: [{ flightDate: '2027-03-09', date: '2026-08-01', price: 410 }],
    health: { lastCheckedAt: '2026-08-21T13:00:00+00:00', checks: 12, changes: 3, errors: 0 },
    airports: [],
  };
}

describe('a snapshot pushed into the archive already fetched', () => {
  it('adds the point the reader is waiting for', () => {
    const held = history([snapshot({ capturedAt: '2026-08-21T13:00:00+00:00' })]);

    const next = withSnapshot(held, snapshot({ capturedAt: '2026-08-21T14:00:03+00:00' }));

    expect(next.snapshots).toHaveLength(2);
    expect(next.snapshots.at(-1)?.capturedAt).toBe('2026-08-21T14:00:03+00:00');
  });

  it('leaves the baseline and the health counts exactly as fetched', () => {
    /*
     * The stream carries points and deliberately nothing else. The baseline
     * moves only on the first look at a departure and `health` is a running
     * count of every poll whatever its outcome — neither is a point on a chart,
     * and both catch up from the refetch that already happens when the pass
     * ends. Inventing either here would be a second way to construct them.
     */
    const held = history([]);

    const next = withSnapshot(held, snapshot());

    expect(next.baseline).toBe(held.baseline);
    expect(next.health).toBe(held.health);
  });

  it('ignores a snapshot it is already holding, without costing a render', () => {
    // A reconnecting `EventSource` replays from its last id, so the frame after
    // a reconnect is routinely one already applied. Returning the same object
    // rather than an equal one is what stops that being a repaint.
    const landed = snapshot();
    const held = history([landed]);

    expect(withSnapshot(held, snapshot())).toBe(held);
  });

  it('keeps two departures observed in the same second', () => {
    // A pass paces itself three seconds apart, but `capturedAt` is whole
    // seconds and two looks can land inside one. `capturedAt` alone is not a
    // key, and treating it as one would silently lose a departure.
    const held = history([snapshot({ flightDate: '2027-03-09' })]);

    const next = withSnapshot(held, snapshot({ flightDate: '2027-03-10' }));

    expect(next.snapshots.map((s) => s.flightDate)).toEqual(['2027-03-09', '2027-03-10']);
  });

  it('leaves an archive that is not about this route alone', () => {
    // One pass slot serves the machine (12.210), so the stream carries whatever
    // pass is running — which can be a route this query is not about.
    const held = history([]);

    expect(withSnapshot(held, snapshot({ destination: 'CUZ' }))).toBe(held);
    expect(withSnapshot(held, snapshot({ origin: 'ARI' }))).toBe(held);
  });

  it('puts a frame that arrived late back where it belongs', () => {
    // A reconnect can deliver a frame after a later one. A series drawn from an
    // out-of-order array is a line that doubles back on itself.
    const held = history([
      snapshot({ capturedAt: '2026-08-21T13:00:00+00:00' }),
      snapshot({ capturedAt: '2026-08-21T15:00:00+00:00' }),
    ]);

    const next = withSnapshot(held, snapshot({ capturedAt: '2026-08-21T14:00:00+00:00' }));

    expect(next.snapshots.map((s) => s.capturedAt)).toEqual([
      '2026-08-21T13:00:00+00:00',
      '2026-08-21T14:00:00+00:00',
      '2026-08-21T15:00:00+00:00',
    ]);
  });

  it('is the first point where the archive was empty', () => {
    // A route watched today has no snapshots at all, and the empty chart is the
    // thing the reader is watching for something to appear in.
    const next = withSnapshot(history([]), snapshot());

    expect(next.snapshots).toHaveLength(1);
  });
});
