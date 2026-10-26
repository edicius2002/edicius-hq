import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { subscribeToAuth } from '@/shared/auth/supabaseAuth';
import { createWriteQueue, type WriteQueue, type WriteState } from '@/shared/storage/writeQueue';
import type { StorageKey } from '@/shared/storage/keys';
import {
  readRemoteDocument,
  type RemoteDocument,
  writeRemoteDocument,
} from '@/shared/storage/supabaseStorage';

const noop = () => undefined;

/**
 * What the store has to say about saving.
 *
 * `loading` and `blocked` are the read's business rather than the queue's, and
 * they are separate states because their remedies differ: `blocked` means the
 * read failed and writing is refused, so the answer is to reload, not to retry.
 */
export type SaveState = WriteState | 'loading' | 'blocked';

export type StoredDocumentOptions<T> = {
  key: StorageKey;
  /** Turn whatever storage returns — including null — into a usable document. */
  normalize: (value: unknown) => T;
  /** Rendered while the first read is in flight. Never stored, never cached. */
  placeholder: T;
};

export type StoredDocument<T> = {
  data: T;
  isFetching: boolean;
  isError: boolean;
  /** Where the edits made so far have got to. */
  saveState: SaveState;
  /** Send the value a failed write left behind. */
  retrySave: () => void;
  /**
   * Apply an edit to the stored document and persist the result. The edit
   * receives the freshest known state, so callers pass an intent rather than a
   * precomputed value. It resolves once the edit is applied; the write follows
   * on a trailing debounce.
   */
  edit: (change: (current: T) => T | Promise<T>) => Promise<T>;
  /** Overwrite the document outright, ignoring what is stored. Waits for the write. */
  replace: (next: T) => Promise<T>;
};

type CachedDocument<T> = Pick<RemoteDocument<T>, 'payload' | 'revision'>;

/**
 * A whole-document store backed by revisioned Supabase owner documents.
 *
 * Two failure modes are handled here rather than in each feature, because both
 * were real bugs before this existed:
 *
 * - **Overlapping edits.** Every edit is read-modify-write over one document,
 *   so two started together would each build on pre-write state and the second
 *   would silently drop the first. Edits are applied strictly one at a time, and
 *   each updates the cache before resolving so the next reads current state. The
 *   writes are serialized in turn, by the queue.
 * - **Writing after a failed read.** The placeholder is a render fallback and
 *   never enters the cache, so an undefined cache entry means the read failed
 *   rather than "the stored document is empty" — a missing key still normalizes
 *   to a usable value. Editing on top of a failed read would put an empty
 *   document over real data, so it is refused instead.
 *
 * Local state leads and storage follows: an edit lands in the cache immediately
 * and the write goes out once the edits stop. That ordering is the point rather
 * than a side effect — a node whose position comes back from the network trails
 * the pointer that is dragging it.
 */
