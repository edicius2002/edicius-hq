import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { readStorage, writeStorage } from '@/shared/storage/storage';
import { createWriteQueue, type WriteQueue, type WriteState } from '@/shared/storage/writeQueue';
import type { StorageKey } from '@/shared/storage/keys';

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

/**
 * A whole-document store backed by the local KV API.
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
  const queryKey = ['storage', key] as const;

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => readStorage(key, signal).then(normalize),
    retry: false,
  });

  const [writeState, setWriteState] = useState<WriteState>('idle');

  // Built once and never rebuilt: a queue replaced mid-flight would drop
  // whatever it was holding, which is the one thing it exists to keep.
  const queueRef = useRef<WriteQueue<T> | null>(null);
  queueRef.current ??= createWriteQueue<T>({
    write: (value) => writeStorage(key, value),
    onState: setWriteState,
  });
  const queue = queueRef.current;

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
        const cached = queryClient.getQueryData<T>(queryKey);
        if (cached === undefined) {
          throw new Error(`Could not load "${key}", so nothing was saved. Reload first.`);
        }
        const current = normalize(cached);
        const next = await change(current);
        // A change that returns what it was given decided against editing —
        // a refused operation, say — so there is nothing worth persisting.
        if (next === current) return current;

        // Set inside the serialized task, never after it, so the next edit sees this.
        queryClient.setQueryData(queryKey, next);
        queue.push(next);
        return next;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from key
    [key, normalize, queryClient, queue, serialize],
  );

  const replace = useCallback(
    (next: T) =>
      serialize(async () => {
        queryClient.setQueryData(queryKey, next);
        // Awaited rather than debounced: replacing the document is deliberate and
        // destructive, so the caller is told whether it landed. It also takes
        // over whatever the debounce was still holding, which would otherwise be
        // written after the replacement and quietly undo it.
        await queue.overwrite(next);
        return next;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from key
    [key, queryClient, queue, serialize],
  );

  useEffect(() => {
    function flushNow() {
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
  }, [queue]);

  const retrySave = useCallback(() => {
    void queue.flush();
  }, [queue]);

  return {
    // Undefined means loading or failed, never "stored and empty".
    data: query.data ?? placeholder,
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
