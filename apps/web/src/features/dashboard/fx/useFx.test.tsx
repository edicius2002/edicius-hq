import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), latest: vi.fn(), history: vi.fn() }));
vi.mock('@/shared/auth/supabaseAuth', () => ({ subscribeToAuth: mocks.subscribe }));
vi.mock('./data', () => ({ fetchLatest: mocks.latest, fetchHistory: mocks.history }));
import { useFx } from './useFx';
let emit: (event: string, session: { user: { id: string } } | null) => void;
const row = {
  owner_id: 'A',
  source: 'kambista',
  buy: 3.71,
  sell: 3.73,
  observed_at: '2026-09-29T14:50:00Z',
  effective_at: '2026-09-29T14:50:00Z',
  context: {},
};
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(() => useFx('kambista', '7D'), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, client };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.subscribe.mockImplementation((callback) => {
    emit = callback;
    return () => {};
  });
  mocks.latest.mockResolvedValue([row]);
  mocks.history.mockResolvedValue({ points: [row], aggregation: 'observations' });
});
afterEach(() => onlineManager.setOnline(true));
it('waits for auth resolution and isolates an offline owner switch without remounting', async () => {
  const { result, client } = mount();
  expect(mocks.latest).not.toHaveBeenCalled();
  expect(mocks.history).not.toHaveBeenCalled();
  act(() => emit('INITIAL_SESSION', { user: { id: 'A' } }));
  await waitFor(() => expect(result.current.latest.data?.[0].owner_id).toBe('A'));
  await waitFor(() => expect(result.current.history.data?.points[0].owner_id).toBe('A'));
  act(() => {
    onlineManager.setOnline(false);
    emit('SIGNED_IN', { user: { id: 'B' } });
  });
  expect(result.current.latest.data).toBeUndefined();
  expect(result.current.history.data).toBeUndefined();
  expect(client.getQueryData(['fx', 'A', 'latest'])).toBeUndefined();
  mocks.latest.mockRejectedValue(new Error('owner access required'));
  mocks.history.mockRejectedValue(new Error('owner access required'));
  act(() => onlineManager.setOnline(true));
  await waitFor(() => expect(result.current.latest.isError).toBe(true));
  expect(result.current.latest.data).toBeUndefined();
  expect(result.current.history.data).toBeUndefined();
});
it('cancels old reads and never exposes late responses after sign-out', async () => {
  let resolveLatest!: (value: unknown) => void;
  let resolveHistory!: (value: unknown) => void;
  mocks.latest.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveLatest = resolve;
      }),
  );
  mocks.history.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
  );
  const { result, client } = mount();
  act(() => emit('INITIAL_SESSION', { user: { id: 'A' } }));
  await waitFor(() => expect(mocks.latest).toHaveBeenCalledOnce());
  const latestSignal: AbortSignal = mocks.latest.mock.calls[0][0];
  const historySignal: AbortSignal = mocks.history.mock.calls[0][2];
  act(() => emit('SIGNED_OUT', null));
  expect(latestSignal.aborted).toBe(true);
  expect(historySignal.aborted).toBe(true);
  await act(async () => {
    resolveLatest([row]);
    resolveHistory({ points: [row], aggregation: 'observations' });
  });
  expect(result.current.latest.data).toBeUndefined();
  expect(result.current.history.data).toBeUndefined();
  expect(client.getQueriesData({ queryKey: ['fx', 'A'] })).toEqual([]);
  await act(async () => {
    await result.current.latest.refetch();
    await result.current.history.refetch();
  });
  expect(mocks.latest).toHaveBeenCalledOnce();
  expect(mocks.history).toHaveBeenCalledOnce();
});
