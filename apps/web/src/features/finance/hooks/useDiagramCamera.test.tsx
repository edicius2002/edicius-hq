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

type CameraViews = { version: 1; cameras: Record<string, { x: number; y: number; zoom: number }> };
type CameraRemoteState = {
  isError: boolean;
  saveState: string;
  retrySave: () => void;
  conflict: { status: string } | null;
  refreshConflict: () => Promise<void>;
  acceptRemote: () => void;
  overwriteRemote: () => Promise<void>;
};

function stateOf(value: unknown): CameraRemoteState {
  return value as CameraRemoteState;
}

function cameraDocument(payload: CameraViews, revision: number) {
  return { payload, revision, updatedAt: '2026-09-16T12:00:00.000Z' };
}

function stubCameraDocument() {
  let stored: CameraViews = {
    version: 1,
    cameras: { cash: { x: -120, y: 48, zoom: 1.2 } },
  };
  let revision = 3;
  const writes: { key: string; payload: unknown; expectedRevision: number }[] = [];

  remote.read.mockImplementation(async (key: string) => {
    if (key !== 'finance-camera-views') throw new Error(`Unexpected Finance document key: ${key}`);
    return cameraDocument(structuredClone(stored), revision);
  });
  remote.write.mockImplementation(
    async (key: string, payload: CameraViews, expectedRevision: number) => {
      if (key !== 'finance-camera-views')
        throw new Error(`Unexpected Finance document key: ${key}`);
      if (expectedRevision !== revision) throw new remote.RevisionConflict();

      stored = structuredClone(payload);
      revision += 1;
      writes.push({ key, payload: structuredClone(payload), expectedRevision });
      return cameraDocument(structuredClone(stored), revision);
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

  it('reports an initial camera read failure as blocked and does not try to save the identity view', async () => {
    remote.read.mockRejectedValue(new Error('Supabase is unavailable'));
    const rendered = renderHook(() => useDiagramCamera('cash'), { wrapper: queryWrapper() });

    await waitFor(() => expect(stateOf(rendered.result.current).isError).toBe(true));
    expect(stateOf(rendered.result.current).saveState).toBe('blocked');

    act(() => rendered.result.current.setCamera({ x: 70, y: -25, zoom: 0.8 }));
    expect(remote.write).not.toHaveBeenCalled();
  });

  it('keeps the local camera and accepts the ready Supabase version after a revision conflict', async () => {
    const initial: CameraViews = { version: 1, cameras: { cash: { x: 0, y: 0, zoom: 1 } } };
    const remoteCopy: CameraViews = {
      version: 1,
      cameras: { cash: { x: -300, y: 120, zoom: 1.4 } },
    };
    let reads = 0;
    remote.read.mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? cameraDocument(initial, 3) : cameraDocument(remoteCopy, 4);
    });
    remote.write.mockRejectedValue(new remote.RevisionConflict());
    const rendered = renderHook(() => useDiagramCamera('cash'), { wrapper: queryWrapper() });
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(false));

    act(() => rendered.result.current.setCamera({ x: 70, y: -25, zoom: 0.8 }));
    await act(async () => window.dispatchEvent(new Event('pagehide')));

    await waitFor(() => expect(stateOf(rendered.result.current).conflict?.status).toBe('ready'));
    expect(rendered.result.current.camera).toEqual({ x: 70, y: -25, zoom: 0.8 });
    expect(stateOf(rendered.result.current).saveState).toBe('failed');

    act(() => stateOf(rendered.result.current).acceptRemote());

    await waitFor(() => expect(stateOf(rendered.result.current).conflict).toBeNull());
    expect(rendered.result.current.camera).toEqual({ x: -300, y: 120, zoom: 1.4 });
  });

  it('keeps the local camera and exposes a retry when the conflicting Supabase version cannot load', async () => {
    const initial: CameraViews = { version: 1, cameras: { cash: { x: 0, y: 0, zoom: 1 } } };
    const remoteCopy: CameraViews = {
      version: 1,
      cameras: { cash: { x: -300, y: 120, zoom: 1.4 } },
    };
    let reads = 0;
    let failConflictRead = true;
    remote.read.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return cameraDocument(initial, 3);
      if (failConflictRead) throw new Error('Supabase is unavailable');
      return cameraDocument(remoteCopy, 4);
    });
    remote.write.mockRejectedValue(new remote.RevisionConflict());
    const rendered = renderHook(() => useDiagramCamera('cash'), { wrapper: queryWrapper() });
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(false));

    act(() => rendered.result.current.setCamera({ x: 70, y: -25, zoom: 0.8 }));
    await act(async () => window.dispatchEvent(new Event('pagehide')));

    await waitFor(() =>
      expect(stateOf(rendered.result.current).conflict?.status).toBe('load-failed'),
    );
    expect(rendered.result.current.camera).toEqual({ x: 70, y: -25, zoom: 0.8 });

    failConflictRead = false;
    await act(async () => stateOf(rendered.result.current).refreshConflict());

    await waitFor(() => expect(stateOf(rendered.result.current).conflict?.status).toBe('ready'));
  });
});
