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
  const data = value as Fixture;
  data.filters = { ...data.filters, p_snapshot_months: ['2026-11'] };
  return data;
}

function multiMonthFixture(): Fixture {
  const value: unknown = JSON.parse(rawFixture);
  expect(value).toHaveProperty('filters.p_snapshot_months', ['2026-11', '2026-12']);
  return value as Fixture;
}

function replies(data: Fixture): unknown[] {
  return [
    data.meta,
    data.snapshotPages[0],
    data.baselinePages[0],
    ...data.snapshotPages.slice(1),
    ...data.baselinePages.slice(1),
    data.meta,
  ].map((value) => structuredClone(value));
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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
    data.filters = { ...data.filters, p_snapshot_months: ['2026-11'] };
    const pass = [data.wire[0], data.wire[1], data.wire[3], data.wire[2], data.wire[4]];
    const rpc = queued([...pass.slice(0, -1), new HistoryRevisionChanged(), ...pass]);
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
    expect(rpc.mock.calls[3][1]).toHaveProperty('p_cursor', data.snapshotPages[0].nextCursor);
    expect(rpc.mock.calls.every(([name]) => name.startsWith('read_owner_airfare_history_'))).toBe(
      true,
    );
  });

  it('uses the largest bounded page and reads both datasets concurrently', async () => {
    const data = fixture();
    const snapshots = data.snapshotPages.map((page) => structuredClone(page));
    const baseline = data.baselinePages.map((page) => structuredClone(page));
    const firstSnapshot = deferred<unknown>();
    const baselineStarted = deferred<void>();
    const startedBeforeSnapshotLanded: string[] = [];
    let snapshotCalls = 0;
    let snapshotLanded = false;
    const rpc = vi.fn<Parameters<typeof assembleHistory>[0]>(async (name, params) => {
      if (name.endsWith('_meta')) return structuredClone(data.meta);
      if (!('p_dataset' in params)) throw new Error('expected a page request');
      expect(params).toHaveProperty('p_page_size', 250);
      const dataset = params.p_dataset as 'snapshots' | 'baseline';
      if (!snapshotLanded) startedBeforeSnapshotLanded.push(dataset);
      if (dataset === 'snapshots') {
        snapshotCalls += 1;
        if (snapshotCalls === 1) return firstSnapshot.promise;
        return snapshots.shift();
      }
      baselineStarted.resolve();
      return baseline.shift();
    });

    const result = assembleHistory(rpc, data.filters);
    await baselineStarted.promise;
    const beforeRelease = [...startedBeforeSnapshotLanded];
    snapshotLanded = true;
    firstSnapshot.resolve(snapshots.shift());

    await expect(result).resolves.toEqual(data.expected);
    expect(beforeRelease).toEqual(expect.arrayContaining(['snapshots', 'baseline']));
  });

  it('reads distinct snapshot months concurrently and restores global order', async () => {
    const data = multiMonthFixture();
    const allItems = data.snapshotPages.flatMap((page) =>
      structuredClone(page.items as Record<string, unknown>[]),
    );
    const months = ['2026-11', '2026-12'] as const;
    const queryKeys = { '2026-11': 'a'.repeat(32), '2026-12': 'b'.repeat(32) };
    const shardMeta = Object.fromEntries(
      months.map((month) => {
        const count = allItems.filter((item) =>
          String((item.payload as Record<string, unknown>).flightDate).startsWith(month),
        ).length;
        return [
          month,
          {
            ...structuredClone(data.meta),
            queryKey: queryKeys[month],
            counts: { ...(data.meta.counts as Record<string, unknown>), snapshots: String(count) },
          },
        ];
      }),
    );
    const shardPages = Object.fromEntries(
      months.map((month) => [
        month,
        {
          protocolVersion: 1,
          queryKey: queryKeys[month],
          revision: data.meta.revision,
          dataset: 'snapshots',
          items: allItems.filter((item) =>
            String((item.payload as Record<string, unknown>).flightDate).startsWith(month),
          ),
          nextCursor: null,
        },
      ]),
    );
    const novemberPage = deferred<unknown>();
    const decemberStarted = deferred<void>();
    const baselinePages = data.baselinePages.map((page) => structuredClone(page));
    const rootSnapshotPages = data.snapshotPages.map((page) => structuredClone(page));
    const rpc = vi.fn<Parameters<typeof assembleHistory>[0]>(async (name, params) => {
      const selected = params.p_snapshot_months;
      if (name.endsWith('_meta')) {
        if (selected.length === 1)
          return structuredClone(shardMeta[selected[0] as keyof typeof shardMeta]);
        if ('p_expected_revision' in params) return structuredClone(data.meta);
        return structuredClone(data.meta);
      }
      if ('p_dataset' in params && params.p_dataset === 'baseline') return baselinePages.shift();
      if (selected.length !== 1) {
        decemberStarted.resolve();
        return rootSnapshotPages.shift();
      }
      if (selected[0] === '2026-11') return novemberPage.promise;
      decemberStarted.resolve();
      return structuredClone(shardPages['2026-12']);
    });

    const result = assembleHistory(rpc, data.filters);
    await decemberStarted.promise;
    expect(
      rpc.mock.calls.flatMap(([, params]) =>
        'p_dataset' in params && params.p_dataset === 'snapshots' ? [params.p_snapshot_months] : [],
      ),
    ).toEqual(expect.arrayContaining([['2026-11'], ['2026-12']]));
    novemberPage.resolve(structuredClone(shardPages['2026-11']));

    await expect(result).resolves.toEqual(data.expected);
    expect(rpc).toHaveBeenCalledTimes(7);
    expect(
      rpc.mock.calls
        .filter(([name, params]) => name.endsWith('_meta') && params.p_snapshot_months.length === 1)
        .every(
          ([, params]) =>
            'p_expected_revision' in params && params.p_expected_revision === data.meta.revision,
        ),
    ).toBe(true);
  });

  it('limits monthly snapshot metadata and page streams to three workers', async () => {
    const data = multiMonthFixture();
    const rootMeta = structuredClone(data.meta);
    rootMeta.counts = { snapshots: '4', baseline: '1' };
    const items = data.snapshotPages.flatMap((page) =>
      structuredClone(page.items as Record<string, unknown>[]),
    );
    const months = ['2026-09', '2026-10', '2026-11', '2026-12'];
    const gates = months.map(() => deferred<void>());
    const thirdStarted = deferred<void>();
    const fourthStarted = deferred<void>();
    const baselineStarted = deferred<void>();
    const baselineGate = deferred<void>();
    const started: string[] = [];
    const rpc = vi.fn<Parameters<typeof assembleHistory>[0]>(async (name, params) => {
      const selected = params.p_snapshot_months;
      if (name.endsWith('_meta')) {
        if (selected.length !== 1) return structuredClone(rootMeta);
        const index = months.indexOf(selected[0]);
        started.push(selected[0]);
        if (started.length === 3) thirdStarted.resolve();
        if (started.length === 4) fourthStarted.resolve();
        await gates[index].promise;
        return {
          ...structuredClone(rootMeta),
          queryKey: (index + 10).toString(16).repeat(32),
          counts: { snapshots: '1', baseline: '0' },
        };
      }
      if (!('p_dataset' in params)) throw new Error('unexpected page');
      if (params.p_dataset === 'baseline') {
        baselineStarted.resolve();
        await baselineGate.promise;
        const item = (data.baselinePages[0].items as Record<string, unknown>[])[0];
        return {
          protocolVersion: 1,
          queryKey: rootMeta.queryKey,
          revision: rootMeta.revision,
          dataset: 'baseline',
          items: [structuredClone(item)],
          nextCursor: null,
        };
      }
      const index = months.indexOf(selected[0]);
      return {
        protocolVersion: 1,
        queryKey: (index + 10).toString(16).repeat(32),
        revision: rootMeta.revision,
        dataset: 'snapshots',
        items: [items[index]],
        nextCursor: null,
      };
    });

    const result = assembleHistory(rpc, { ...data.filters, p_snapshot_months: months });
    await Promise.all([thirdStarted.promise, baselineStarted.promise]);
    expect(started).toHaveLength(3);
    gates.slice(0, 3).forEach((gate) => gate.resolve());
    baselineGate.resolve();
    await fourthStarted.promise;
    gates[3].resolve();

    await expect(result).resolves.toMatchObject({
      snapshots: data.expected.snapshots,
      baseline: [data.expected.baseline[0]],
    });
    expect(started).toEqual(months);
  });

  it('cancels sibling month and baseline requests when one shard fails', async () => {
    const data = multiMonthFixture();
    const failureGate = deferred<void>();
    const siblingStarted = deferred<void>();
    const baselineStarted = deferred<void>();
    const pendingSignals: AbortSignal[] = [];
    const pending = (signal: AbortSignal, started: { resolve: () => void }) => {
      pendingSignals.push(signal);
      started.resolve();
      return new Promise<unknown>(() => undefined);
    };
    const rpc = vi.fn<Parameters<typeof assembleHistory>[0]>(async (name, params, signal) => {
      const selected = params.p_snapshot_months;
      if (name.endsWith('_meta')) {
        if (selected.length !== 1) return structuredClone(data.meta);
        if (selected[0] === '2026-11') {
          await failureGate.promise;
          throw new Error('month unavailable');
        }
        return pending(signal, siblingStarted);
      }
      if ('p_dataset' in params && params.p_dataset === 'baseline')
        return pending(signal, baselineStarted);
      throw new Error('unexpected page');
    });

    const result = assembleHistory(rpc, data.filters);
    await Promise.all([siblingStarted.promise, baselineStarted.promise]);
    failureGate.resolve();

    await expect(result).rejects.toThrow('month unavailable');
    expect(pendingSignals).toHaveLength(2);
    expect(pendingSignals.every((signal) => signal.aborted)).toBe(true);
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
    [2, ['items', 0, 'order', 0], '2026-02-30'],
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
    expect(rpc.mock.calls.filter(([name]) => name.endsWith('_meta'))).toHaveLength(1);
    expect(rpc).toHaveBeenCalledTimes(4);
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
