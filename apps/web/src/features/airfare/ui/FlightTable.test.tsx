import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { FlightTable } from '@/features/airfare/ui/FlightTable';
import { PriceHistoryChart } from '@/features/airfare/ui/PriceHistoryChart';
import type { FareSnapshot } from '@/shared/api/fares';

afterEach(cleanup);

const SNAPSHOT: FareSnapshot = {
  capturedAt: '2026-08-17T12:00:00+00:00',
  source: 'google-flights',
  origin: 'LIM',
  destination: 'SCL',
  flightDate: '2026-10-16',
  returnDate: null,
  currency: 'USD',
  offers: [
    {
      airline: 'LA',
      airlineName: 'LATAM',
      flightNumber: '529',
      departureAt: '2026-10-16T00:15',
      arrivalAt: '2026-10-16T05:50',
      transfers: 0,
      durationMinutes: 215,
      price: 125,
      currency: 'USD',
    },
    {
      airline: 'AV',
      airlineName: 'Avianca',
      flightNumber: '812',
      departureAt: '2026-10-16T17:35',
      arrivalAt: '2026-10-17T00:40',
      transfers: 1,
      durationMinutes: 425,
      price: 291,
      currency: 'USD',
    },
  ],
};

describe('FlightTable', () => {
  it('shows each itinerary with its airline, departure time and stops', () => {
    render(<FlightTable snapshot={SNAPSHOT} />);

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);

    const first = within(rows[0]);
    // Rendered as written: a 00:15 Lima departure must not be shifted into the
    // reader's own zone by a `Date` round trip.
    expect(first.getByText('00:15')).toBeInTheDocument();
    expect(first.getByText('LATAM')).toBeInTheDocument();
    expect(first.getByText('LA 529')).toBeInTheDocument();
    expect(first.getByText('Direct')).toBeInTheDocument();
    expect(first.getByText('3h 35m')).toBeInTheDocument();

    const second = within(rows[1]);
    expect(second.getByText('17:35')).toBeInTheDocument();
    expect(second.getByText('1 stop')).toBeInTheDocument();
  });

  it('says so when the latest observation is empty', () => {
    render(<FlightTable snapshot={null} />);
    expect(screen.getByText(/No itineraries/i)).toBeInTheDocument();
  });
});

describe('PriceHistoryChart', () => {
  const points = [
    { capturedAt: '2026-08-17T12:00:00+00:00', price: 125, currency: 'USD' },
    { capturedAt: '2026-08-18T12:00:00+00:00', price: 139, currency: 'USD' },
  ];

  it('describes the whole series to a screen reader, not just the shape', () => {
    render(<PriceHistoryChart points={points} currency="USD" label="LIM to SCL" />);

    const chart = screen.getByRole('img');
    expect(chart).toHaveAccessibleName(/LIM to SCL/);
    expect(chart).toHaveAccessibleName(/2026-08-17: \$125\.00/);
    expect(chart).toHaveAccessibleName(/2026-08-18: \$139\.00/);
    expect(screen.getByText('2 observations')).toBeInTheDocument();
  });

  it('invites a collection pass instead of drawing an empty box', () => {
    render(<PriceHistoryChart points={[]} currency="USD" label="LIM to SCL" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/No observations yet/i)).toBeInTheDocument();
  });
});
