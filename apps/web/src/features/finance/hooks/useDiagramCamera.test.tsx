import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDiagramCamera } from '@/features/finance/hooks/useDiagramCamera';
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
  cleanup();
  remote.read.mockReset();
  remote.write.mockReset();
});

function stubCameraDocument() {
  let stored: unknown = { version: 1, cameras: { cash: { x: -120, y: 48, zoom: 1.2 } } };
  let revision = 3;
  const writes: { key: string; payload: unknown; expectedRevision: number }[] = [];

  remote.read.mockImplementation(async (key: string) => {
    if (key !== 'finance-camera-views') throw new Error(`Unexpected Finance document key: ${key}`);
    return { payload: structuredClone(stored), revision, updatedAt: '2026-09-16T12:00:00.000Z' };
  });
  remote.write.mockImplementation(
    async (key: string, payload: unknown, expectedRevision: number) => {
      if (key !== 'finance-camera-views')
        throw new Error(`Unexpected Finance document key: ${key}`);
      if (expectedRevision !== revision) throw new remote.RevisionConflict();

      stored = structuredClone(payload);
      revision += 1;
      writes.push({ key, payload: structuredClone(payload), expectedRevision });
      return { payload: structuredClone(stored), revision, updatedAt: '2026-09-16T12:00:00.000Z' };
    },
  );

  return { writes };
}

describe('useDiagramCamera', () => {
  it('restores and saves each view through the finance-camera-views Supabase document', async () => {
    const api = stubCameraDocument();
    const first = renderHook(() => useDiagramCamera('cash'), { wrapper: queryWrapper() });
    await waitFor(() => expect(first.result.current.isFetching).toBe(false));
    expect(first.result.current.camera).toEqual({ x: -120, y: 48, zoom: 1.2 });
    expect(remote.read.mock.calls[0]?.[0]).toBe('finance-camera-views');

    act(() => first.result.current.setCamera({ x: 70, y: -25, zoom: 0.8 }));
    expect(first.result.current.camera).toEqual({ x: 70, y: -25, zoom: 0.8 });

    await act(async () => window.dispatchEvent(new Event('pagehide')));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(api.writes[0]).toMatchObject({ key: 'finance-camera-views', expectedRevision: 3 });
    first.unmount();

    const second = renderHook(() => useDiagramCamera('cash'), { wrapper: queryWrapper() });
    await waitFor(() => expect(second.result.current.isFetching).toBe(false));
    expect(second.result.current.camera).toEqual({ x: 70, y: -25, zoom: 0.8 });
  });
});
