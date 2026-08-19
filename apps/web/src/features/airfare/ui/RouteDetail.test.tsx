import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RouteDetail } from '@/features/airfare/ui/RouteDetail';
import type { FareInsights, FareSnapshot, WatchHealth } from '@/shared/api/fares';

/**
 * The panel that answers "what is this route, and should I care today".
 *
 * Two things it has to keep getting right: the header says which route and
 * when in as few words as possible, and every figure lands on one row. This
 * suite pins the wording; the row count is a measured thing and lives in the
 * stylesheet's own comments.
 */

const ROUTE = {
  origin: 'LIM',
  destination: 'AQP',
  flightDate: '2026-12-06',
  currency: 'USD',
};

const SNAPSHOT: FareSnapshot = {
  capturedAt: '2026-08-19T03:45:00',
  source: 'google-flights',
  origin: 'LIM',
  destination: 'AQP',
  flightDate: '2026-12-06',
  returnDate: null,
  currency: 'USD',
  offers: [
    {
      airline: 'JA',
      airlineName: 'JetSMART',
      flightNumber: '7015',
      departureAt: '2026-12-06T08:55',
      arrivalAt: '2026-12-06T10:25',
      transfers: 0,
      durationMinutes: 90,
      price: 63.36,
      currency: 'USD',
    },
    {
      airline: 'LA',
      airlineName: 'LATAM',
      flightNumber: '2011',
      departureAt: '2026-12-06T14:10',
      arrivalAt: '2026-12-06T15:40',
      transfers: 0,
      durationMinutes: 90,
      price: 104.64,
      currency: 'USD',
    },
  ],
} as FareSnapshot;

const INSIGHTS: FareInsights = { typical: 80, usualLow: 55, usualHigh: 130 };
const HEALTH: WatchHealth = {
  checks: 1,
  changes: 1,
  errors: 0,
  lastCheckedAt: '2026-08-19T03:45:00',
};

function renderDetail(overrides: Partial<React.ComponentProps<typeof RouteDetail>> = {}) {
  return render(
    <RouteDetail
      route={ROUTE}
      latest={SNAPSHOT}
      insights={INSIGHTS}
      health={HEALTH}
      cities={{ from: 'Lima', to: 'Arequipa' }}
      {...overrides}
    />,
  );
}

describe('RouteDetail', () => {
  it('puts the departure beside the pair, with no word in between', () => {
    // "Departs" was doing no work: a route has one date, and it is written
    // next to the two airports it belongs to.
    renderDetail();
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.textContent?.replace(/\s+/g, ' ')).toBe('LIM → AQP 06/12/2026');
    expect(heading.textContent).not.toMatch(/departs/i);
  });

  it('keeps a space between the code and the date for a screen reader', () => {
    // The gap beside it is a margin, and a margin is not something a screen
    // reader can hear.
    const heading = renderDetail().container.querySelector('h3')!;
    expect(heading.textContent).toContain('AQP 06/12/2026');
  });

  it('names the cities under the pair, and when it was last looked at', () => {
    renderDetail();
    expect(screen.getByText('Lima to Arequipa')).toBeInTheDocument();
    expect(screen.getByText(/Last look 19\/08\/2026 03:45/)).toBeInTheDocument();
  });

  it('says nothing about a last look when nothing has looked yet', () => {
    renderDetail({ health: null });
    expect(screen.queryByText(/last look/i)).not.toBeInTheDocument();
  });

  it('carries the board and the collector as figures, not as sentences', () => {
    /*
     * The heartbeat count especially: a stretch of archive with no new points
     * means either no price movement or no collector, and only that number
     * tells them apart. It was a footnote; it is a figure.
     */
    const { container } = renderDetail();
    const [money, board] = container.querySelectorAll('dl');
    expect(within(money as HTMLElement).getByText('Cheapest now')).toBeInTheDocument();
    for (const label of [
      'Itineraries',
      'Airlines',
      'Cheapest on',
      'Usual range',
      'Looks taken',
      'Changes',
    ]) {
      expect(within(board as HTMLElement).getByText(label)).toBeInTheDocument();
    }
    // The last look lives in the header now, not among the figures.
    expect(within(board as HTMLElement).queryByText('Last look')).not.toBeInTheDocument();
  });

  it('counts failures only when there have been some', () => {
    renderDetail();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    renderDetail({ health: { ...HEALTH, errors: 2 } });
    expect(screen.getAllByText('Failed').length).toBe(1);
  });

  it('asks for a collection rather than showing empty figures', () => {
    renderDetail({ latest: null, insights: null });
    expect(screen.getByText(/nothing observed yet/i)).toBeInTheDocument();
    expect(screen.queryByText('Itineraries')).not.toBeInTheDocument();
  });

  it('says what to do when no route is open at all', () => {
    renderDetail({ route: null });
    expect(screen.getByText(/add a route to start building/i)).toBeInTheDocument();
  });
});
