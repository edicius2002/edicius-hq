import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AirfareRequest } from '@/features/airfare/data/airfareRequests';
import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { useRouteCollection } from '@/features/airfare/hooks/useRouteCollection';
import { RouteList } from '@/features/airfare/ui/RouteList';

/*
 * The hook and the list are each tested alone elsewhere, and the page test
 * mocks both — which is how the bar could go missing: the hook keyed requests
 * `LIM-CUZ` while every row looks itself up as `LIM|CUZ`, and no test ever put
 * the two in the same render. This one does, with only the network faked.
 */
const api = vi.hoisted(() => {
  let receive: ((request: AirfareRequest) => void) | undefined;
  return {
    enqueueAirfareRequest: vi.fn(),
    fetchActiveAirfareRequests: vi.fn(async () => []),
    fetchAirfareRequest: vi.fn(),
    subscribeAirfareRequests: vi.fn((callback: (request: AirfareRequest) => void) => {
      receive = callback;
      return () => {};
    }),
    emit: (request: AirfareRequest) => receive?.(request),
  };
});

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
  const fares = useQuery({
    queryKey: ['fares', 'history', 'LIM', 'CUZ', '2026-10'],
    queryFn: readFareRecords,
  });
  return (
    <>
      <span>Records: {fares.data ?? 0}</span>
      <RouteList
        routes={[ROUTE]}
        colours={new Map()}
        selectedId={null}
        today="2026-08-18"
        collecting={collection.collecting}
        progress={collection.progress}
        notices={collection.notices}
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
    </>
  );
}

const readFareRecords = vi.fn(async () => 1);

describe('a manual collection on the watchlist', () => {
  it('shows database stages in order and refreshes fares only after completion', async () => {
    let acceptEnqueue: (request: AirfareRequest) => void = () => {};
    api.enqueueAirfareRequest.mockImplementation(
      () =>
        new Promise<AirfareRequest>((resolve) => {
          acceptEnqueue = resolve;
        }),
    );
    readFareRecords.mockResolvedValueOnce(1).mockResolvedValue(2);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Watchlist />
      </QueryClientProvider>,
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Fetch LIM → CUZ now, October 2026' }),
    );

    await waitFor(() => expect(screen.getByText('Records: 1')).toBeInTheDocument());
    expect(
      screen.getByRole('button', { name: 'Fetching LIM → CUZ, October 2026, submitting' }),
    ).toBeDisabled();
    await act(async () => acceptEnqueue(queued()));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Fetching LIM → CUZ, October 2026, queued' }),
      ).toBeDisabled(),
    );
    expect(readFareRecords).toHaveBeenCalledTimes(1);

    const update = (status: AirfareRequest['status'], stage: AirfareRequest['progress']) =>
      api.emit({ ...queued(), status, progress: stage, updatedAt: new Date().toISOString() });
    act(() => update('running', { stage: 'collecting', completed: 0, total: null }));
    expect(
      screen.getByRole('button', {
        name: 'Fetching LIM → CUZ, October 2026, downloading, preparing',
      }),
    ).toBeDisabled();
    act(() => update('running', { stage: 'collecting', completed: 10, total: 31 }));
    expect(screen.getByRole('button', { name: 'October 2026, fetching' })).toHaveAttribute(
      'data-fetching',
      'true',
    );
    expect(
      screen.getByRole('button', { name: 'Fetching LIM → CUZ, October 2026, downloading 32%' }),
    ).toBeDisabled();
    act(() => update('running', { stage: 'collecting', completed: 31, total: 31 }));
    expect(
      screen.getByRole('button', { name: 'Fetching LIM → CUZ, October 2026, downloading 100%' }),
    ).toBeDisabled();
    act(() => update('running', { stage: 'syncing', completed: 0, total: null }));
    expect(
      screen.getByRole('button', { name: 'Fetching LIM → CUZ, October 2026, syncing, preparing' }),
    ).toBeDisabled();
    act(() => update('running', { stage: 'syncing', completed: 2, total: 4 }));
    expect(
      screen.getByRole('button', { name: 'Fetching LIM → CUZ, October 2026, syncing 50%' }),
    ).toBeDisabled();
    expect(readFareRecords).toHaveBeenCalledTimes(1);

    act(() =>
      api.emit({
        ...queued(),
        status: 'complete',
        progress: { stage: 'syncing', completed: 4, total: 4 },
        result: {
          origin: 'LIM',
          destination: 'CUZ',
          month: '2026-10',
          lookedAt: 31,
          changed: 31,
          failed: 0,
          skipped: 0,
          synced: true,
        },
        updatedAt: new Date().toISOString(),
      }),
    );
    await waitFor(() => expect(screen.getByText('Records: 2')).toBeInTheDocument());
    expect(
      screen.getByRole('button', {
        name: /Fetch LIM → CUZ now, October 2026, Collection complete/,
      }),
    ).toHaveAttribute('data-result', 'success');
    expect(
      within(screen.getByRole('group', { name: 'Months watched for LIM → CUZ' })).getByRole(
        'button',
        { name: 'October 2026' },
      ),
    ).not.toHaveAttribute('data-fetching');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
