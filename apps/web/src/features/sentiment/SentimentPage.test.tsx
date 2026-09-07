import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SentimentPage } from '@/features/sentiment/SentimentPage';
import type { SentimentMetric, SentimentResponse } from '@/shared/api/sentiment';

const INDICATORS = [
  ['market_momentum', 'Market Momentum'],
  ['stock_price_strength', 'Stock Price Strength'],
  ['stock_price_breadth', 'Stock Price Breadth'],
  ['put_call_options', 'Put and Call Options'],
  ['market_volatility', 'Market Volatility'],
  ['safe_haven_demand', 'Safe Haven Demand'],
  ['junk_bond_demand', 'Junk Bond Demand'],
] as const;

function metric(key: string, label: string): SentimentMetric {
  return {
    key,
    label,
    score: 61.4,
    classification: 'greed',
    timestamp: '2026-09-06T23:59:55Z',
    series: [
      {
        key: `${key}_value`,
        label,
        unit: key === 'fear_and_greed' ? 'score' : 'raw value',
        points: [
          { timestamp: '2026-09-05T23:59:55Z', value: 55, classification: 'neutral' },
          { timestamp: '2026-09-06T23:59:55Z', value: 61.4, classification: 'greed' },
        ],
      },
    ],
  };
}

function response(overrides: Partial<SentimentResponse> = {}): SentimentResponse {
  return {
    source: 'cnn',
    fetchedAt: '2026-09-07T12:00:00Z',
    asOf: '2026-09-06T23:59:55Z',
    stale: false,
    composite: metric('fear_and_greed', 'Fear & Greed Index'),
    indicators: INDICATORS.map(([key, label]) => metric(key, label)),
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SentimentPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SentimentPage', () => {
  it('renders the composite and all seven CNN indicator charts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(response())),
    );

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Fear & Greed Index' })).toBeInTheDocument();
    const charts = await screen.findAllByRole('img');
    expect(charts).toHaveLength(8);
    for (const [, label] of INDICATORS) {
      expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
      expect(screen.getByRole('img', { name: `${label} history` })).toBeInTheDocument();
    }
    expect(
      within(screen.getByRole('region', { name: 'Fear & Greed Index' })).getByText('61.4'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Greed').length).toBeGreaterThanOrEqual(8);
    expect(screen.getByRole('link', { name: 'CNN Fear & Greed Index' })).toHaveAttribute(
      'href',
      'https://edition.cnn.com/markets/fear-and-greed',
    );
  });

  it('shows an honest loading state while the snapshot is pending', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );

    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('Loading sentiment');
  });

  it('explains an unavailable source and retries the request', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ detail: 'CNN unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(response()));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sentiment is unavailable');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findAllByRole('img')).toHaveLength(8);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('warns when the API serves the last known good snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(response({ stale: true }))),
    );

    renderPage();

    expect(await screen.findByRole('status', { name: 'Stale data' })).toHaveTextContent(
      'last known snapshot',
    );
    expect(screen.getAllByRole('img')).toHaveLength(8);
  });

  it('does not invent charts when the normalized snapshot has no history', async () => {
    const empty = metric('fear_and_greed', 'Fear & Greed Index');
    empty.series[0].points = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(response({ composite: empty, indicators: [] }))),
    );

    renderPage();

    expect(await screen.findByText(/No sentiment history/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
