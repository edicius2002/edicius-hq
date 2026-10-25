import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { stubKvStore } from '@/test/kvStore';
import { queryWrapper } from '@/test/queryWrapper';
import { useWatchlist } from './useWatchlist';

it('distinguishes the first watchlist read from a loaded empty list', async () => {
  stubKvStore({ key: 'watchlist', initial: { version: 1, entries: [] } });
  const { result } = renderHook(() => useWatchlist(), { wrapper: queryWrapper() });

  expect(result.current.isPending).toBe(true);
  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(result.current.list.entries).toEqual([]);
  vi.unstubAllGlobals();
});
