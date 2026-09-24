import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AirfareRequest } from '@/features/airfare/data/airfareRequests';
import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { useRouteCollection } from '@/features/airfare/hooks/useRouteCollection';
import { RouteList } from '@/features/airfare/ui/RouteList';

/*
 * The hook and the list are each tested alone elsewhere, and the page test
 * mocks both — which is how the bar could go missing: the hook keyed requests
 * `LIM-CUZ` while every row looks itself up as `LIM|CUZ`, and no test ever put
 * the two in the same render. This one does, with only the network faked.
 */
const api = vi.hoisted(() => ({
  enqueueAirfareRequest: vi.fn(),
  fetchActiveAirfareRequests: vi.fn(async () => []),
  fetchAirfareRequest: vi.fn(),
  subscribeAirfareRequests: vi.fn(() => () => {}),
}));

vi.mock('@/features/airfare/data/airfareRequests', () => api);

const ROUTE: FareRoute = {
  origin: 'LIM',
  destination: 'CUZ',
  months: ['2026-10'],
  currency: 'USD',
};

function queued(): AirfareRequest {
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    payload: { origin: 'LIM', destination: 'CUZ', month: '2026-10', currency: 'USD' },
    progress: { stage: 'queued', completed: 0, total: null },
    status: 'queued',
    result: null,
    errorCode: null,
    createdAt: '2026-08-18T12:00:00.000Z',
    expiresAt: '2099-08-18T12:30:00.000Z',
    updatedAt: '2026-08-18T12:00:00.000Z',
  };
}

function Watchlist() {
  const collection = useRouteCollection();
  return (
    <RouteList
      routes={[ROUTE]}
      colours={new Map()}
      selectedId={null}
      today="2026-08-18"
      collecting={collection.collecting}
      progress={collection.progress}
      activeMonth={null}
      editing={null}
      onSelect={() => {}}
      onOpenMonth={() => {}}
      onRemove={() => {}}
      onCollect={collection.collect}
      onAdd={() => {}}
      onSave={() => {}}
      onClearEditing={() => {}}
      onMove={() => {}}
    />
  );
}

describe('a manual collection on the watchlist', () => {
  it('draws its progress bar under the row that asked for it', async () => {
    api.enqueueAirfareRequest.mockResolvedValue(queued());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Watchlist />
      </QueryClientProvider>,
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Collect LIM → CUZ now, October 2026' }),
    );

    expect(await screen.findByTestId(`collect-progress-${routeId(ROUTE)}`)).toHaveAttribute(
      'role',
      'progressbar',
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Collecting LIM → CUZ, October 2026' }),
      ).toBeDisabled(),
    );
  });
});
