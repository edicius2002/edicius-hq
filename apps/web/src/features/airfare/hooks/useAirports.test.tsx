import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const fares = vi.hoisted(() => ({ fetchAirports: vi.fn() }));
vi.mock('@/shared/api/fares', () => fares);

import { useAirports } from './useAirports';

const LIM = {
  code: 'LIM',
  name: 'Lima',
  city: 'Lima',
  country: 'PE',
  latitude: -12,
  longitude: -77,
};
const SCL = {
  code: 'SCL',
  name: 'Santiago',
  city: 'Santiago',
  country: 'CL',
  latitude: -33,
  longitude: -70,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

describe('useAirports', () => {
  it('keeps the airports it has while a new set of stop codes loads', async () => {
    // Every arc is drawn from this map. When the month's stops arrive the codes
    // change, and a map that went empty meanwhile erased every arc for a beat.
    const withStop = deferred<{ airports: (typeof LIM)[] }>();
    fares.fetchAirports
      .mockResolvedValueOnce({ airports: [LIM] })
      .mockReturnValueOnce(withStop.promise);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result, rerender } = renderHook(({ codes }) => useAirports(codes), {
      wrapper,
      initialProps: { codes: [] as string[] },
    });
    await waitFor(() => expect(result.current.data?.has('LIM')).toBe(true));

    rerender({ codes: ['SCL'] });
    expect(result.current.data?.has('LIM')).toBe(true);

    withStop.resolve({ airports: [LIM, SCL] });
    await waitFor(() => expect(result.current.data?.has('SCL')).toBe(true));
  });
});
