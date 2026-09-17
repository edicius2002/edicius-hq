import { act, cleanup, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => {
  class RevisionConflict extends Error {
    constructor() {
      super('finance_revision_conflict');
      this.name = 'FinanceRevisionConflict';
    }
  }

  return {
    read: vi.fn(),
    write: vi.fn(),
    RevisionConflict,
  };
});

vi.mock('@/features/finance/data/financeDocuments', () => ({
  FinanceRevisionConflict: remote.RevisionConflict,
  readFinanceDocument: remote.read,
  writeFinanceDocument: remote.write,
}));

import { useRemoteDocument } from '@/features/finance/hooks/useRemoteDocument';
import { queryWrapper, sharedQueryWrapper } from '@/test/queryWrapper';

type CounterDocument = { count: number };

type Rendered = RenderHookResult<ReturnType<typeof useRemoteDocument<CounterDocument>>, unknown>;

function remoteDocument(count: number, revision: number) {
  return {
    payload: { count },
    revision,
    updatedAt: `2026-09-16T12:00:0${revision}.000Z`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function mounted(): Rendered {
  return renderHook(
    () =>
      useRemoteDocument<CounterDocument>({
        key: 'finance',
        normalize: (value) => {
          if (!value || typeof value !== 'object') return { count: 0 };
          const count = (value as { count?: unknown }).count;
          return { count: typeof count === 'number' ? count : 0 };
        },
        placeholder: { count: -1 },
      }),
    { wrapper: queryWrapper() },
  );
}

async function loaded(rendered: Rendered): Promise<void> {
  await waitFor(() => expect(rendered.result.current.isFetching).toBe(false));
  expect(rendered.result.current.isError).toBe(false);
}

async function debounce(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 425));
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('useRemoteDocument', () => {
  it('normalizes the initial remote payload before making it editable', async () => {
    remote.read.mockResolvedValue(remoteDocument(4, 7));
    const rendered = mounted();

    await loaded(rendered);

    expect(rendered.result.current.data).toEqual({ count: 4 });
    expect(rendered.result.current.saveState).toBe('idle');
    expect(remote.read).toHaveBeenCalledWith('finance', expect.any(AbortSignal));
  });

  it('normalizes a missing row, starts at revision zero, and advances acknowledgement revisions', async () => {
    remote.read.mockResolvedValue(null);
    remote.write.mockImplementation(
      async (_key: string, payload: CounterDocument, revision: number) =>
        remoteDocument(payload.count, revision + 1),
    );
    const rendered = mounted();
    await loaded(rendered);
    expect(rendered.result.current.data).toEqual({ count: 0 });

    await act(async () => {
      await rendered.result.current.edit((current) => ({ count: current.count + 1 }));
    });
    expect(rendered.result.current.data).toEqual({ count: 1 });
    expect(remote.write).not.toHaveBeenCalled();
    await debounce();
    expect(remote.write).toHaveBeenCalledTimes(1);
    expect(remote.write).toHaveBeenLastCalledWith('finance', { count: 1 }, 0);

    await act(async () => {
      await rendered.result.current.edit((current) => ({ count: current.count + 1 }));
    });
    await debounce();
    expect(remote.write).toHaveBeenCalledTimes(2);
    expect(remote.write).toHaveBeenLastCalledWith('finance', { count: 2 }, 1);
  });

  it('serializes a later edit behind an acknowledged write and sends it with the new revision', async () => {
    const first = deferred<ReturnType<typeof remoteDocument>>();
    remote.read.mockResolvedValue(remoteDocument(0, 1));
    remote.write
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (_key: string, payload: CounterDocument, revision: number) =>
        remoteDocument(payload.count, revision + 1),
      );
    const rendered = mounted();
    await loaded(rendered);

    await act(async () => {
      await rendered.result.current.edit(() => ({ count: 1 }));
    });
    await debounce();
    expect(remote.write).toHaveBeenLastCalledWith('finance', { count: 1 }, 1);

    await act(async () => {
      await rendered.result.current.edit(() => ({ count: 2 }));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 425));
    });
    expect(remote.write).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(remoteDocument(1, 2));
      await Promise.resolve();
    });
    await waitFor(() => expect(remote.write).toHaveBeenCalledTimes(2));
    expect(remote.write).toHaveBeenLastCalledWith('finance', { count: 2 }, 2);
  });

  it('does not let a read that began before an edit replace the newer acknowledged document', async () => {
    const staleRead = deferred<ReturnType<typeof remoteDocument>>();
    const shared = sharedQueryWrapper();
    remote.read.mockResolvedValueOnce(remoteDocument(1, 1)).mockReturnValueOnce(staleRead.promise);
    remote.write.mockResolvedValue(remoteDocument(2, 2));
    const rendered = renderHook(
      () =>
        useRemoteDocument<CounterDocument>({
          key: 'finance',
          normalize: (value) =>
            value && typeof value === 'object' ? (value as CounterDocument) : { count: 0 },
          placeholder: { count: -1 },
        }),
      { wrapper: shared },
    );
    await loaded(rendered);

    const refetch = shared.client.refetchQueries({ queryKey: ['finance-documents', 'finance'] });
    await waitFor(() => expect(remote.read).toHaveBeenCalledTimes(2));
    await act(async () => {
      await rendered.result.current.replace({ count: 2 });
    });

    await act(async () => {
      staleRead.resolve(remoteDocument(1, 1));
      await refetch;
    });
    expect(rendered.result.current.data).toEqual({ count: 2 });
  });

  it('keeps an optimistic edit through a refetch that begins inside its 400 ms debounce', async () => {
    const staleRead = deferred<ReturnType<typeof remoteDocument>>();
    const shared = sharedQueryWrapper();
    remote.read.mockResolvedValueOnce(remoteDocument(1, 1)).mockReturnValueOnce(staleRead.promise);
    remote.write.mockResolvedValue(remoteDocument(2, 2));
    const rendered = renderHook(
      () =>
        useRemoteDocument<CounterDocument>({
          key: 'finance',
          normalize: (value) =>
            value && typeof value === 'object' ? (value as CounterDocument) : { count: 0 },
          placeholder: { count: -1 },
        }),
      { wrapper: shared },
    );
    await loaded(rendered);

    await act(async () => {
      await rendered.result.current.edit(() => ({ count: 2 }));
    });
    expect(rendered.result.current.data).toEqual({ count: 2 });
    expect(remote.write).not.toHaveBeenCalled();

    const refetch = shared.client.refetchQueries({ queryKey: ['finance-documents', 'finance'] });
    await waitFor(() => expect(remote.read).toHaveBeenCalledTimes(2));
    await act(async () => {
      staleRead.resolve(remoteDocument(1, 1));
      await refetch;
    });

    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    expect(rendered.result.current.data).toEqual({ count: 2 });
    expect(remote.write).not.toHaveBeenCalled();
  });

  it('keeps the newest local payload when a non-conflict write is retried', async () => {
    remote.read.mockResolvedValue(remoteDocument(0, 1));
    remote.write
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async (_key: string, payload: CounterDocument, revision: number) =>
        remoteDocument(payload.count, revision + 1),
      );
    const rendered = mounted();
    await loaded(rendered);

    await act(async () => {
      await rendered.result.current.edit(() => ({ count: 1 }));
    });
    await debounce();
    await waitFor(() => expect(rendered.result.current.saveState).toBe('failed'));

    await act(async () => {
      await rendered.result.current.edit(() => ({ count: 2 }));
    });
    await debounce();
    await waitFor(() => expect(remote.write).toHaveBeenCalledTimes(2));
    expect(remote.write).toHaveBeenLastCalledWith('finance', { count: 2 }, 1);
    expect(rendered.result.current.data).toEqual({ count: 2 });
  });

  it('blocks edits after an initial read failure instead of persisting its placeholder', async () => {
    remote.read.mockRejectedValue(new Error('Supabase is unavailable'));
    const rendered = mounted();

    await waitFor(() => expect(rendered.result.current.isError).toBe(true));
    expect(rendered.result.current.data).toEqual({ count: -1 });
    expect(rendered.result.current.saveState).toBe('blocked');
    await expect(rendered.result.current.edit(() => ({ count: 1 }))).rejects.toThrow(
      /could not load/i,
    );
    expect(remote.write).not.toHaveBeenCalled();
  });

  it('keeps the optimistic local document separate while it fetches a conflicting remote row', async () => {
    remote.read
      .mockResolvedValueOnce(remoteDocument(1, 3))
      .mockResolvedValueOnce(remoteDocument(8, 4));
    remote.write.mockRejectedValueOnce(new remote.RevisionConflict());
    const rendered = mounted();
    await loaded(rendered);

    await act(async () => {
      await rendered.result.current.edit(() => ({ count: 2 }));
    });
    await debounce();
    await waitFor(() => expect(rendered.result.current.conflict?.status).toBe('ready'));

    expect(rendered.result.current.data).toEqual({ count: 2 });
    expect(rendered.result.current.conflict).toEqual({
      status: 'ready',
      local: { count: 2 },
      remote: { count: 8 },
      remoteRevision: 4,
    });
  });

  it('still reports a conflict after Strict Mode has probed its lifecycle effects', async () => {
    const shared = sharedQueryWrapper();
    const Shared = shared;
    const StrictWrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <Shared>{children}</Shared>
      </StrictMode>
    );
    remote.read.mockResolvedValue(remoteDocument(1, 3));
    remote.write.mockRejectedValueOnce(new remote.RevisionConflict());
    const rendered = renderHook(
      () =>
        useRemoteDocument<CounterDocument>({
          key: 'finance',
          normalize: (value) =>
            value && typeof value === 'object' ? (value as CounterDocument) : { count: 0 },
          placeholder: { count: -1 },
        }),
      { wrapper: StrictWrapper },
    );
    await loaded(rendered);

    await act(async () => {
      await rendered.result.current.edit(() => ({ count: 2 }));
    });
    await debounce();

    await waitFor(() => expect(rendered.result.current.conflict?.status).toBe('ready'));
  });

  it('refreshes a conflict that could not initially read the remote row', async () => {
    remote.read
      .mockResolvedValueOnce(remoteDocument(1, 3))
      .mockRejectedValueOnce(new Error('transient read failure'))
      .mockResolvedValueOnce(remoteDocument(9, 4));
    remote.write.mockRejectedValueOnce(new remote.RevisionConflict());
    const rendered = mounted();
    await loaded(rendered);

    await act(async () => {
      await rendered.result.current.edit(() => ({ count: 2 }));
    });
    await debounce();
    await waitFor(() => expect(rendered.result.current.conflict?.status).toBe('load-failed'));
    expect(rendered.result.current.conflict).toEqual({
      status: 'load-failed',
      local: { count: 2 },
    });

    await act(async () => {
      await rendered.result.current.refreshConflict();
    });
    await waitFor(() => expect(rendered.result.current.conflict?.status).toBe('ready'));
    expect(rendered.result.current.conflict).toMatchObject({
      remote: { count: 9 },
      remoteRevision: 4,
    });
  });

  it('accepts a ready remote choice without writing it back and uses its revision for later edits', async () => {
    remote.read
      .mockResolvedValueOnce(remoteDocument(1, 3))
      .mockResolvedValueOnce(remoteDocument(8, 4));
    remote.write
      .mockRejectedValueOnce(new remote.RevisionConflict())
      .mockImplementation(async (_key: string, payload: CounterDocument, revision: number) =>
        remoteDocument(payload.count, revision + 1),
      );
    const rendered = mounted();
    await loaded(rendered);

    await act(async () => {
      await rendered.result.current.edit(() => ({ count: 2 }));
    });
    await debounce();
    await waitFor(() => expect(rendered.result.current.conflict?.status).toBe('ready'));

    act(() => rendered.result.current.acceptRemote());
    expect(rendered.result.current.conflict).toBeNull();
    expect(rendered.result.current.data).toEqual({ count: 8 });
    expect(remote.write).toHaveBeenCalledTimes(1);

    await act(async () => {
      await rendered.result.current.edit((current) => ({ count: current.count + 1 }));
    });
    await debounce();
    await waitFor(() => expect(remote.write).toHaveBeenCalledTimes(2));
    expect(remote.write).toHaveBeenLastCalledWith('finance', { count: 9 }, 4);
  });

  it('leaves both conflict choices inert until a remote row is ready to choose', async () => {
    remote.read.mockResolvedValue(remoteDocument(1, 3));
    const rendered = mounted();
    await loaded(rendered);

    expect(rendered.result.current.acceptRemote()).toBeUndefined();
    await expect(rendered.result.current.overwriteRemote()).resolves.toBeUndefined();
    expect(remote.write).not.toHaveBeenCalled();
    expect(rendered.result.current.data).toEqual({ count: 1 });
  });

  it('overwrites a ready remote row with the retained local payload only after its acknowledgement', async () => {
    const overwrite = deferred<ReturnType<typeof remoteDocument>>();
    remote.read
      .mockResolvedValueOnce(remoteDocument(1, 3))
      .mockResolvedValueOnce(remoteDocument(8, 4));
    remote.write
      .mockRejectedValueOnce(new remote.RevisionConflict())
      .mockReturnValueOnce(overwrite.promise);
    const rendered = mounted();
    await loaded(rendered);

    await act(async () => {
      await rendered.result.current.edit(() => ({ count: 2 }));
    });
    await debounce();
    await waitFor(() => expect(rendered.result.current.conflict?.status).toBe('ready'));

    let settled = false;
    const resolving = rendered.result.current.overwriteRemote().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(remote.write).toHaveBeenLastCalledWith('finance', { count: 2 }, 4);
    expect(settled).toBe(false);
    expect(rendered.result.current.conflict?.status).toBe('ready');

    await act(async () => {
      overwrite.resolve(remoteDocument(2, 5));
      await resolving;
    });
    expect(rendered.result.current.conflict).toBeNull();
    expect(rendered.result.current.data).toEqual({ count: 2 });
  });

  it('runs one concurrent remote overwrite and keeps its ready conflict after a recoverable failure', async () => {
    const overwrite = deferred<ReturnType<typeof remoteDocument>>();
    const failure = new Error('network unavailable');
    remote.read
      .mockResolvedValueOnce(remoteDocument(1, 3))
      .mockResolvedValueOnce(remoteDocument(8, 4));
    remote.write
      .mockRejectedValueOnce(new remote.RevisionConflict())
      .mockReturnValueOnce(overwrite.promise);
    const rendered = mounted();
    await loaded(rendered);

    await act(async () => {
      await rendered.result.current.edit(() => ({ count: 2 }));
    });
    await debounce();
    await waitFor(() => expect(rendered.result.current.conflict?.status).toBe('ready'));

    const first = rendered.result.current.overwriteRemote();
    const second = rendered.result.current.overwriteRemote();
    await Promise.resolve();
    const writeCallsBeforeFailure = remote.write.mock.calls.length;

    let outcomes: PromiseSettledResult<void>[] = [];
    await act(async () => {
      overwrite.reject(failure);
      outcomes = await Promise.allSettled([first, second]);
    });

    expect(writeCallsBeforeFailure).toBe(2);
    expect(outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: undefined },
    ]);
    expect(rendered.result.current.conflict).toEqual({
      status: 'ready',
      local: { count: 2 },
      remote: { count: 8 },
      remoteRevision: 4,
    });
    expect(rendered.result.current.saveState).toBe('failed');
  });

  it('waits to resolve replace until its write acknowledgement lands', async () => {
    const replacement = deferred<ReturnType<typeof remoteDocument>>();
    remote.read.mockResolvedValue(remoteDocument(1, 3));
    remote.write.mockReturnValue(replacement.promise);
    const rendered = mounted();
    await loaded(rendered);

    let settled = false;
    const replacing = rendered.result.current.replace({ count: 9 }).then((value) => {
      settled = true;
      return value;
    });
    await waitFor(() => expect(remote.write).toHaveBeenCalledWith('finance', { count: 9 }, 3));
    expect(settled).toBe(false);

    await act(async () => {
      replacement.resolve(remoteDocument(9, 4));
      await expect(replacing).resolves.toEqual({ count: 9 });
    });
  });

  for (const lifecycle of ['pagehide', 'visibilitychange', 'unmount'] as const) {
    it(`flushes a held edit on ${lifecycle}`, async () => {
      remote.read.mockResolvedValue(remoteDocument(1, 3));
      remote.write.mockImplementation(
        async (_key: string, payload: CounterDocument, revision: number) =>
          remoteDocument(payload.count, revision + 1),
      );
      const rendered = mounted();
      await loaded(rendered);

      await act(async () => {
        await rendered.result.current.edit(() => ({ count: 2 }));
      });
      expect(remote.write).not.toHaveBeenCalled();

      if (lifecycle === 'pagehide') {
        await act(async () => {
          window.dispatchEvent(new Event('pagehide'));
        });
      } else if (lifecycle === 'visibilitychange') {
        const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        await act(async () => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
        if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
      } else {
        rendered.unmount();
      }

      await waitFor(() => expect(remote.write).toHaveBeenCalledTimes(1));
      expect(remote.write).toHaveBeenLastCalledWith('finance', { count: 2 }, 3);
    });
  }
});
