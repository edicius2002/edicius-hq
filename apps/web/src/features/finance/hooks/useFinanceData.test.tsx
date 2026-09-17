import { act, cleanup, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFinanceData } from '@/features/finance/hooks/useFinanceData';
import { createEmptyDocument } from '@/features/finance/lib/document';
import type { FinanceDocument } from '@/features/finance/model/types';
import { WRITE_DELAY_MS } from '@/shared/storage/writeQueue';
import { queryWrapper } from '@/test/queryWrapper';

const remote = vi.hoisted(() => {
  class RevisionConflict extends Error {
    constructor() {
      super('finance_revision_conflict');
      this.name = 'FinanceRevisionConflict';
    }
  }

  return { read: vi.fn(), write: vi.fn(), RevisionConflict };
});

vi.mock('@/features/finance/data/financeDocuments', () => ({
  FinanceRevisionConflict: remote.RevisionConflict,
  readFinanceDocument: remote.read,
  writeFinanceDocument: remote.write,
}));

afterEach(() => {
  // Unmounted before the fake goes: leaving a hook mounted would let its
  // debounce fire into the next test, or into whatever remote behavior follows.
  cleanup();
  remote.read.mockReset();
  remote.write.mockReset();
});

type RemoteWrite = {
  key: string;
  payload: FinanceDocument;
  expectedRevision: number;
};

type RemoteOptions = {
  initial?: FinanceDocument | null;
  revision?: number;
  readFails?: boolean;
};

/** A revisioned Supabase document fake, including the compare-and-swap boundary. */
function stubFinanceDocuments(options: RemoteOptions = {}) {
  let stored = options.initial ? structuredClone(options.initial) : null;
  let revision = options.revision ?? 0;
  const writes: RemoteWrite[] = [];

  remote.read.mockImplementation(async (key: string) => {
    if (key !== 'finance') throw new Error(`Unexpected Finance document key: ${key}`);
    if (options.readFails) throw new Error('Supabase is unavailable');
    return stored
      ? { payload: structuredClone(stored), revision, updatedAt: '2026-09-16T12:00:00.000Z' }
      : null;
  });
  remote.write.mockImplementation(
    async (key: string, payload: FinanceDocument, expectedRevision: number) => {
      if (key !== 'finance') throw new Error(`Unexpected Finance document key: ${key}`);
      if (expectedRevision !== revision) throw new remote.RevisionConflict();

      stored = structuredClone(payload);
      revision += 1;
      writes.push({ key, payload: structuredClone(payload), expectedRevision });
      return { payload: structuredClone(stored), revision, updatedAt: '2026-09-16T12:00:00.000Z' };
    },
  );

  return {
    writes,
    get stored() {
      return stored;
    },
  };
}

const wrapper = queryWrapper();

type Rendered = RenderHookResult<ReturnType<typeof useFinanceData>, unknown>;

async function mounted(): Promise<Rendered> {
  const rendered = renderHook(() => useFinanceData(), { wrapper });
  await waitFor(() => expect(rendered.result.current.isFetching).toBe(false));
  return rendered;
}

async function nodesSettle(rendered: Rendered, count: number): Promise<string[]> {
  await waitFor(() => expect(rendered.result.current.diagram.nodeOrder).toHaveLength(count));
  return rendered.result.current.diagram.nodeOrder;
}

async function written(api: { writes: RemoteWrite[] }, count: number): Promise<void> {
  await waitFor(() => expect(api.writes).toHaveLength(count));
}

/** Waits past the debounce, so "nothing more was written" means it. */
function quiet(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS + 200));
}

