import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWriteQueue, type WriteState } from '@/shared/storage/writeQueue';

const DELAY = 400;

/** A writer whose responses are released by hand, so races can be arranged. */
function pausedWriter() {
  const sent: string[] = [];
  const waiting: { value: string; settle: (ok: boolean) => void }[] = [];

  const write = (value: string) =>
    new Promise<void>((resolve, reject) => {
      sent.push(value);
      waiting.push({
        value,
        settle: (ok) => (ok ? resolve() : reject(new Error('storage said no'))),
      });
    });

  return {
    write,
    sent,
    inFlight: () => waiting.length,
    /** Answer the oldest outstanding write and let the queue carry on. */
    async answer(ok = true) {
      const next = waiting.shift();
      if (!next) throw new Error('nothing was in flight');
      next.settle(ok);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function queueOf(writer: ReturnType<typeof pausedWriter>) {
  const states: WriteState[] = [];
  const queue = createWriteQueue<string>({
    write: writer.write,
    onState: (state) => states.push(state),
    delayMs: DELAY,
  });
  return { queue, states };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('write queue', () => {
  it('collapses a run of edits into a single write of the last one', async () => {
    const writer = pausedWriter();
    const { queue, states } = queueOf(writer);

    // A drag: thirty edits, each arriving well inside the debounce window.
    for (let step = 1; step <= 30; step += 1) {
      queue.push(`position ${step}`);
      await vi.advanceTimersByTimeAsync(16);
    }

    expect(writer.sent).toEqual([]);
    expect(states).toEqual(['pending']);

    await vi.advanceTimersByTimeAsync(DELAY);
    expect(writer.sent).toEqual(['position 30']);

    await writer.answer();
    expect(states).toEqual(['pending', 'saving', 'saved']);
  });

  it('writes one at a time, so two values can never cross on the wire', async () => {
    const writer = pausedWriter();
    const { queue } = queueOf(writer);

    queue.push('first');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(writer.sent).toEqual(['first']);

    // Arrives while the first is still out; its own timer comes and goes.
    queue.push('second');
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(writer.inFlight()).toBe(1);
    expect(writer.sent).toEqual(['first']);

    await writer.answer();
    expect(writer.sent).toEqual(['first', 'second']);
  });

  it('writes what it is holding when asked, rather than waiting out the timer', async () => {
    const writer = pausedWriter();
    const { queue } = queueOf(writer);

    queue.push('half-dragged');
    const flushed = queue.flush();
    await Promise.resolve();

    expect(writer.sent).toEqual(['half-dragged']);
    await writer.answer();
    await expect(flushed).resolves.toBeUndefined();

    // The cancelled timer must not fire a second write for the same value.
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(writer.sent).toEqual(['half-dragged']);
  });

  it('keeps a rejected value to hand, so a retry has something to send', async () => {
    const writer = pausedWriter();
    const { queue, states } = queueOf(writer);

    queue.push('lost to the network');
    await vi.advanceTimersByTimeAsync(DELAY);
    await writer.answer(false);

    expect(states).toEqual(['pending', 'saving', 'failed']);

    const retried = queue.flush();
    await Promise.resolve();
    expect(writer.sent).toEqual(['lost to the network', 'lost to the network']);

    await writer.answer();
    await expect(retried).resolves.toBeUndefined();
    expect(states.at(-1)).toBe('saved');
  });

  it('does not report saved when a newer edit is still waiting to go out', async () => {
    const writer = pausedWriter();
    const { queue, states } = queueOf(writer);

    queue.push('old');
    await vi.advanceTimersByTimeAsync(DELAY);
    queue.push('new');

    await writer.answer();
    // The slow response belongs to a value that has been overtaken.
    expect(states).toEqual(['pending', 'saving', 'pending', 'saving']);
    expect(writer.sent).toEqual(['old', 'new']);

    await writer.answer();
    expect(states.at(-1)).toBe('saved');
  });

  it('lets an overwrite supersede a held edit instead of being undone by it', async () => {
    const writer = pausedWriter();
    const { queue } = queueOf(writer);

    queue.push('a node was dragged');
    const replaced = queue.overwrite('a backup was restored');
    await Promise.resolve();

    // The held edit is never sent: it would have landed after the restore.
    expect(writer.sent).toEqual(['a backup was restored']);
    await writer.answer();
    await expect(replaced).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(writer.sent).toEqual(['a backup was restored']);
  });

  it('lets an overwrite through only once the write before it has landed', async () => {
    const writer = pausedWriter();
    const { queue } = queueOf(writer);

    queue.push('an earlier edit');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(writer.sent).toEqual(['an earlier edit']);

    const replaced = queue.overwrite('a backup was restored');
    await Promise.resolve();
    expect(writer.sent).toEqual(['an earlier edit']);

    await writer.answer();
    expect(writer.sent).toEqual(['an earlier edit', 'a backup was restored']);
    await writer.answer();
    await expect(replaced).resolves.toBeUndefined();
  });

  it('tells the caller when an overwrite did not land', async () => {
    const writer = pausedWriter();
    const { queue } = queueOf(writer);

    const replaced = queue.overwrite('a backup was restored');
    await Promise.resolve();
    await writer.answer(false);

    await expect(replaced).rejects.toThrow(/storage said no/);
  });

  it('carries on after a failure rather than wedging on it', async () => {
    const writer = pausedWriter();
    const { queue } = queueOf(writer);

    queue.push('doomed');
    await vi.advanceTimersByTimeAsync(DELAY);
    await writer.answer(false);

    queue.push('the next edit');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(writer.sent).toEqual(['doomed', 'the next edit']);

    await writer.answer();
    expect(writer.inFlight()).toBe(0);
  });
});
