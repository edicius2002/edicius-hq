import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CollectionSummary } from '@/features/airfare/ui/CollectionSummary';
import type { CollectResponse, CollectRouteResult } from '@/shared/api/fares';

function result(overrides: Partial<CollectRouteResult> = {}): CollectRouteResult {
  return {
    origin: 'LIM',
    destination: 'SCL',
    flightDate: '2026-10-17',
    returnDate: null,
    ok: true,
    source: 'primary-provider',
    offers: 12,
    cheapest: 230,
    currency: 'USD',
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function report(overrides: Partial<CollectResponse> = {}): CollectResponse {
  return {
    startedAt: '2026-08-18T15:00:00+00:00',
    finishedAt: '2026-08-18T15:00:12+00:00',
    primary: 'primary-provider',
    sources: ['primary-provider'],
    collected: 1,
    failed: 0,
    results: [result()],
    ...overrides,
  };
}

describe('CollectionSummary', () => {
  it('counts what was collected and names who answered', () => {
    render(<CollectionSummary report={report()} />);

    expect(screen.getByText(/1 collected, 0 failed, via primary-provider/)).toBeInTheDocument();
  });

  it('reports a refusal beside the routes that worked', () => {
    render(
      <CollectionSummary
        report={report({
          collected: 1,
          failed: 1,
          results: [
            result(),
            result({
              destination: 'VVI',
              ok: false,
              source: null,
              offers: 0,
              cheapest: null,
              errorCode: 'rate-limited',
              errorMessage: 'the address is being throttled',
            }),
          ],
        })}
      />,
    );

    // The whole point of 8.8 and 8.41: the failure is visible, and it says why.
    expect(screen.getByText(/VVI/)).toHaveTextContent('rate-limited');
    expect(screen.getByText(/VVI/)).toHaveTextContent('the address is being throttled');
  });

  it('says when a route was served by something other than the provider asked for', () => {
    render(
      <CollectionSummary
        report={report({
          sources: ['primary-provider', 'other-provider'],
          collected: 2,
          results: [result(), result({ destination: 'CUZ', source: 'other-provider' })],
        })}
      />,
    );

    // A fallback answers a narrower question, so a series that mixes the two
    // has to say so rather than drawing both as the same kind of point.
    expect(screen.getByText(/Served by other-provider rather than primary-provider/)).toBeVisible();
    expect(screen.getByText(/coarser observation/)).toBeVisible();
  });

  it('stays quiet about fallbacks when there were none', () => {
    render(<CollectionSummary report={report()} />);

    expect(screen.queryByText(/rather than/)).not.toBeInTheDocument();
  });

  it('does not claim a provider when nothing was collected', () => {
    render(
      <CollectionSummary
        report={report({
          sources: [],
          collected: 0,
          failed: 1,
          results: [result({ ok: false, source: null, errorCode: 'blocked', errorMessage: 'no' })],
        })}
      />,
    );

    expect(screen.getByText(/0 collected, 1 failed\./)).toBeInTheDocument();
    expect(screen.queryByText(/via/)).not.toBeInTheDocument();
  });
});