describe('useFinanceData', () => {
  it('starts from one empty diagram when Supabase has no Finance row', async () => {
    stubFinanceDocuments();
    const { result } = await mounted();

    expect(result.current.diagram.nodeOrder).toEqual([]);
    expect(result.current.document.diagrams).toHaveLength(1);
  });

  it('writes a node against the revision fetched from Supabase', async () => {
    const api = stubFinanceDocuments({ initial: createEmptyDocument('default'), revision: 7 });
    const rendered = await mounted();

    await act(async () => {
      await rendered.result.current.addAccount({ x: 10, y: 20 });
    });
    await written(api, 1);

    expect(api.writes[0]?.key).toBe('finance');
    expect(api.writes[0]?.expectedRevision).toBe(7);
    expect(api.writes[0]?.payload.diagrams[0]?.nodeOrder).toHaveLength(1);
  });

  it('persists a node and reads it back on a fresh mount', async () => {
    const api = stubFinanceDocuments();
    const first = await mounted();

    await act(async () => {
      await first.result.current.addAccount({ x: 10, y: 20 });
    });
    await written(api, 1);

    const second = await mounted();
    const [id] = await nodesSettle(second, 1);
    expect(second.result.current.diagram.nodes[id].position).toEqual({ x: 10, y: 20 });
  });

  it('does not lose an edit when two are fired back to back', async () => {
    const api = stubFinanceDocuments();
    const rendered = await mounted();

    await act(async () => {
      await Promise.all([
        rendered.result.current.addAccount({ x: 0, y: 0 }),
        rendered.result.current.addJob({ x: 100, y: 100 }),
      ]);
    });

    const order = await nodesSettle(rendered, 2);
    const kinds = order.map((id) => rendered.result.current.diagram.nodes[id].kind).sort();
    expect(kinds).toEqual(['account', 'job']);

    await written(api, 1);
    expect(api.writes.at(-1)?.payload.diagrams[0]?.nodeOrder).toHaveLength(2);
  });

  it('reports a refusal and spends no Supabase write on it', async () => {
    const api = stubFinanceDocuments();
    const rendered = await mounted();

    await act(async () => {
      await rendered.result.current.addAccount({ x: 0, y: 0 });
    });
    const [accountId] = await nodesSettle(rendered, 1);

    await act(async () => {
      await rendered.result.current.addHolding(accountId, 'USD', { x: 0, y: 0 });
    });
    await nodesSettle(rendered, 2);
    await written(api, 1);
    const writesBefore = api.writes.length;

    let refusal: Awaited<ReturnType<typeof rendered.result.current.addHolding>> | undefined;
    await act(async () => {
      refusal = await rendered.result.current.addHolding(accountId, 'USD', { x: 0, y: 0 });
    });

    expect(refusal?.ok).toBe(false);
    expect(refusal?.ok === false && refusal.error.code).toBe('asset-already-held');
    await quiet();
    expect(api.writes).toHaveLength(writesBefore);
  });

  it('judges a refusal against current state, not against what was rendered', async () => {
    stubFinanceDocuments();
    const rendered = await mounted();

    await act(async () => {
      await rendered.result.current.addAccount({ x: 0, y: 0 });
    });
    const [accountId] = await nodesSettle(rendered, 1);

    let outcomes: { ok: boolean }[] = [];
    await act(async () => {
      outcomes = await Promise.all([
        rendered.result.current.addHolding(accountId, 'USD', { x: 0, y: 0 }),
        rendered.result.current.addHolding(accountId, 'USD', { x: 0, y: 0 }),
      ]);
    });

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
    await nodesSettle(rendered, 2); // the account and exactly one holding
  });

  it('refuses to write when the Supabase read failed, rather than saving an empty document', async () => {
    const api = stubFinanceDocuments({ readFails: true });
    const { result } = renderHook(() => useFinanceData(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await expect(result.current.addAccount({ x: 0, y: 0 })).rejects.toThrow(/could not load/i);
    expect(api.writes).toHaveLength(0);
    expect(result.current.saveState).toBe('blocked');
  });

  it('spends one write on a drag, not one per pointer move', async () => {
    const api = stubFinanceDocuments();
    const rendered = await mounted();

    await act(async () => {
      await rendered.result.current.addAccount({ x: 0, y: 0 });
    });
    const [id] = await nodesSettle(rendered, 1);
    await written(api, 1);

    await act(async () => {
      for (let step = 1; step <= 30; step += 1) {
        await rendered.result.current.moveNode(id, { x: step, y: step });
      }
    });

    expect(rendered.result.current.diagram.nodes[id].position).toEqual({ x: 30, y: 30 });
    expect(rendered.result.current.saveState).toBe('pending');
    expect(api.writes).toHaveLength(1);

    await written(api, 2);
    await quiet();
    expect(api.writes).toHaveLength(2);
    expect(api.writes.at(-1)?.payload.diagrams[0]?.nodes[id].position).toEqual({ x: 30, y: 30 });
    expect(rendered.result.current.saveState).toBe('saved');
  });

  it('writes what it is holding when the page goes away', async () => {
    const api = stubFinanceDocuments();
    const rendered = await mounted();

    await act(async () => {
      await rendered.result.current.addAccount({ x: 5, y: 5 });
    });
    expect(api.writes).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });

    await written(api, 1);
    expect(api.writes[0]?.payload.diagrams[0]?.nodeOrder).toHaveLength(1);
  });
});
