import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
  focusManager,
} from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  latest: vi.fn(),
  history: vi.fn(),
  observe: vi.fn(),
  closed: vi.fn(),
}));
vi.mock('@/shared/auth/supabaseAuth', () => ({ subscribeToAuth: mocks.subscribe }));
vi.mock('./data', () => ({
  fetchLatest: mocks.latest,
  fetchHistory: mocks.history,
  subscribeFxObservations: mocks.observe,
}));
import { useFx } from './useFx';
let emit: (event: string, session: { user: { id: string } } | null) => void;
const changes = new Map<string, () => void>();
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
  changes.clear();
  mocks.subscribe.mockImplementation((callback) => {
    emit = callback;
    return () => {};
  });
  mocks.latest.mockResolvedValue([row]);
  mocks.history.mockResolvedValue({ points: [row], aggregation: 'observations' });
  mocks.observe.mockImplementation((owner: string, onChange: () => void) => {
    changes.set(owner, onChange);
    return () => {
      changes.delete(owner);
      mocks.closed(owner);
    };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
});
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
it('refetches latest and history on a capture, then closes the channel on owner change and unmount', async () => {
  const { unmount } = mount();
  act(() => emit('INITIAL_SESSION', { user: { id: 'A' } }));
  await waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
  expect(mocks.observe).toHaveBeenCalledWith('A', expect.any(Function));
  mocks.latest.mockResolvedValue([{ ...row, observed_at: '2026-09-29T14:51:00Z' }]);
  act(() => changes.get('A')!());
  await waitFor(() => expect(mocks.latest).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2));
  act(() => emit('SIGNED_IN', { user: { id: 'B' } }));
  await waitFor(() => expect(mocks.observe).toHaveBeenCalledWith('B', expect.any(Function)));
  expect(mocks.closed).toHaveBeenCalledWith('A');
  expect(changes.has('A')).toBe(false);
  unmount();
  expect(mocks.closed).toHaveBeenCalledWith('B');
  expect(changes.has('B')).toBe(false);
});
it('coalesces a burst of captures from one collector pass into a single refresh', async () => {
  mount();
  act(() => emit('INITIAL_SESSION', { user: { id: 'A' } }));
  await waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
  mocks.latest.mockResolvedValue([{ ...row, observed_at: '2026-09-29T14:51:00Z' }]);
  act(() => {
    for (let row = 0; row < 25; row += 1) changes.get('A')!();
  });
  await waitFor(() => expect(mocks.latest).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(mocks.latest).toHaveBeenCalledTimes(2);
  expect(mocks.history).toHaveBeenCalledTimes(2);
});

it('retains fresh FX when leaving and returning to the dashboard', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const first = renderHook(() => useFx('kambista', '7D'), { wrapper });
  act(() => emit('INITIAL_SESSION', { user: { id: 'A' } }));
  await waitFor(() => expect(first.result.current.latest.data).toEqual([row]));
  first.unmount();
  expect(client.getQueryData(['fx', 'A', 'latest'])).toEqual([row]);
  const second = renderHook(() => useFx('kambista', '7D'), { wrapper });
  act(() => emit('INITIAL_SESSION', { user: { id: 'A' } }));
  await waitFor(() => expect(second.result.current.latest.data).toEqual([row]));
  expect(mocks.latest).toHaveBeenCalledTimes(1);
  second.unmount();
  client.clear();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}

it('polls quotes every five seconds and refreshes history only for changed captures', async () => {
  vi.useFakeTimers();
  const { client } = mount();
  act(() => emit('INITIAL_SESSION', { user: { id: 'A' } }));
  await advance(10);
  await advance(5_000);
  expect(mocks.latest).toHaveBeenCalledTimes(2);
  expect(mocks.history).toHaveBeenCalledTimes(1);
  mocks.latest.mockResolvedValue([row, { ...row, source: 'rextie' }]);
  await advance(5_000);
  expect(mocks.history).toHaveBeenCalledTimes(1);
  mocks.latest.mockResolvedValue([{ ...row, observed_at: '2026-09-29T14:51:00Z' }]);
  await advance(5_000);
  expect(mocks.history).toHaveBeenCalledTimes(2);
  cleanup();
  client.clear();
});

it('reconciles unchanged history every minute for older revisions and moving ranges', async () => {
  vi.useFakeTimers();
  const { client } = mount();
  act(() => emit('INITIAL_SESSION', { user: { id: 'A' } }));
  await advance(10);
  await advance(60_000);
  expect(mocks.latest).toHaveBeenCalledTimes(13);
  expect(mocks.history).toHaveBeenCalledTimes(2);
  cleanup();
  client.clear();
});

it('pauses hidden polling and refreshes stale data on focus despite global defaults', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  });
  const hook = renderHook(() => useFx('kambista', '7D'), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  act(() => emit('INITIAL_SESSION', { user: { id: 'A' } }));
  await advance(10);
  act(() => focusManager.setFocused(false));
  await advance(65_000);
  expect(mocks.latest).toHaveBeenCalledTimes(1);
  expect(mocks.history).toHaveBeenCalledTimes(1);
  act(() => focusManager.setFocused(true));
  await advance(10);
  expect(mocks.latest).toHaveBeenCalledTimes(2);
  expect(mocks.history).toHaveBeenCalledTimes(2);
  hook.unmount();
  client.clear();
});

it('does not overlap slow quote requests and resumes polling after reconnect', async () => {
  vi.useFakeTimers();
  let resolve!: (rows: (typeof row)[]) => void;
  mocks.latest.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { client } = mount();
  act(() => emit('INITIAL_SESSION', { user: { id: 'A' } }));
  await advance(15_000);
  expect(mocks.latest).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve([row]);
  });
  await advance(10);
  act(() => onlineManager.setOnline(false));
  await advance(10_000);
  expect(mocks.latest).toHaveBeenCalledTimes(1);
  act(() => onlineManager.setOnline(true));
  await advance(10);
  expect(mocks.latest).toHaveBeenCalledTimes(2);
  await advance(5_000);
  expect(mocks.latest).toHaveBeenCalledTimes(3);
  cleanup();
  client.clear();
});
