import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RouteDetail } from './RouteDetail';
import type { FareInsights, FareSnapshot, WatchHealth } from '@/shared/api/fares';

const route = { origin: 'AEP', destination: 'SCL', months: ['2027-03'], currency: 'USD' };
const snapshot: FareSnapshot = {
  capturedAt: '2026-10-02T16:27:00',
  source: 'google-flights',
  origin: 'AEP',
  destination: 'SCL',
  flightDate: '2027-03-09',
  returnDate: null,
  currency: 'USD',
  offers: [
    {
      airline: 'JA',
      airlineName: 'JetSMART',
      flightNumber: '7015',
      departureAt: '2027-03-09T05:45',
      arrivalAt: '2027-03-09T07:15',
      transfers: 0,
      durationMinutes: 90,
      price: 122.84,
      currency: 'USD',
    },
  ],
} as FareSnapshot;
const insights: FareInsights = { typical: 118, usualLow: 110, usualHigh: 155 };
const health: WatchHealth = {
  checks: 1,
  changes: 1,
  errors: 0,
  lastCheckedAt: '2026-10-02T16:27:00+00:00',
};

function show(overrides: Partial<React.ComponentProps<typeof RouteDetail>> = {}) {
  return render(
    <RouteDetail
      route={route}
      month="2027-03"
      latest={snapshot}
      insights={insights}
      health={health}
      cities={{ from: 'Buenos Aires', to: 'Santiago' }}
      {...overrides}
    />,
  );
}

describe('RouteDetail', () => {
  it('keeps its route header visible while figures load', () => {
    show({ latest: null, insights: null, health: null, loading: true });
    expect(screen.getByRole('heading', { level: 3 }).textContent?.replace(/\s+/g, ' ')).toBe(
      'AEP → SCL March 2027',
    );
    expect(screen.getByText('Buenos Aires to Santiago')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading fares');
    expect(screen.queryByText(/reading the archive/i)).not.toBeInTheDocument();
  });

  it('shows a hidden skeleton in each figure slot', () => {
    const { container } = show({ latest: null, insights: null, health: null, loading: true });
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(9);
    expect(screen.getByRole('status')).toHaveTextContent('Loading fares');
    expect(screen.queryByText(/nothing observed yet/i)).not.toBeInTheDocument();
  });

  it('puts the big price beside the comparison and airline', () => {
    show();
    expect(screen.getByText('Cheapest now')).toBeInTheDocument();
    expect(screen.getByText('$122.84')).toBeInTheDocument();
    expect(screen.getByText('+4.1% vs usual')).toBeInTheDocument();
    expect(screen.getByText('JetSMART')).toBeInTheDocument();
    expect(screen.queryByText('Cheapest on')).not.toBeInTheDocument();
    expect(screen.queryByText('Vs usual')).not.toBeInTheDocument();
  });

  it.each([
    { price: 100, text: '-15.3% vs usual', tone: 'cheap' },
    { price: 122.84, text: '+4.1% vs usual', tone: 'neutral' },
    { price: 140, text: '+18.6% vs usual', tone: 'dear' },
  ])('uses the $tone comparison tone', ({ price, text, tone }) => {
    show({ latest: { ...snapshot, offers: [{ ...snapshot.offers[0], price }] } });
    expect(screen.getByText(text).className).toContain(tone);
  });

  it('marks the current and usual positions with no range title', () => {
    show();
    expect(screen.queryByText('Usual range')).not.toBeInTheDocument();
    expect(screen.getByText('usual')).toHaveStyle({ left: `${(8 / 45) * 100}%` });
    expect(parseFloat(screen.getByText('now').style.left)).toBeCloseTo(28.5333, 3);
    expect(screen.getByText('$110.00')).toBeInTheDocument();
    expect(screen.getByText('$155.00')).toBeInTheDocument();
  });

  it.each([
    { price: 50, side: '0%' },
    { price: 200, side: '100%' },
  ])('clamps a price outside the range to $side', ({ price, side }) => {
    show({ latest: { ...snapshot, offers: [{ ...snapshot.offers[0], price }] } });
    expect(screen.getByText('now')).toHaveStyle({ left: side });
  });

  it('keeps the range footprint without markers if insights are missing', () => {
    const { container } = show({ insights: null });
    expect(
      Array.from(container.querySelectorAll('[class*="ends"] span'), (end) => end.textContent),
    ).toEqual(['—', '—']);
    expect(container.querySelectorAll('[data-range-marker]')).toHaveLength(0);
  });

  it.each([
    { departureAt: '2027-03-09T05:45', day: 'Tuesday · 09' },
    { departureAt: '2027-03-01T05:45', day: 'Monday · 01' },
  ])('formats $departureAt as $day without timezone shifting', ({ departureAt, day }) => {
    show({ latest: { ...snapshot, offers: [{ ...snapshot.offers[0], departureAt }] } });
    expect(
      within(screen.getByText('Cheapest day').parentElement!).getByText(day),
    ).toBeInTheDocument();
  });

  it('puts usually and cheapest day in separate tiles above the footer', () => {
    const { container } = show();
    const tiles = container.querySelectorAll('[data-detail-tile]');
    expect(tiles).toHaveLength(2);
    expect(within(tiles[0] as HTMLElement).getByText('$118.00')).toBeInTheDocument();
    expect(within(tiles[1] as HTMLElement).getByText('Tuesday · 09')).toBeInTheDocument();
    expect(container.querySelector('footer')).toHaveTextContent('Last look 02/10/2026 11:27');
  });

  it('reserves a footer when no last look exists', () => {
    const { container } = show({ health: null });
    expect(container.querySelector('footer')).toBeEmptyDOMElement();
  });

  it('keeps both empty-state instructions', () => {
    show({ latest: null, insights: null });
    expect(screen.getByText('Nothing observed yet. Run a collection pass.')).toBeInTheDocument();
    show({ route: null });
    expect(screen.getByText('Add a route to start building its history.')).toBeInTheDocument();
  });
});
