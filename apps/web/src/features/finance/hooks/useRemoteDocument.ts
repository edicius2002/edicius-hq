import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  FinanceRevisionConflict,
  readFinanceDocument,
  writeFinanceDocument,
  type FinanceDocumentKey,
} from '@/features/finance/data/financeDocuments';
import { createWriteQueue, type WriteQueue, type WriteState } from '@/shared/storage/writeQueue';

const noop = () => undefined;

type SaveState = WriteState | 'loading' | 'blocked';

export type DocumentConflict<T> =
  | { status: 'loading'; local: T }
  | { status: 'load-failed'; local: T }
  | { status: 'ready'; local: T; remote: T; remoteRevision: number };

export type RemoteDocumentOptions<T> = {
  key: FinanceDocumentKey;
  /** Turns a remotely stored value, including a missing row, into an editable document. */
  normalize: (value: unknown) => T;
  /** Rendered only while the first read is unresolved or failed. */
  placeholder: T;
};

/** The local editing surface plus explicit reconciliation after a CAS conflict. */
export type RemoteStoredDocument<T> = {
  data: T;
  isFetching: boolean;
  isError: boolean;
  saveState: SaveState;
  retrySave: () => void;
  edit: (change: (current: T) => T | Promise<T>) => Promise<T>;
  replace: (next: T) => Promise<T>;
  conflict: DocumentConflict<T> | null;
  refreshConflict: () => Promise<void>;
  acceptRemote: () => void;
  overwriteRemote: () => Promise<void>;
};

/**
 * An optimistic, whole-document Finance store backed directly by Supabase.
 *
 * The revision is deliberately not React state: rendering a newer local value
 * does not mean it has been acknowledged. It changes only when an ordinary
 * read/write succeeds or when the caller explicitly accepts a fetched conflict
 * row. The queue then reads it at send time, after every preceding write has
 * settled, which is what makes compare-and-swap writes serial rather than
 * merely ordered at the call site.
 */
