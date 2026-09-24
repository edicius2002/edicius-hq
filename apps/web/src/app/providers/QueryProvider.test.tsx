import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { QueryProvider } from './QueryProvider';

const auth = vi.hoisted(() => ({ subscribe: vi.fn() }));
const clearBars = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/shared/auth/supabaseAuth', () => ({ subscribeToAuth: auth.subscribe }));
vi.mock('@/features/investing/data/marketBarCache', () => ({
  marketBarCache: { clear: clearBars },
}));

it('drops market bar memory and browser history when the signed-in owner changes', () => {
  let emit!: (event: string, session: { user: { id: string } } | null) => void;
  let client!: QueryClient;
  auth.subscribe.mockImplementation((callback) => {
    emit = callback;
    return () => undefined;
  });
  function Capture() {
    client = useQueryClient();
    return null;
  }
  render(
    <QueryProvider>
      <Capture />
    </QueryProvider>,
  );
  act(() => emit('INITIAL_SESSION', { user: { id: 'owner-a' } }));
  client.setQueryData(['market', 'bars', 'AAPL', '1d', false], { bars: [1] });
  client.setQueryData(['storage', 'investing-watchlist'], { entries: [] });

  act(() => emit('TOKEN_REFRESHED', { user: { id: 'owner-a' } }));
  expect(client.getQueryData(['market', 'bars', 'AAPL', '1d', false])).toBeDefined();
  act(() => emit('SIGNED_OUT', null));
  expect(client.getQueryData(['market', 'bars', 'AAPL', '1d', false])).toBeUndefined();
  expect(client.getQueryData(['storage', 'investing-watchlist'])).toBeDefined();
  expect(clearBars).toHaveBeenCalledOnce();
});
