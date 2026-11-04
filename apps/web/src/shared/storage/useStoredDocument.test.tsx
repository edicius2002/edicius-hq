import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { readRemoteDocument, writeRemoteDocument, authListeners } = vi.hoisted(() => ({
  readRemoteDocument: vi.fn(),
  authListeners: new Set<(event: string, session: { user: { id: string } } | null) => void>(),
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
vi.mock('@/shared/auth/supabaseAuth', () => ({
  subscribeToAuth: (
    listener: (event: string, session: { user: { id: string } } | null) => void,
  ) => {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
  },
}));

import { WRITE_DELAY_MS } from '@/shared/storage/writeQueue';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  authListeners.clear();
  vi.clearAllMocks();
});

function auth(owner: string) {
  for (const listener of authListeners) listener('SIGNED_IN', { user: { id: owner } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sharedWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

describe('useStoredDocument', () => {
  it('does not let a late A read replace B cached data', async () => {
    const pending = deferred<{
      key: 'watchlist';
      payload: { count: number };
      revision: number;
      updatedAt: string;
    }>();
    readRemoteDocument.mockReturnValue(pending.promise);
    const { client, wrapper: shared } = sharedWrapper();
    renderHook(
      () =>
        useStoredDocument({
          key: 'watchlist',
          normalize: (value) => value as { count: number },
          placeholder: { count: -1 },
        }),
      { wrapper: shared },
    );
    act(() => {
      auth('owner-a');
      auth('owner-b');
      client.setQueryData(['storage', 'watchlist'], { payload: { count: 99 }, revision: 9 });
    });
    await act(async () => {
      pending.resolve({ key: 'watchlist', payload: { count: 1 }, revision: 1, updatedAt: '' });
      await pending.promise;
    });
    expect(client.getQueryData(['storage', 'watchlist'])).toEqual({
      payload: { count: 99 },
      revision: 9,
    });
  });

  it('rejects an A edit resolving after an owner switch without touching B cache', async () => {
    readRemoteDocument.mockResolvedValue({ key: 'watchlist', payload: { count: 1 }, revision: 1 });
    const { client, wrapper: shared } = sharedWrapper();
    const { result } = renderHook(
      () =>
        useStoredDocument({
          key: 'watchlist',
          normalize: (value) => value as { count: number },
          placeholder: { count: -1 },
        }),
      { wrapper: shared },
    );
    await waitFor(() => expect(result.current.data).toEqual({ count: 1 }));
    act(() => auth('owner-a'));
    const next = deferred<{ count: number }>();
    let edit!: Promise<{ count: number }>;
    await act(async () => {
      edit = result.current.edit(() => next.promise);
      await Promise.resolve();
    });
    act(() => {
      auth('owner-b');
      client.setQueryData(['storage', 'watchlist'], { payload: { count: 99 }, revision: 9 });
    });
    const rejected = expect(edit).rejects.toThrow('owner changed');
    await act(async () => {
      next.resolve({ count: 2 });
      await rejected;
    });
    expect(client.getQueryData(['storage', 'watchlist'])).toEqual({
      payload: { count: 99 },
      revision: 9,
    });
    expect(writeRemoteDocument).not.toHaveBeenCalled();
  });

  it('discards a queued A write on owner change, including unmount flush', async () => {
    readRemoteDocument.mockResolvedValue({ key: 'watchlist', payload: { count: 1 }, revision: 1 });
    const { result, unmount } = renderHook(
      () =>
        useStoredDocument({
          key: 'watchlist',
          normalize: (value) => value as { count: number },
          placeholder: { count: -1 },
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual({ count: 1 }));
    act(() => auth('owner-a'));
    await act(async () => {
      await result.current.edit(() => ({ count: 2 }));
    });
    act(() => auth('owner-b'));
    unmount();
    await act(async () => {
      await new Promise((done) => setTimeout(done, WRITE_DELAY_MS + 10));
    });
    expect(writeRemoteDocument).not.toHaveBeenCalled();
  });

  it('flushes a queued edit on same-owner navigation', async () => {
    readRemoteDocument.mockResolvedValue({ key: 'watchlist', payload: { count: 1 }, revision: 1 });
    writeRemoteDocument.mockResolvedValue({
      key: 'watchlist',
      payload: { count: 2 },
      revision: 2,
      updatedAt: '',
    });
    const { result, unmount } = renderHook(
      () =>
        useStoredDocument({
          key: 'watchlist',
          normalize: (value) => value as { count: number },
          placeholder: { count: -1 },
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual({ count: 1 }));
    act(() => auth('owner-a'));
    await act(async () => {
      await result.current.edit(() => ({ count: 2 }));
    });
    unmount();
    await waitFor(() =>
      expect(writeRemoteDocument).toHaveBeenCalledWith('watchlist', { count: 2 }, 1),
    );
  });

  it('ignores an A write acknowledgement after B owns the unscoped cache', async () => {
    readRemoteDocument.mockResolvedValue({ key: 'watchlist', payload: { count: 1 }, revision: 1 });
    const pending = deferred<Awaited<ReturnType<typeof writeRemoteDocument>>>();
    writeRemoteDocument.mockReturnValue(pending.promise);
    const { client, wrapper: shared } = sharedWrapper();
    const { result } = renderHook(
      () =>
        useStoredDocument({
          key: 'watchlist',
          normalize: (value) => value as { count: number },
          placeholder: { count: -1 },
        }),
      { wrapper: shared },
    );
    await waitFor(() => expect(result.current.data).toEqual({ count: 1 }));
    act(() => auth('owner-a'));
    await act(async () => {
      await result.current.edit(() => ({ count: 2 }));
      await new Promise((done) => setTimeout(done, WRITE_DELAY_MS + 10));
    });
    expect(writeRemoteDocument).toHaveBeenCalledOnce();
    act(() => {
      auth('owner-b');
      client.setQueryData(['storage', 'watchlist'], { payload: { count: 99 }, revision: 9 });
    });
    await act(async () => {
      pending.resolve({ key: 'watchlist', payload: { count: 2 }, revision: 2, updatedAt: '' });
      await pending.promise;
    });
    expect(client.getQueryData(['storage', 'watchlist'])).toEqual({
      payload: { count: 99 },
      revision: 9,
    });
  });
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
