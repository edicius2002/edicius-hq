const noop = () => undefined;

/**
 * How long the queue holds an edit before writing it.
 *
 * Long enough that a drag at 60Hz arrives as one write rather than one per
 * frame, short enough that a pause between edits settles to "Saved" while you
 * are still looking at it.
 */
export const WRITE_DELAY_MS = 400;

/** What the queue knows about the edits it has been handed. */
export type WriteState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed';

export type WriteQueue<T> = {
  /** Hold an edit, and write it once the edits stop arriving. */
  push: (value: T) => void;
  /**
   * Supersede whatever is held and write it as soon as the queue is free.
   * Rejects if the write does not land, because the caller asked for this one
   * directly rather than leaving it to a timer.
   */
  overwrite: (value: T) => Promise<void>;
  /**
   * Write what is held now, without waiting for the timer. Never rejects: the
   * state is the report, and the callers are page-lifecycle events and a Retry
   * button, neither of which has anywhere to put an exception.
   */
  flush: () => Promise<void>;
};

export type WriteQueueOptions<T> = {
  /** Performs the write. Rejecting means the value did not land. */
  write: (value: T) => Promise<unknown>;
  /** Called on a change of state, never on a repeat of the same one. */
  onState: (state: WriteState) => void;
  delayMs?: number;
};

/**
 * A trailing debounce in front of a strictly serialized writer.
 *
 * It exists because the document is written whole: dragging one node used to
 * spend a write per pointer move, and the render waited for each one, so on
 * anything slower than localhost the node fell behind the pointer. Holding the
 * edits and writing the last of them turns a drag into a single write.
 *
 * Two properties are load-bearing rather than incidental:
 *
 * - **One write at a time.** Two overlapping writes of one document can land in
 *   either order, and the loser silently wins. Everything that arrives during a
 *   write collapses into the next pass instead of racing it.
 * - **The debounce is flushable.** A timer alone loses whatever it holds when
 *   the page goes away, and a value queued before a restore would be written
 *   after it and quietly undo it.
 */
export function createWriteQueue<T>({
  write,
  onState,
  delayMs = WRITE_DELAY_MS,
}: WriteQueueOptions<T>): WriteQueue<T> {
  let held: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let state: WriteState = 'idle';
  let draining = false;

  /**
   * Bumped by every edit. A write that resolves against an older generation has
   * been overtaken, so it says nothing rather than painting "Saved" over edits
   * that are still waiting. Debouncing widens that window from the length of one
   * round trip to the length of a whole drag, which is why it matters now.
   */
  let generation = 0;

  /** The live pass, which may reject, and a link that swallows it so it cannot wedge the next. */
  let pass: Promise<void> = Promise.resolve();
  let chain: Promise<void> = Promise.resolve();

  function moveTo(next: WriteState) {
    if (next === state) return;
    state = next;
    onState(next);
  }

  function stopTimer() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  async function drainOnce(): Promise<void> {
    try {
      while (held) {
        const { value } = held;
        const sent = generation;
        held = null;
        moveTo('saving');

        try {
          await write(value);
        } catch (error) {
          // Keep it so a retry has something to send — unless a newer edit has
          // already taken its place, in which case that one supersedes it.
          if (held === null && sent === generation) held = { value };
          moveTo('failed');
          // Leaving the loop rather than going round again: retrying against a
          // dead endpoint on the spot would spin instead of waiting to be asked.
          throw error;
        }

        // Silent unless this is still the newest edit: a slow response must not
        // report "Saved" over work that is still waiting to go out.
        if (sent === generation) moveTo('saved');
      }
    } finally {
      draining = false;
    }
  }

  function drain(): Promise<void> {
    if (!draining) {
      draining = true;
      // Run on settle, pass or fail, so one bad write cannot wedge the chain.
      pass = chain.then(drainOnce, drainOnce);
      chain = pass.then(noop, noop);
    }
    return pass;
  }

  return {
    push(value: T) {
      held = { value };
      generation += 1;
      moveTo('pending');
      stopTimer();
      timer = setTimeout(() => {
        timer = null;
        void drain();
      }, delayMs);
    },

    overwrite(value: T) {
      // The held value is dropped rather than written first: this call replaces
      // the whole document, so writing the stale one would only be undone a
      // moment later. Anything already in flight still lands first, because a
      // pass writes one value at a time.
      stopTimer();
      held = { value };
      generation += 1;
      return drain();
    },

    flush() {
      stopTimer();
      return drain().catch(noop);
    },
  };
}
