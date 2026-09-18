import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { readRemoteDocument, writeRemoteDocument } = vi.hoisted(() => ({
  readRemoteDocument: vi.fn(),
  writeRemoteDocument: vi.fn<
    (
      key: string,
      payload: { count: number },
      expectedRevision: number,
    ) => Promise<{
      key: 'watchlist';
      payload: { count: number };
      revision: number;
      updatedAt: string;
    }>
  >(),
}));

vi.mock('@/shared/storage/supabaseStorage', () => ({ readRemoteDocument, writeRemoteDocument }));

import { WRITE_DELAY_MS } from '@/shared/storage/writeQueue';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useStoredDocument', () => {
  it('uses the acknowledgement revision for the next queued write', async () => {
    readRemoteDocument.mockResolvedValue({
      key: 'watchlist',
      payload: { count: 0 },
      revision: 1,
      updatedAt: '2026-09-17T00:00:00.000Z',
    });
    writeRemoteDocument.mockImplementation(
      async (_key: string, payload: { count: number }, expectedRevision: number) => ({
        key: 'watchlist',
        payload,
        revision: expectedRevision + 1,
        updatedAt: '2026-09-17T00:00:00.000Z',
      }),
    );

    const { result } = renderHook(
      () =>
        useStoredDocument({
          key: 'watchlist',
          normalize: (value) => value as { count: number },
          placeholder: { count: -1 },
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual({ count: 0 }));

    await act(async () => {
      await result.current.edit((current) => ({ count: current.count + 1 }));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, WRITE_DELAY_MS + 10);
      });
    });
    await waitFor(() => expect(writeRemoteDocument).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.edit((current) => ({ count: current.count + 1 }));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, WRITE_DELAY_MS + 10);
      });
    });
    await waitFor(() => expect(writeRemoteDocument).toHaveBeenCalledTimes(2));

    expect(writeRemoteDocument.mock.calls.map((call) => call[2])).toEqual([1, 2]);
  });
});
