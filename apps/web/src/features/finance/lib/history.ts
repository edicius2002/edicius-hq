/**
 * Undo/redo over whole values.
 *
 * The present is not kept here: it lives wherever the value is owned, and is
 * handed in on undo and redo. Holding a second copy would mean two places that
 * could disagree about what the current state is.
 *
 * This works on values rather than on a log of changes because ADR 0001 made
 * every diagram transition pure, so a previous diagram is simply an old value.
 */

export type HistoryEntry<T> = {
  value: T;
  /**
   * Edits sharing a key merge into the step already on the stack. A drag emits a
   * move per pointer event; without this, undo would step back a few pixels at a
   * time and one drag would fill the whole history.
   */
  coalesceKey: string | null;
};

export type History<T> = {
  past: HistoryEntry<T>[];
  future: HistoryEntry<T>[];
};

export const DEFAULT_HISTORY_LIMIT = 40;

export function createHistory<T>(): History<T> {
  return { past: [], future: [] };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

/**
 * Record the value as it stood *before* an edit.
 *
 * Recording an edit drops the redo branch: once you change something after
 * undoing, the states you had undone are no longer reachable from here.
 */
export function record<T>(
  history: History<T>,
  previous: T,
  coalesceKey: string | null = null,
  limit = DEFAULT_HISTORY_LIMIT,
): History<T> {
  const last = history.past.at(-1);
  if (coalesceKey !== null && last?.coalesceKey === coalesceKey) {
    // Already holding the state from before this run of edits started.
    return history.future.length ? { past: history.past, future: [] } : history;
  }

  const past = [...history.past, { value: previous, coalesceKey }];
  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    future: [],
  };
}

export type Step<T> = { history: History<T>; value: T };

/** Step back. Returns null when there is nothing to go back to. */
export function undo<T>(history: History<T>, present: T): Step<T> | null {
  const last = history.past.at(-1);
  if (!last) return null;

  return {
    history: {
      past: history.past.slice(0, -1),
      // A restored state carries no key: it must not merge with a later edit.
      future: [...history.future, { value: present, coalesceKey: null }],
    },
    value: last.value,
  };
}

/** Step forward. Returns null when nothing has been undone. */
export function redo<T>(history: History<T>, present: T): Step<T> | null {
  const last = history.future.at(-1);
  if (!last) return null;

  return {
    history: {
      past: [...history.past, { value: present, coalesceKey: null }],
      future: history.future.slice(0, -1),
    },
    value: last.value,
  };
}
