import { StrictMode, type PropsWithChildren } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryProvider } from '@/app/providers/QueryProvider';
import { AuthenticatedOwnerContext } from '@/shared/auth/AuthenticatedOwnerContext';
import { useFarePreload } from './useFarePreload';
import type { FareRoute } from '../data/fareRoutes';

type Listener = (event: string, session: { user: { id: string } } | null) => void;
const state = vi.hoisted(() => ({
  listeners: new Set<Listener>(),
  owner: undefined as string | null | undefined,
  month: vi.fn(),
  calendar: vi.fn(),
  history: vi.fn(),
}));
vi.mock('@/shared/auth/supabaseAuth', () => ({
  subscribeToAuth: (callback: Listener) => {
    state.listeners.add(callback);
    if (state.owner !== undefined)
      callback('INITIAL_SESSION', state.owner ? { user: { id: state.owner } } : null);
    return () => state.listeners.delete(callback);
  },
}));
vi.mock('@/features/investing/data/marketBarCache', () => ({
  marketBarCache: { clear: async () => {} },
}));
vi.mock('../data/supabaseAirfare', () => ({ fetchFareMonthProjection: state.month }));
vi.mock('@/shared/api/fares', () => ({
  fetchFareCalendar: state.calendar,
  fetchFareHistory: state.history,
}));

const routes: FareRoute[] = [
  { origin: 'AQP', destination: 'LIM', months: ['2027-01', '2027-02'], currency: 'USD' },
];
const key = ['fares', 'projection', 'AQP', 'LIM', '2027-01'];
const wrapper = ({ children }: PropsWithChildren) => (
  <StrictMode>
    <QueryProvider>
      <AuthenticatedOwnerContext.Provider value="a">{children}</AuthenticatedOwnerContext.Provider>
    </QueryProvider>
  </StrictMode>
);
let client: QueryClient;
let release: () => void;
function emit(owner: string | null) {
  state.owner = owner;
  state.listeners.forEach((callback) =>
    callback('SIGNED_IN', owner ? { user: { id: owner } } : null),
  );
}
function mount() {
  return renderHook(
    ({ watches }) => {
      client = useQueryClient();
      useFarePreload(watches, '2026-11-23', null);
    },
    { wrapper, initialProps: { watches: routes } },
  );
}
beforeEach(() => {
  state.owner = 'a';
  state.month.mockImplementation(
    (_origin, _destination, month) =>
      new Promise((resolve) => {
        release = () => resolve({ month, revision: 'r1', availabilityKnown: false });
      }),
  );
  state.calendar.mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  client?.clear();
  state.listeners.clear();
  vi.resetAllMocks();
});

it('waits for authenticated identity and starts without a route selection', async () => {
  state.owner = undefined;
  mount();
  expect(state.month).not.toHaveBeenCalled();
  act(() => emit('a'));
  await waitFor(() => expect(state.month).toHaveBeenCalledTimes(1));
  await act(async () => release());
  expect(client.getQueryData(key)).toMatchObject({ month: '2027-01' });
});

it('rejects a delayed first auth event for another owner before starting reads for the rendered list', () => {
  // The authenticated UI and its watchlist belong to A. The newly mounted hook
  // has not received its first auth snapshot when a refresh discovers B.
  state.owner = undefined;
  mount();
  act(() => emit('b'));
  expect(state.month).not.toHaveBeenCalled();
  expect(state.calendar).not.toHaveBeenCalled();
});

it('StrictMode and equivalent list renders share pending work; unmount stops successors', async () => {
  const { rerender, unmount } = mount();
  rerender({ watches: [...routes] });
  expect(state.month).toHaveBeenCalledTimes(1);
  expect(state.calendar).toHaveBeenCalledTimes(1);
  unmount();
  await act(async () => release());
  expect(state.month).toHaveBeenCalledTimes(1);
});

it.each([null, 'b'])(
  'stops on identity change to %s even if a transport ignores cancellation',
  async (owner) => {
    const { rerender } = mount();
    act(() => emit(owner));
    await act(async () => release());
    rerender({ watches: [...routes] });
    expect(client.getQueryData(key)).toBeUndefined();
    expect(state.month).toHaveBeenCalledTimes(1);
    expect(state.calendar).toHaveBeenCalledTimes(1);
  },
);

it('same-owner token refresh keeps preload running', async () => {
  mount();
  act(() => emit('a'));
  await act(async () => release());
  await waitFor(() => expect(state.month).toHaveBeenCalledTimes(2));
});

it('an updated list loads newly added months without rereading existing ones', async () => {
  state.month.mockImplementation(async (_origin, _destination, month) => ({
    month,
    revision: 'r1',
    availabilityKnown: false,
  }));
  state.calendar.mockResolvedValue({ horizon: null });
  const { rerender } = mount();
  await waitFor(() => expect(client.getQueryData(key)).toBeDefined());
  rerender({ watches: [{ ...routes[0], months: ['2027-01', '2027-02', '2027-03'] }] });
  await waitFor(() =>
    expect(client.getQueryData(['fares', 'projection', 'AQP', 'LIM', '2027-03'])).toBeDefined(),
  );
  expect(state.month).toHaveBeenCalledTimes(3);
});
