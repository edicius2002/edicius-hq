import { describe, expect, it } from 'vitest';

import {
  canRedo,
  canUndo,
  createHistory,
  record,
  redo,
  undo,
  type History,
} from '@/features/finance/lib/history';

/** Walk a sequence of edits, recording the state before each one. */
function edits(values: string[], keys: (string | null)[] = []): History<string> {
  let history = createHistory<string>();
  values.forEach((value, index) => {
    history = record(history, value, keys[index] ?? null);
  });
  return history;
}

const past = (history: History<string>) => history.past.map((entry) => entry.value);
const future = (history: History<string>) => history.future.map((entry) => entry.value);

describe('history', () => {
  it('starts with nowhere to go', () => {
    const history = createHistory<string>();
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(undo(history, 'now')).toBeNull();
    expect(redo(history, 'now')).toBeNull();
  });

  it('steps back to the state before each edit', () => {
    // a -> b -> c, recording the previous value each time.
    const history = edits(['a', 'b']);

    const first = undo(history, 'c');
    expect(first?.value).toBe('b');

    const second = undo(first!.history, first!.value);
    expect(second?.value).toBe('a');
    expect(canUndo(second!.history)).toBe(false);
  });

  it('steps forward again to exactly where it was', () => {
    const history = edits(['a', 'b']);
    const back = undo(history, 'c')!;
    const forward = redo(back.history, back.value)!;

    expect(forward.value).toBe('c');
    expect(past(forward.history)).toEqual(['a', 'b']);
    expect(canRedo(forward.history)).toBe(false);
  });

  it('survives a full round trip back and forward', () => {
    let history = edits(['a', 'b', 'c']);
    let present = 'd';

    for (let step = 0; step < 3; step += 1) {
      const back = undo(history, present)!;
      history = back.history;
      present = back.value;
    }
    expect(present).toBe('a');

    for (let step = 0; step < 3; step += 1) {
      const forward = redo(history, present)!;
      history = forward.history;
      present = forward.value;
    }
    expect(present).toBe('d');
    expect(canRedo(history)).toBe(false);
  });

  describe('coalescing', () => {
    it('merges a run of edits sharing a key into one step', () => {
      // A drag: many moves of the same node, all keyed the same.
      const history = edits(
        ['start', 'p1', 'p2', 'p3'],
        ['move:n1', 'move:n1', 'move:n1', 'move:n1'],
      );

      expect(past(history)).toEqual(['start']);
      expect(undo(history, 'p4')?.value).toBe('start');
    });

    it('starts a new step once the key changes', () => {
      const history = edits(['a', 'b', 'c'], ['move:n1', 'move:n2', 'move:n2']);
      expect(past(history)).toEqual(['a', 'b']);
    });

    it('never merges edits with no key', () => {
      const history = edits(['a', 'b', 'c']);
      expect(past(history)).toEqual(['a', 'b', 'c']);
    });

    it('does not merge a later edit into a restored state', () => {
      const history = edits(['a'], ['move:n1']);
      const back = undo(history, 'b')!;
      // Same key as before the undo, but the step it would merge into is gone.
      const after = record(back.history, back.value, 'move:n1');
      expect(past(after)).toEqual(['a']);
    });
  });

  describe('redo branch', () => {
    it('is dropped once a new edit is recorded', () => {
      const history = edits(['a', 'b']);
      const back = undo(history, 'c')!;
      expect(canRedo(back.history)).toBe(true);

      const branched = record(back.history, back.value);
      expect(canRedo(branched)).toBe(false);
      expect(past(branched)).toEqual(['a', 'b']);
    });

    it('is dropped even when the new edit coalesces with the step below', () => {
      const history = edits(['a'], ['move:n1']);
      const back = undo(history, 'b')!;
      const merged = record(back.history, back.value, 'move:n1');
      // The merge must not leave a redo pointing at an abandoned branch.
      expect(canRedo(merged)).toBe(false);
    });
  });

  describe('bounds', () => {
    it('drops the oldest steps past the limit', () => {
      let history = createHistory<string>();
      for (let index = 0; index < 6; index += 1) {
        history = record(history, `v${index}`, null, 3);
      }

      expect(past(history)).toEqual(['v3', 'v4', 'v5']);
    });

    it('keeps the most recent step reachable at a limit of one', () => {
      let history = createHistory<string>();
      history = record(history, 'a', null, 1);
      history = record(history, 'b', null, 1);

      expect(undo(history, 'c')?.value).toBe('b');
    });
  });

  it('never mutates the history it is given', () => {
    const history = edits(['a']);
    const snapshot = { past: past(history), future: future(history) };

    record(history, 'b');
    undo(history, 'c');
    redo(history, 'c');

    expect(past(history)).toEqual(snapshot.past);
    expect(future(history)).toEqual(snapshot.future);
  });
});
