import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { readStorage, writeStorage } from '@/shared/storage/storage';
import type { StorageKey } from '@/shared/storage/keys';

const noop = () => undefined;

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
  /**
   * Apply an edit to the stored document and persist the result. The edit
   * receives the freshest known state, so callers pass an intent rather than a
   * precomputed value.
   */
  edit: (change: (current: T) => T | Promise<T>) => Promise<T>;
  /** Overwrite the document outright, ignoring what is stored. */
  replace: (next: T) => Promise<T>;
};

/**
 * A whole-document store backed by the local KV API.
 *
 * Two failure modes are handled here rather than in each feature, because both
 * were real bugs before this existed:
 *
 * - **Overlapping writes.** Every write is read-modify-write over one document,
 *   so two edits started together would each build on pre-write state and the
 *   second would silently drop the first. Writes run strictly one at a time, and
 *   each refreshes the cache before resolving so the next reads current state.
 * - **Writing after a failed read.** The placeholder is a render fallback and
 *   never enters the cache, so an undefined cache entry means the read failed
 *   rather than "the stored document is empty" — a missing key still normalizes
 *   to a usable value. Editing on top of a failed read would put an empty
 *   document over real data, so it is refused instead.
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

  const writeChain = useRef<Promise<unknown>>(Promise.resolve());

  const commit = useCallback(
    async (next: T): Promise<T> => {
      await writeStorage(key, next);
      // Inside the serialized task, never after it, so the next edit sees this.
      queryClient.setQueryData(queryKey, next);
      return next;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from key
    [key, queryClient],
  );

  const serialize = useCallback((task: () => Promise<T>): Promise<T> => {
    // Run the task on settle, pass or fail, so one bad write cannot wedge the chain.
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
        return commit(await change(normalize(cached)));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from key
    [commit, key, normalize, queryClient, serialize],
  );

  const replace = useCallback((next: T) => serialize(() => commit(next)), [commit, serialize]);

  return {
    // Undefined means loading or failed, never "stored and empty".
    data: query.data ?? placeholder,
    isFetching: query.isFetching,
    isError: query.isError,
    edit,
    replace,
  };
}
