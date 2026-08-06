import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFinanceData } from '@/features/finance/hooks/useFinanceData';
import type { FinanceDocument } from '@/features/finance/model/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Fake KV endpoint. `readFails` breaks the initial GET without blocking writes. */
function stubApi(options: { readFails?: boolean; writeDelayMs?: number } = {}) {
  let stored: unknown = null;
  const writes: FinanceDocument[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';

      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { value: FinanceDocument };
        if (options.writeDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.writeDelayMs));
        }
        stored = body.value;
        writes.push(structuredClone(body.value));
        return Response.json({ key: 'finance', value: body.value });
      }

      if (options.readFails) return Response.json({ detail: 'boom' }, { status: 500 });
      if (stored === null) return Response.json({ detail: 'Key not found' }, { status: 404 });
      return Response.json({ key: 'finance', value: stored });
    }),
  );

  return { writes };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

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

describe('useFinanceData', () => {
  it('starts from an empty diagram when storage has nothing', async () => {
    stubApi();
    const { result } = await mounted();

    expect(result.current.diagram.nodeOrder).toEqual([]);
    expect(result.current.document.diagrams).toHaveLength(1);
  });

  it('persists a node and reads it back on a fresh mount', async () => {
    const api = stubApi();
    const first = await mounted();

    await act(async () => {
      await first.result.current.addAccount({ x: 10, y: 20 });
    });
    expect(api.writes).toHaveLength(1);

    const second = await mounted();
    const [id] = await nodesSettle(second, 1);
    expect(second.result.current.diagram.nodes[id].position).toEqual({ x: 10, y: 20 });
  });

  it('does not lose an edit when two are fired back to back', async () => {
    const api = stubApi({ writeDelayMs: 20 });
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
    // The second write built on the first rather than replacing it.
    expect(api.writes.at(-1)?.diagrams[0].nodeOrder).toHaveLength(2);
  });

  it('reports a refusal and spends no write on it', async () => {
    const api = stubApi();
    const rendered = await mounted();

    await act(async () => {
      await rendered.result.current.addAccount({ x: 0, y: 0 });
    });
    const [accountId] = await nodesSettle(rendered, 1);

    await act(async () => {
      await rendered.result.current.addHolding(accountId, 'USD', { x: 0, y: 0 });
    });
    await nodesSettle(rendered, 2);
    const writesBefore = api.writes.length;

    let refusal: Awaited<ReturnType<typeof rendered.result.current.addHolding>> | undefined;
    await act(async () => {
      refusal = await rendered.result.current.addHolding(accountId, 'USD', { x: 0, y: 0 });
    });

    expect(refusal?.ok).toBe(false);
    expect(refusal?.ok === false && refusal.error.code).toBe('asset-already-held');
    expect(api.writes).toHaveLength(writesBefore);
  });

  it('judges a refusal against current state, not against what was rendered', async () => {
    stubApi();
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
    const api = stubApi({ readFails: true });
    const { result } = renderHook(() => useFinanceData(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await expect(result.current.addAccount({ x: 0, y: 0 })).rejects.toThrow(/could not load/i);
    expect(api.writes).toHaveLength(0);
  });
});
