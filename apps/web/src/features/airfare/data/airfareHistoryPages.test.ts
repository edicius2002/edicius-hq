import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import rawFixture from '../../../../../../fixtures/airfare-history-pagination/v1.json?raw';
import rawSqlSession from '../../../../../../fixtures/airfare-history-pagination/sql-session.json?raw';
import type { FareHistoryResponse } from '@/shared/api/fares';
import { assembleHistory, HistoryRevisionChanged } from './airfareHistoryPages';

type Fixture = {
  filters: Parameters<typeof assembleHistory>[1];
  meta: Record<string, unknown>;
  snapshotPages: Record<string, unknown>[];
  baselinePages: Record<string, unknown>[];
  expected: FareHistoryResponse;
};

function fixture(): Fixture {
  const value: unknown = JSON.parse(rawFixture);
  expect(value).toHaveProperty('meta.counts.snapshots', '4');
  expect(value).toHaveProperty('snapshotPages');
  expect(value).toHaveProperty('expected');
  return value as Fixture;
}

function replies(data: Fixture): unknown[] {
  return [data.meta, ...data.snapshotPages, ...data.baselinePages, data.meta].map((value) =>
    structuredClone(value),
  );
}

function queued(values: unknown[]) {
  return vi.fn<Parameters<typeof assembleHistory>[0]>(async () => {
    const value = values.shift();
    if (value instanceof Error) throw value;
    return structuredClone(value);
  });
}

function change(value: unknown, path: (string | number)[], replacement: unknown) {
  let target = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
  target[path.at(-1)!] = replacement;
}

afterEach(() => vi.useRealTimers());

