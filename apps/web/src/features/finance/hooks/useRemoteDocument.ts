import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  FinanceRevisionConflict,
  readFinanceDocument,
  writeFinanceDocument,
  type FinanceDocumentKey,
} from '@/features/finance/data/financeDocuments';
import { subscribeToAuth } from '@/shared/auth/supabaseAuth';
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

function cell<T>(initial: T) {
  let value = initial;
  return {
    get: () => value,
    set: (next: T) => {
      value = next;
    },
  };
}

// Removing a Query ends the writer's lifetime. Removing its observers during
// navigation preserves the acknowledged revision and the single CAS writer.
const documentSessions = new WeakMap<object, unknown>();
function createDocumentSession<T>() {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    revision: cell(0),
    hasHydratedRevision: cell(false),
    localGeneration: cell(0),
    unacknowledgedLocalGeneration: cell<number | null>(null),
    sendingLocalGeneration: cell<number | null>(null),
    conflictGeneration: cell(0),
    queueWriteConflictGeneration: cell<number | null>(null),
    ignoreStaleQueueFailureState: cell(false),
    overwritingRemote: cell(false),
    ownerId: cell<string | null | undefined>(undefined),
    staleOwner: cell(false),
    conflictRef: cell<DocumentConflict<T> | null>(null),
    queueRef: cell<WriteQueue<T> | null>(null),
    loadConflictRef: cell<(local: T) => Promise<void>>(async () => {}),
    writeChain: cell<Promise<unknown>>(Promise.resolve()),
    writeState: cell<WriteState>('idle'),
    stopCache: cell<(() => void) | undefined>(undefined),
    notify: () => {
      version++;
      for (const listener of listeners) listener();
    },
    getSnapshot: () => version,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function sessionForQuery<T>(query: object): ReturnType<typeof createDocumentSession<T>> {
  let session = documentSessions.get(query) as
    ReturnType<typeof createDocumentSession<T>> | undefined;
  if (!session) {
    session = createDocumentSession<T>();
    documentSessions.set(query, session);
  }
  return session;
}

export function useRemoteDocument<T>({
  key,
  normalize,
  placeholder,
}: RemoteDocumentOptions<T>): RemoteStoredDocument<T> {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['finance-documents', key] as const, [key]);
  const cacheEntry = queryClient.getQueryCache().build(queryClient, { queryKey });
  const session = sessionForQuery<T>(cacheEntry);
  useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    if (session.stopCache.get()) return;
    session.stopCache.set(
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type === 'removed' && event.query === cacheEntry) {
          session.staleOwner.set(true);
          session.queueRef.get()?.discard();
          session.stopCache.get()?.();
          session.stopCache.set(undefined);
        }
      }),
    );
  }, [session, queryClient, cacheEntry]);
  const revision = session.revision;
  const hasHydratedRevision = session.hasHydratedRevision;
  const localGeneration = session.localGeneration;
  const unacknowledgedLocalGeneration = session.unacknowledgedLocalGeneration;
  const sendingLocalGeneration = session.sendingLocalGeneration;
  const conflictGeneration = session.conflictGeneration;
  const queueWriteConflictGeneration = session.queueWriteConflictGeneration;
  const ignoreStaleQueueFailureState = session.ignoreStaleQueueFailureState;
  const overwritingRemote = session.overwritingRemote;
  const ownerId = session.ownerId;
  const staleOwner = session.staleOwner;
  const conflictRef = session.conflictRef;
  const conflict = session.conflictRef.get();
  const writeState = session.writeState.get();
  const setWriteState = useCallback(
    (next: WriteState) => {
      session.writeState.set(next);
      session.notify();
    },
    [session],
  );

  const setConflictRecord = useCallback(
    (next: DocumentConflict<T> | null) => {
      conflictRef.set(next);
      session.notify();
    },
    [conflictRef, session],
  );

  const loadConflict = useCallback(
    async (local: T): Promise<void> => {
      if (staleOwner.get()) return;
      const request = conflictGeneration.get() + 1;
      conflictGeneration.set(request);
      setConflictRecord({ status: 'loading', local });

      try {
        const remote = await readFinanceDocument<T>(key);
        if (staleOwner.get() || request !== conflictGeneration.get()) return;
        if (!remote) throw new Error('The conflicting Finance document is no longer available.');

        setConflictRecord({
          status: 'ready',
          local,
          remote: normalize(remote.payload),
          remoteRevision: remote.revision,
        });
      } catch {
        if (!staleOwner.get() && request === conflictGeneration.get()) {
          setConflictRecord({ status: 'load-failed', local });
        }
      }
    },
    [conflictGeneration, key, normalize, setConflictRecord, staleOwner],
  );

  const queueRef = session.queueRef;
  const loadConflictRef = session.loadConflictRef;

  useEffect(() => {
    loadConflictRef.set(loadConflict);
  }, [loadConflict, loadConflictRef]);

  // The key is fixed for a hook instance. Build the imperative queue after
  // render, so its callbacks read live refs only when the queue actually runs.
  useEffect(() => {
    if (queueRef.get()) return;
    queueRef.set(
      createWriteQueue<T, number>({
        write: async (payload) => {
          if (staleOwner.get()) throw new Error('The Finance owner changed before this save.');
          sendingLocalGeneration.set(unacknowledgedLocalGeneration.get());
          queueWriteConflictGeneration.set(conflictGeneration.get());
          const saved = await writeFinanceDocument(key, payload, revision.get());
          return saved.revision;
        },
        onWritten: (nextRevision) => {
          if (staleOwner.get()) return;
          revision.set(nextRevision);
          if (
            sendingLocalGeneration.get() !== null &&
            sendingLocalGeneration.get() === unacknowledgedLocalGeneration.get()
          ) {
            unacknowledgedLocalGeneration.set(null);
          }
          sendingLocalGeneration.set(null);
        },
        onError: (error, local) => {
          sendingLocalGeneration.set(null);
          if (staleOwner.get()) return;
          if (queueWriteConflictGeneration.get() !== conflictGeneration.get()) {
            // An explicit acceptance or overwrite has already superseded this
            // queued pass. Its state transition must not recreate a conflict.
            ignoreStaleQueueFailureState.set(true);
            return;
          }
          if (!(error instanceof FinanceRevisionConflict)) return;
          const current = queryClient.getQueryData<T>(queryKey);
          void loadConflictRef.get()(current === undefined ? local : normalize(current));
        },
        onState: (state) => {
          if (state === 'failed' && ignoreStaleQueueFailureState.get()) {
            ignoreStaleQueueFailureState.set(false);
            return;
          }
          setWriteState(state);
        },
      }),
    );
  }, [
    conflictGeneration,
    ignoreStaleQueueFailureState,
    key,
    loadConflictRef,
    normalize,
    queryClient,
    queryKey,
    queueRef,
    queueWriteConflictGeneration,
    revision,
    sendingLocalGeneration,
    setWriteState,
    staleOwner,
    unacknowledgedLocalGeneration,
  ]);

  useEffect(
    () =>
      subscribeToAuth((_event, session) => {
        const nextOwner = session?.user.id ?? null;
        if (ownerId.get() === undefined) {
          ownerId.set(nextOwner);
        } else if (ownerId.get() !== nextOwner) {
          // A queued whole document belongs to the previous owner. The app
          // remounts this store for the new owner; never flush the old queue
          // using the new session's credentials.
          staleOwner.set(true);
          queueRef.get()?.discard();
        }
      }),
    [ownerId, queueRef, staleOwner],
  );

  const query = useQuery({
    queryKey,
    retry: false,
    // The writer may hold failed edits/conflicts while the page is unmounted.
    // Explicit owner changes still remove the query and retire the session.
    gcTime: Infinity,
    // A cached payload is editable only with its retained acknowledgement.
    refetchOnMount: hasHydratedRevision.get() ? true : 'always',
    queryFn: async ({ signal }) => {
      const generationAtStart = localGeneration.get();
      const remote = await readFinanceDocument<T>(key, signal);
      if (staleOwner.get()) throw new Error('The Finance owner changed during this read.');
      const remoteRevision = remote?.revision ?? 0;
      const cached = queryClient.getQueryData<T>(queryKey);

      // A response that began before an optimistic edit (or is older than an
      // acknowledgement) is informative only. Returning the cache prevents
      // React Query from painting that stale payload or revision over local UI.
      if (
        cached !== undefined &&
        (unacknowledgedLocalGeneration.get() !== null ||
          generationAtStart !== localGeneration.get() ||
          remoteRevision < revision.get())
      ) {
        return cached;
      }

      const next = normalize(remote?.payload ?? null);
      revision.set(remoteRevision);
      hasHydratedRevision.set(true);
      return next;
    },
  });

  const writeChain = session.writeChain;
  const serialize = useCallback(
    (task: () => Promise<T>): Promise<T> => {
      const run = writeChain.get().then(task, task);
      writeChain.set(run.then(noop, noop));
      return run;
    },
    [writeChain],
  );

  const assertEditable = useCallback((): T => {
    if (staleOwner.get()) throw new Error('The Finance owner changed before this edit.');
    if (conflictRef.get()) {
      throw new Error('Resolve the Finance document conflict before editing again.');
    }
    if (!hasHydratedRevision.get() || query.isError) {
      throw new Error(`Could not load "${key}", so nothing was saved. Reload first.`);
    }
    const cached = queryClient.getQueryData<T>(queryKey);
    if (cached === undefined) {
      throw new Error(`Could not load "${key}", so nothing was saved. Reload first.`);
    }
    return normalize(cached);
  }, [
    conflictRef,
    hasHydratedRevision,
    key,
    normalize,
    query.isError,
    queryClient,
    queryKey,
    staleOwner,
  ]);

  const edit = useCallback(
    (change: (current: T) => T | Promise<T>) =>
      serialize(async () => {
        const current = assertEditable();
        const next = await change(current);
        if (staleOwner.get()) {
          throw new Error('The Finance owner changed before this edit.');
        }
        if (next === current) return current;

        // Check again after asynchronous editing work: a conflict could have
        // arrived while a caller was deriving its next document.
        if (conflictRef.get()) {
          throw new Error('Resolve the Finance document conflict before editing again.');
        }
        localGeneration.set(localGeneration.get() + 1);
        unacknowledgedLocalGeneration.set(localGeneration.get());
        queryClient.setQueryData(queryKey, next);
        const queue = queueRef.get();
        if (!queue) throw new Error('Finance saving is not ready. Reload first.');
        queue.push(next);
        return next;
      }),
    [
      assertEditable,
      conflictRef,
      localGeneration,
      queryClient,
      queryKey,
      queueRef,
      serialize,
      staleOwner,
      unacknowledgedLocalGeneration,
    ],
  );

  const replace = useCallback(
    (next: T) =>
      serialize(async () => {
        assertEditable();
        localGeneration.set(localGeneration.get() + 1);
        unacknowledgedLocalGeneration.set(localGeneration.get());
        queryClient.setQueryData(queryKey, next);
        // This is a deliberate replacement, so its promise reports the remote
        // acknowledgement rather than merely the optimistic cache update.
        const queue = queueRef.get();
        if (!queue) throw new Error('Finance saving is not ready. Reload first.');
        await queue.overwrite(next);
        return next;
      }),
    [
      assertEditable,
      localGeneration,
      queryClient,
      queryKey,
      queueRef,
      serialize,
      unacknowledgedLocalGeneration,
    ],
  );

  const refreshConflict = useCallback((): Promise<void> => {
    // Conflict choices are mutually exclusive. An overwrite owns the current
    // ready conflict until its CAS call settles, so no refresh may begin and
    // later repopulate state after that choice succeeds.
    if (staleOwner.get() || overwritingRemote.get()) return Promise.resolve();
    const current = conflictRef.get();
    return current ? loadConflict(current.local) : Promise.resolve();
  }, [conflictRef, loadConflict, overwritingRemote, staleOwner]);

  const acceptRemote = useCallback(() => {
    const current = conflictRef.get();
    const queue = queueRef.get();
    if (
      staleOwner.get() ||
      !current ||
      current.status !== 'ready' ||
      overwritingRemote.get() ||
      !queue
    )
      return;

    const accepted = normalize(current.remote);
    // A failed CAS write is still held by the queue for a normal retry. This
    // explicit decision supersedes it; otherwise a later lifecycle flush could
    // silently send the rejected local document after acceptance.
    queue.discard();
    localGeneration.set(localGeneration.get() + 1);
    unacknowledgedLocalGeneration.set(null);
    revision.set(current.remoteRevision);
    conflictGeneration.set(conflictGeneration.get() + 1);
    queryClient.setQueryData(queryKey, accepted);
    setWriteState('saved');
    setConflictRecord(null);
  }, [
    conflictGeneration,
    conflictRef,
    localGeneration,
    normalize,
    overwritingRemote,
    queryClient,
    queryKey,
    queueRef,
    revision,
    setConflictRecord,
    setWriteState,
    staleOwner,
    unacknowledgedLocalGeneration,
  ]);

  const overwriteRemote = useCallback(async (): Promise<void> => {
    const current = conflictRef.get();
    const queue = queueRef.get();
    if (
      staleOwner.get() ||
      !current ||
      current.status !== 'ready' ||
      overwritingRemote.get() ||
      !queue
    )
      return;

    overwritingRemote.set(true);
    queue.discard();
    setWriteState('saving');
    try {
      const saved = await writeFinanceDocument(key, current.local, current.remoteRevision);
      if (staleOwner.get()) return;
      localGeneration.set(localGeneration.get() + 1);
      unacknowledgedLocalGeneration.set(null);
      revision.set(saved.revision);
      conflictGeneration.set(conflictGeneration.get() + 1);
      queryClient.setQueryData(queryKey, normalize(saved.payload));
      setWriteState('saved');
      setConflictRecord(null);
    } catch (error) {
      if (staleOwner.get()) throw error;
      setWriteState('failed');
      if (error instanceof FinanceRevisionConflict) void loadConflict(current.local);
      throw error;
    } finally {
      overwritingRemote.set(false);
    }
  }, [
    conflictGeneration,
    conflictRef,
    key,
    loadConflict,
    localGeneration,
    normalize,
    overwritingRemote,
    queryClient,
    queryKey,
    queueRef,
    revision,
    setConflictRecord,
    setWriteState,
    staleOwner,
    unacknowledgedLocalGeneration,
  ]);

  const flushQueuedEdits = useCallback(() => {
    // Retrying a known CAS failure would be an automatic conflict choice. The
    // resolution actions above are the only paths allowed to send it again.
    if (staleOwner.get() || conflictRef.get() || overwritingRemote.get()) return;
    const queue = queueRef.get();
    if (!queue) return;
    void queue.flush();
  }, [conflictRef, overwritingRemote, queueRef, staleOwner]);

  const retrySave = flushQueuedEdits;

  useEffect(() => {
    function flushNow() {
      flushQueuedEdits();
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
  }, [flushQueuedEdits]);

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