export function useStoredDocument<T>({
  key,
  normalize,
  placeholder,
}: StoredDocumentOptions<T>): StoredDocument<T> {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['storage', key] as const, [key]);
  const ownerId = useRef<string | null | undefined>(undefined);
  const staleOwner = useRef(false);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<CachedDocument<T>> => {
      const document = await readRemoteDocument<unknown>(key, signal);
      if (staleOwner.current) throw new Error('The document owner changed during this read.');
      return {
        payload: normalize(document?.payload),
        revision: document?.revision ?? 0,
      };
    },
    retry: false,
  });

  const [writeState, setWriteState] = useState<WriteState>('idle');

  // Construct after render, then keep one queue for the hook's lifetime. A
  // replacement mid-flight would drop the value it was holding.
  const queueRef = useRef<WriteQueue<T> | null>(null);
  const getQueue = useCallback((): WriteQueue<T> => {
    if (queueRef.current) return queueRef.current;
    const queue = createWriteQueue<T, RemoteDocument<T>>({
      write: (value) => {
        if (staleOwner.current) throw new Error('The document owner changed before this save.');
        const cached = queryClient.getQueryData<CachedDocument<T>>(queryKey);
        if (!cached)
          throw new Error(`Could not load "${key}", so nothing was saved. Reload first.`);
        return writeRemoteDocument(key, value, cached.revision);
      },
      onWritten: (acknowledgement) => {
        if (staleOwner.current) return;
        queryClient.setQueryData<CachedDocument<T>>(queryKey, (cached) =>
          cached ? { payload: cached.payload, revision: acknowledgement.revision } : cached,
        );
      },
      onState: (state) => {
        if (!staleOwner.current) setWriteState(state);
      },
    });
    queueRef.current = queue;
    return queue;
  }, [key, queryClient, queryKey]);

  useEffect(() => {
    const queue = getQueue();
    return subscribeToAuth((_event, session) => {
      const nextOwner = session?.user.id ?? null;
      if (ownerId.current === undefined) {
        ownerId.current = nextOwner;
      } else if (ownerId.current !== nextOwner) {
        staleOwner.current = true;
        queue.discard();
      }
    });
  }, [getQueue]);

  const writeChain = useRef<Promise<unknown>>(Promise.resolve());

  const serialize = useCallback((task: () => Promise<T>): Promise<T> => {
    // Run the task on settle, pass or fail, so one bad edit cannot wedge the chain.
    const run = writeChain.current.then(task, task);
    writeChain.current = run.then(noop, noop);
    return run;
  }, []);

  const edit = useCallback(
    (change: (current: T) => T | Promise<T>) =>
      serialize(async () => {
        if (staleOwner.current) throw new Error('The document owner changed before this edit.');
        const cached = queryClient.getQueryData<CachedDocument<T>>(queryKey);
        if (cached === undefined) {
          throw new Error(`Could not load "${key}", so nothing was saved. Reload first.`);
        }
        const current = cached.payload;
        const next = await change(current);
        if (staleOwner.current) throw new Error('The document owner changed before this edit.');
        // A change that returns what it was given decided against editing —
        // a refused operation, say — so there is nothing worth persisting.
        if (next === current) return current;

        // Set inside the serialized task, never after it, so the next edit sees this.
        queryClient.setQueryData<CachedDocument<T>>(queryKey, {
          payload: next,
          revision: cached.revision,
        });
        getQueue().push(next);
        return next;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from key
    [getQueue, key, normalize, queryClient, serialize],
  );

  const replace = useCallback(
    (next: T) =>
      serialize(async () => {
        if (staleOwner.current)
          throw new Error('The document owner changed before this replacement.');
        const cached = queryClient.getQueryData<CachedDocument<T>>(queryKey);
        if (cached === undefined) {
          throw new Error(`Could not load "${key}", so nothing was saved. Reload first.`);
        }
        queryClient.setQueryData<CachedDocument<T>>(queryKey, {
          payload: next,
          revision: cached.revision,
        });
        // Awaited rather than debounced: replacing the document is deliberate and
        // destructive, so the caller is told whether it landed. It also takes
        // over whatever the debounce was still holding, which would otherwise be
        // written after the replacement and quietly undo it.
        await getQueue().overwrite(next);
        if (staleOwner.current)
          throw new Error('The document owner changed before this replacement.');
        return next;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from key
    [getQueue, key, queryClient, serialize],
  );

  useEffect(() => {
    const queue = getQueue();
    function flushNow() {
      if (staleOwner.current) return;
      void queue.flush();
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') flushNow();
    }

    // A debounce that only fires on a timer loses what it holds when the page
    // goes away. `pagehide` covers a close or a navigation away; the hidden half
    // of `visibilitychange` covers a tab being backgrounded, which is the last
    // event a page is reliably given before it is discarded.
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      // Routing to another page unmounts this hook with the debounce possibly
      // still holding an edit; without this, leaving Finance mid-drag loses it.
      flushNow();
    };
  }, [getQueue]);

  const retrySave = useCallback(() => {
    if (staleOwner.current) return;
    void getQueue().flush();
  }, [getQueue]);

  return {
    // Undefined means loading or failed, never "stored and empty".
    data: query.data?.payload ?? placeholder,
    isFetching: query.isFetching,
    isError: query.isError,
    // A failed read outranks anything the queue has to say: it is why the queue
    // will not be given anything to write.
    saveState: query.isError ? 'blocked' : query.isPending ? 'loading' : writeState,
    retrySave,
    edit,
    replace,
  };
}