export function useRemoteDocument<T>({
  key,
  normalize,
  placeholder,
}: RemoteDocumentOptions<T>): RemoteStoredDocument<T> {
  const queryClient = useQueryClient();
  const queryKey = ['finance-documents', key] as const;
  const revision = useRef(0);
  const localGeneration = useRef(0);
  const unacknowledgedLocalGeneration = useRef<number | null>(null);
  const sendingLocalGeneration = useRef<number | null>(null);
  const conflictGeneration = useRef(0);
  const overwritingRemote = useRef(false);
  const mounted = useRef(true);
  const conflictRef = useRef<DocumentConflict<T> | null>(null);
  const [conflict, setConflict] = useState<DocumentConflict<T> | null>(null);
  const [writeState, setWriteState] = useState<WriteState>('idle');

  const setConflictRecord = useCallback((next: DocumentConflict<T> | null) => {
    conflictRef.current = next;
    if (mounted.current) setConflict(next);
  }, []);

  const loadConflict = useCallback(
    async (local: T): Promise<void> => {
      const request = ++conflictGeneration.current;
      setConflictRecord({ status: 'loading', local });

      try {
        const remote = await readFinanceDocument<T>(key);
        if (request !== conflictGeneration.current) return;
        if (!remote) throw new Error('The conflicting Finance document is no longer available.');

        setConflictRecord({
          status: 'ready',
          local,
          remote: normalize(remote.payload),
          remoteRevision: remote.revision,
        });
      } catch {
        if (request === conflictGeneration.current) {
          setConflictRecord({ status: 'load-failed', local });
        }
      }
    },
    [key, normalize, setConflictRecord],
  );

  // Built once: rebuilding a queue with a value held for debounce would lose
  // the edit. Finance document keys are fixed for a hook instance.
  const [queue] = useState<WriteQueue<T>>(() =>
    createWriteQueue<T, number>({
      write: async (payload) => {
        sendingLocalGeneration.current = unacknowledgedLocalGeneration.current;
        const saved = await writeFinanceDocument(key, payload, revision.current);
        return saved.revision;
      },
      onWritten: (nextRevision) => {
        revision.current = nextRevision;
        if (
          sendingLocalGeneration.current !== null &&
          sendingLocalGeneration.current === unacknowledgedLocalGeneration.current
        ) {
          unacknowledgedLocalGeneration.current = null;
        }
        sendingLocalGeneration.current = null;
      },
      onError: (error, local) => {
        sendingLocalGeneration.current = null;
        if (!(error instanceof FinanceRevisionConflict)) return;
        void loadConflict(local);
      },
      onState: setWriteState,
    }),
  );

  const query = useQuery({
    queryKey,
    retry: false,
    queryFn: async ({ signal }) => {
      const generationAtStart = localGeneration.current;
      const remote = await readFinanceDocument<T>(key, signal);
      const remoteRevision = remote?.revision ?? 0;
      const cached = queryClient.getQueryData<T>(queryKey);

      // A response that began before an optimistic edit (or is older than an
      // acknowledgement) is informative only. Returning the cache prevents
      // React Query from painting that stale payload or revision over local UI.
      if (
        cached !== undefined &&
        (unacknowledgedLocalGeneration.current !== null ||
          generationAtStart !== localGeneration.current ||
          remoteRevision < revision.current)
      ) {
        return cached;
      }

      const next = normalize(remote?.payload ?? null);
      revision.current = remoteRevision;
      return next;
    },
  });

  const writeChain = useRef<Promise<unknown>>(Promise.resolve());
  const serialize = useCallback((task: () => Promise<T>): Promise<T> => {
    const run = writeChain.current.then(task, task);
    writeChain.current = run.then(noop, noop);
    return run;
  }, []);

  const assertEditable = useCallback((): T => {
    if (conflictRef.current) {
      throw new Error('Resolve the Finance document conflict before editing again.');
    }
    const cached = queryClient.getQueryData<T>(queryKey);
    if (cached === undefined) {
      throw new Error(`Could not load "${key}", so nothing was saved. Reload first.`);
    }
    return normalize(cached);
  }, [key, normalize, queryClient, queryKey]);

  const edit = useCallback(
    (change: (current: T) => T | Promise<T>) =>
      serialize(async () => {
        const current = assertEditable();
        const next = await change(current);
        if (next === current) return current;

        // Check again after asynchronous editing work: a conflict could have
        // arrived while a caller was deriving its next document.
        if (conflictRef.current) {
          throw new Error('Resolve the Finance document conflict before editing again.');
        }
        localGeneration.current += 1;
        unacknowledgedLocalGeneration.current = localGeneration.current;
        queryClient.setQueryData(queryKey, next);
        queue.push(next);
        return next;
      }),
    [assertEditable, queryClient, queryKey, queue, serialize],
  );

  const replace = useCallback(
    (next: T) =>
      serialize(async () => {
        assertEditable();
        localGeneration.current += 1;
        unacknowledgedLocalGeneration.current = localGeneration.current;
        queryClient.setQueryData(queryKey, next);
        // This is a deliberate replacement, so its promise reports the remote
        // acknowledgement rather than merely the optimistic cache update.
        await queue.overwrite(next);
        return next;
      }),
    [assertEditable, queryClient, queryKey, queue, serialize],
  );

  const refreshConflict = useCallback((): Promise<void> => {
    const current = conflictRef.current;
    return current ? loadConflict(current.local) : Promise.resolve();
  }, [loadConflict]);

  const acceptRemote = useCallback(() => {
    const current = conflictRef.current;
    if (!current || current.status !== 'ready') return;

    const accepted = normalize(current.remote);
    // A failed CAS write is still held by the queue for a normal retry. This
    // explicit decision supersedes it; otherwise a later lifecycle flush could
    // silently send the rejected local document after acceptance.
    queue.discard();
    localGeneration.current += 1;
    unacknowledgedLocalGeneration.current = null;
    revision.current = current.remoteRevision;
    queryClient.setQueryData(queryKey, accepted);
    setConflictRecord(null);
  }, [normalize, queryClient, queryKey, queue, setConflictRecord]);

  const overwriteRemote = useCallback(async (): Promise<void> => {
    const current = conflictRef.current;
    if (!current || current.status !== 'ready' || overwritingRemote.current) return;

    overwritingRemote.current = true;
    queue.discard();
    setWriteState('saving');
    try {
      const saved = await writeFinanceDocument(key, current.local, current.remoteRevision);
      localGeneration.current += 1;
      unacknowledgedLocalGeneration.current = null;
      revision.current = saved.revision;
      queryClient.setQueryData(queryKey, normalize(saved.payload));
      setWriteState('saved');
      setConflictRecord(null);
    } catch (error) {
      setWriteState('failed');
      if (error instanceof FinanceRevisionConflict) void loadConflict(current.local);
      throw error;
    } finally {
      overwritingRemote.current = false;
    }
  }, [key, loadConflict, normalize, queryClient, queryKey, queue, setConflictRecord]);

  const retrySave = useCallback(() => {
    // Retrying a known CAS failure would be an automatic conflict choice. The
    // resolution actions above are the only paths allowed to send it again.
    if (!conflictRef.current) void queue.flush();
  }, [queue]);

  useEffect(() => {
    function flushNow() {
      void queue.flush();
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') flushNow();
    }

    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flushNow();
    };
  }, [queue]);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  return {
    data: query.data ?? placeholder,
    isFetching: query.isFetching,
    isError: query.isError,
    saveState: query.isError ? 'blocked' : query.isPending ? 'loading' : writeState,
    retrySave,
    edit,
    replace,
    conflict,
    refreshConflict,
    acceptRemote,
    overwriteRemote,
  };
}