describe('complete revision-checked Airfare history', () => {
  it('assembles captured real SQL pages and discards them after a concurrent final conflict', async () => {
    vi.useFakeTimers();
    const captured: unknown = JSON.parse(rawSqlSession);
    expect(captured).toHaveProperty('wire.length', 5);
    const data = captured as {
      filters: Parameters<typeof assembleHistory>[1];
      wire: unknown[];
      expected: FareHistoryResponse;
    };
    const rpc = queued([...data.wire.slice(0, -1), new HistoryRevisionChanged(), ...data.wire]);
    const assertion = expect(assembleHistory(rpc, data.filters)).resolves.toEqual(data.expected);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(rpc).toHaveBeenCalledTimes(10);
  });

  it('preserves the shared document, tied observations and bigint source lines', async () => {
    const data = fixture();
    const rpc = queued(replies(data));
    await expect(assembleHistory(rpc, data.filters)).resolves.toEqual(data.expected);
    expect(rpc).toHaveBeenCalledTimes(5);
    expect(rpc.mock.calls[4][1]).toMatchObject({ p_expected_revision: data.meta.revision });
    expect(rpc.mock.calls[2][1]).toHaveProperty('p_cursor', data.snapshotPages[0].nextCursor);
    expect(rpc.mock.calls.every(([name]) => name.startsWith('read_owner_airfare_history_'))).toBe(
      true,
    );
  });

  const malformed: [number, (string | number)[], unknown][] = [
    [0, ['revision'], Number('9007199254740993')],
    [0, ['revision'], '9223372036854775808'],
    [0, ['counts', 'snapshots'], '04'],
    [0, ['counts', 'snapshots'], '9007199254740993'],
    [0, ['counts', 'snapshots'], '3'],
    [0, ['counts', 'baseline'], true],
    [0, ['origin'], 'XXX'],
    [0, ['protocolVersion'], true],
    [1, ['queryKey'], 'wrong'],
    [1, ['revision'], '1'],
    [1, ['dataset'], 'baseline'],
    [1, ['items'], []],
    [1, ['items', 0, 'order', 1], 9007199254740992],
    [1, ['items', 0, 'order', 1], '9223372036854775808'],
    [1, ['items', 0, 'order', 2], '0'.repeat(64)],
    [1, ['items', 0, 'payload'], []],
    [1, ['nextCursor', 'after', 1], '9007199254740993'],
    [1, ['nextCursor', 'dataset'], 'baseline'],
    [1, ['nextCursor'], null],
    [2, ['items', 0, 'order', 1], '1'],
    [2, ['items', 0, 'recordId'], '1'.repeat(64)],
    [2, ['nextCursor'], {}],
    [3, ['items', 0, 'order', 0], '2026-02-30'],
    [4, ['health', 'checks'], 99],
    [4, ['counts', 'snapshots'], '5'],
  ];
  it.each(malformed)(
    'rejects response %i path %j with invalid value %j',
    async (index, path, bad) => {
      const data = fixture();
      const wire = replies(data);
      change(wire[index], path, bad);
      await expect(assembleHistory(queued(wire), data.filters)).rejects.toThrow('history protocol');
    },
  );

  it('ignores object property order during final validation', async () => {
    const data = fixture();
    const wire = replies(data);
    wire[4] = Object.fromEntries(Object.entries(data.meta).reverse());
    await expect(assembleHistory(queued(wire), data.filters)).resolves.toEqual(data.expected);
  });

  it('skips zero-count pages but still validates final metadata', async () => {
    const data = fixture();
    data.meta.counts = { snapshots: '0', baseline: '0' };
    const rpc = queued([data.meta, data.meta]);
    await expect(assembleHistory(rpc, data.filters)).resolves.toEqual({
      ...data.expected,
      snapshots: [],
      baseline: [],
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('discards an attempt that conflicts at final validation', async () => {
    vi.useFakeTimers();
    const data = fixture();
    const wire = replies(data);
    wire[4] = new HistoryRevisionChanged();
    const rpc = queued([...wire, ...replies(data)]);
    const result = assembleHistory(rpc, data.filters);
    const assertion = expect(result).resolves.toEqual(data.expected);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(rpc).toHaveBeenCalledTimes(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limits revision churn to three attempts and 100/250ms backoff', async () => {
    vi.useFakeTimers();
    const data = fixture();
    const rpc = vi.fn<Parameters<typeof assembleHistory>[0]>(async () => {
      throw new HistoryRevisionChanged();
    });
    const assertion = expect(assembleHistory(rpc, data.filters)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(99);
    expect(rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(249);
    expect(rpc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry a late ordinary error or return accumulated pages', async () => {
    const data = fixture();
    const wire = replies(data);
    wire[2] = new Error('unavailable');
    const rpc = queued(wire);
    await expect(assembleHistory(rpc, data.filters)).rejects.toThrow('unavailable');
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it.each([0, 1, 2, 4, 5])(
    'cancellation after %i responses prevents publication and later requests',
    async (after) => {
      const data = fixture();
      const controller = new AbortController();
      const wire = replies(data);
      let calls = 0;
      const rpc = vi.fn<Parameters<typeof assembleHistory>[0]>(async () => {
        calls += 1;
        if (calls === after) controller.abort();
        return wire.shift();
      });
      if (after === 0) controller.abort();
      await expect(assembleHistory(rpc, data.filters, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(calls).toBe(after);
    },
  );

  it('cancels during backoff without starting another attempt', async () => {
    vi.useFakeTimers();
    const data = fixture();
    const controller = new AbortController();
    const rpc = queued([new HistoryRevisionChanged()]);
    const assertion = expect(
      assembleHistory(rpc, data.filters, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(1000);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the whole 60s deadline ends a pending request and aborts its signal', async () => {
    vi.useFakeTimers();
    const data = fixture();
    const rpc = vi.fn<Parameters<typeof assembleHistory>[0]>(() => new Promise(() => undefined));
    const assertion = expect(assembleHistory(rpc, data.filters)).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    expect(rpc.mock.calls[0][2].aborted).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans listeners when transport synchronously cancels before returning a pending promise', async () => {
    vi.useFakeTimers();
    const data = fixture();
    const caller = new AbortController();
    let added: MockInstance<AbortSignal['addEventListener']> | undefined;
    let removed: MockInstance<AbortSignal['removeEventListener']> | undefined;
    const rpc = vi.fn<Parameters<typeof assembleHistory>[0]>((_name, _params, signal) => {
      added = vi.spyOn(signal, 'addEventListener');
      removed = vi.spyOn(signal, 'removeEventListener');
      caller.abort();
      return new Promise(() => undefined);
    });
    await expect(assembleHistory(rpc, data.filters, caller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(removed?.mock.calls).toEqual(
      added?.mock.calls.map(([event, listener]) => [event, listener]),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
