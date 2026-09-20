import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SentimentPage } from '@/features/sentiment/SentimentPage';
import { getLatestSentiment } from '@/features/sentiment/data/supabaseSentiment';
import type { SentimentMetric, SentimentResponse } from '@/shared/api/sentiment';
import panelStyles from '@/shared/ui/Panel.module.css';

vi.mock('@/features/sentiment/data/supabaseSentiment', () => ({ getLatestSentiment: vi.fn() }));

const mockedGetLatestSentiment = vi.mocked(getLatestSentiment);

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
  mockedGetLatestSentiment.mockReset();
});

describe('SentimentPage', () => {
  it('renders the composite and all seven CNN indicator charts', async () => {
    mockedGetLatestSentiment.mockResolvedValue(response());

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
    const composite = screen.getByRole('region', { name: 'Fear & Greed Index' });
    expect(composite).not.toHaveClass(panelStyles.compact);
    expect(within(composite).getByText(/^As of /)).toBeInTheDocument();
    for (const [, label] of INDICATORS) {
      const indicator = screen.getByRole('region', { name: label });
      expect(indicator).toHaveClass(panelStyles.compact);
      expect(within(indicator).queryByText(/^As of /)).not.toBeInTheDocument();
    }
  });

  it('shows an honest loading state while the snapshot is pending', () => {
    mockedGetLatestSentiment.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('Loading sentiment');
  });

  it('explains an unavailable source and retries the request', async () => {
    const user = userEvent.setup();
    mockedGetLatestSentiment
      .mockRejectedValueOnce(new Error('Supabase unavailable'))
      .mockResolvedValueOnce(response());

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sentiment is unavailable');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findAllByRole('img')).toHaveLength(8);
    expect(mockedGetLatestSentiment).toHaveBeenCalledTimes(2);
  });

  it('warns when the API serves the last known good snapshot', async () => {
    mockedGetLatestSentiment.mockResolvedValue(response({ stale: true }));

    renderPage();

    expect(await screen.findByRole('status', { name: 'Stale data' })).toHaveTextContent(
      'last known snapshot',
    );
    expect(screen.getAllByRole('img')).toHaveLength(8);
  });

  it('keeps provider provenance out of the page chrome', async () => {
    mockedGetLatestSentiment.mockResolvedValue(response({ source: 'cnn-mirror' }));

    renderPage();

    expect(await screen.findAllByRole('img')).toHaveLength(8);
    expect(
      screen.queryByText('CNN Fear & Greed Index and the seven market signals behind it.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'CNN Fear & Greed Index' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Fear & Greed Graph' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Source:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Retrieved /)).not.toBeInTheDocument();
    expect(screen.queryByText(/Snapshot as of/)).not.toBeInTheDocument();
  });

  it('does not invent charts when the normalized snapshot has no history', async () => {
    const empty = metric('fear_and_greed', 'Fear & Greed Index');
    empty.series[0].points = [];
    mockedGetLatestSentiment.mockResolvedValue(response({ composite: empty, indicators: [] }));

    renderPage();

    expect(await screen.findByText(/No sentiment history/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
