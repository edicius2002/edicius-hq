import { act, cleanup, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBackup } from '@/features/finance/lib/backup';
import { useFinanceData } from '@/features/finance/hooks/useFinanceData';
import type { FinanceDocument } from '@/features/finance/model/types';
import { WRITE_DELAY_MS } from '@/shared/storage/writeQueue';
import { stubKvStore, type KvStoreOptions } from '@/test/kvStore';
import { queryWrapper } from '@/test/queryWrapper';

afterEach(() => {
  // Unmounted before the stub goes: leaving a hook mounted would let its
  // debounce fire into the next test, or into whatever `fetch` is by then.
  cleanup();
  vi.unstubAllGlobals();
});

/** The Finance document's KV endpoint. It starts empty: a first visit gets a 404. */
const stubStore = (options: Omit<KvStoreOptions<FinanceDocument>, 'key'> = {}) =>
  stubKvStore<FinanceDocument>({ key: 'finance', ...options });

const wrapper = queryWrapper();

type Rendered = RenderHookResult<ReturnType<typeof useFinanceData>, unknown>;

async function mounted(): Promise<Rendered> {
  const rendered = renderHook(() => useFinanceData(), { wrapper });
  await waitFor(() => expect(rendered.result.current.isFetching).toBe(false));
  return rendered;
}

/**
 * React Query notifies its observers asynchronously, so rendered state can lag a
 * finished write by a tick. Assertions on what is on screen wait for it.
 */
async function nodesSettle(rendered: Rendered, count: number): Promise<string[]> {
  await waitFor(() => expect(rendered.result.current.diagram.nodeOrder).toHaveLength(count));
  return rendered.result.current.diagram.nodeOrder;
}

/**
 * Writes now leave on a trailing debounce, so an edit is in the cache long
 * before it is on the wire. Nothing waits on a write except the assertions.
 */
async function written(api: { writes: FinanceDocument[] }, count: number): Promise<void> {
  await waitFor(() => expect(api.writes).toHaveLength(count));
}

/** Waits past the debounce, so "nothing more was written" means it. */
function quiet(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS + 200));
}

describe('useFinanceData', () => {
  it('starts from an empty diagram when storage has nothing', async () => {
    stubStore();
    const { result } = await mounted();

    expect(result.current.diagram.nodeOrder).toEqual([]);
    expect(result.current.document.diagrams).toHaveLength(1);
  });

  it('persists a node and reads it back on a fresh mount', async () => {
    const api = stubStore();
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
    const api = stubStore({ writeDelayMs: 20 });
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

    // The second edit built on the first rather than replacing it, and the two
    // reach storage as one write because neither waited for the other's.
    await written(api, 1);
    expect(api.writes.at(-1)?.diagrams[0].nodeOrder).toHaveLength(2);
  });

  it('reports a refusal and spends no write on it', async () => {
    const api = stubStore();
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
    stubStore();
    const rendered = await mounted();

    await act(async () => {
      await rendered.result.current.addAccount({ x: 0, y: 0 });
    });
    const [accountId] = await nodesSettle(rendered, 1);

    // Both are fired from a render where the asset is still free, so the second
    // can only be refused if it is re-checked against the first one's result.
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

  it('refuses to write when the read failed, rather than saving an empty document', async () => {
    const api = stubStore({ readFails: true });
    const { result } = renderHook(() => useFinanceData(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await expect(result.current.addAccount({ x: 0, y: 0 })).rejects.toThrow(/could not load/i);
    expect(api.writes).toHaveLength(0);
    // Reloading is the remedy, not retrying, so the status says so.
    expect(result.current.saveState).toBe('blocked');
  });

  it('spends one write on a drag, not one per pointer move', async () => {
    const api = stubStore();
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

    // The node is already where the drag left it while nothing has been sent:
    // this is the whole point, since its rendered position used to come back
    // from the network.
    expect(rendered.result.current.diagram.nodes[id].position).toEqual({ x: 30, y: 30 });
    expect(rendered.result.current.saveState).toBe('pending');
    expect(api.writes).toHaveLength(1);

    await written(api, 2);
    await quiet();
    expect(api.writes).toHaveLength(2);
    expect(api.writes.at(-1)?.diagrams[0].nodes[id].position).toEqual({ x: 30, y: 30 });
    expect(rendered.result.current.saveState).toBe('saved');
  });

  it('writes what it is holding when the page goes away', async () => {
    const api = stubStore();
    const rendered = await mounted();

    await act(async () => {
      await rendered.result.current.addAccount({ x: 5, y: 5 });
    });
    // Held, not sent: closing the tab now is what would have lost it.
    expect(api.writes).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });

    // No timer was advanced, so this write can only have come from the flush.
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0].diagrams[0].nodeOrder).toHaveLength(1);
  });

  it('does not let an edit queued before a restore undo it', async () => {
    const api = stubStore();
    const rendered = await mounted();

    await act(async () => {
      await rendered.result.current.addAccount({ x: 0, y: 0 });
    });
    const [id] = await nodesSettle(rendered, 1);
    await written(api, 1);

    const backup = createBackup(
      { ...rendered.result.current.document, diagrams: [] },
      '2026-08-07T00:00:00.000Z',
    );

    await act(async () => {
      // Still inside the debounce window when the restore lands.
      await rendered.result.current.moveNode(id, { x: 999, y: 999 });
      await rendered.result.current.restore(JSON.stringify(backup));
    });

    await quiet();
    // The dragged position is nowhere in storage: the held write was superseded
    // rather than sent after the replacement.
    expect(api.writes).toHaveLength(2);
    expect(api.writes.at(-1)?.diagrams[0].nodeOrder).toEqual([]);
    expect(rendered.result.current.diagram.nodeOrder).toEqual([]);
  });

  it('keeps undo history when a backup replacement fails to persist', async () => {
    const api = stubStore({ failPutAt: 2 });
    const rendered = await mounted();

    await act(async () => {
      await rendered.result.current.addAccount({ x: 0, y: 0 });
    });
    await written(api, 1);
    expect(rendered.result.current.canUndo).toBe(true);

    const backup = createBackup(
      { ...rendered.result.current.document, diagrams: [] },
      '2026-08-07T00:00:00.000Z',
    );
    await expect(rendered.result.current.restore(JSON.stringify(backup))).rejects.toThrow();

    expect(rendered.result.current.canUndo).toBe(true);
  });
});
