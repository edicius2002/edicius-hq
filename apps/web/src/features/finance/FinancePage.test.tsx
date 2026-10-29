import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FinancePage } from '@/features/finance/FinancePage';
import { createEmptyDocument } from '@/features/finance/lib/document';
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

function remoteDocument<T>(payload: T, revision: number) {
  return { payload, revision, updatedAt: '2026-09-16T12:00:00.000Z' };
}

function stubPageDocuments({ conflictReadFails = false }: { conflictReadFails?: boolean } = {}) {
  const local = createEmptyDocument('default');
  const remoteCopy = createEmptyDocument('default');
  let financeReads = 0;

  remote.read.mockImplementation(async (key: string) => {
    if (key === 'finance-camera-views') return null;
    if (key !== 'finance') throw new Error(`Unexpected Finance document key: ${key}`);
    financeReads += 1;
    if (financeReads === 1) return remoteDocument(local, 7);
    if (conflictReadFails) throw new Error('Supabase is unavailable');
    return remoteDocument(remoteCopy, 8);
  });
  remote.write.mockImplementation(
    async (_key: string, _payload: unknown, expectedRevision: number) => {
      if (expectedRevision === 7) throw new remote.RevisionConflict();
      return remoteDocument(local, 9);
    },
  );
}

function stubCameraConflictDocuments({
  conflictReadFails = false,
}: { conflictReadFails?: boolean } = {}) {
  const finance = createEmptyDocument('default');
  const initial: CameraViews = {
    version: 1,
    cameras: { default: { x: 0, y: 0, zoom: 1 } },
  };
  const remoteCopy: CameraViews = {
    version: 1,
    cameras: { default: { x: -300, y: 120, zoom: 1.4 } },
  };
  let cameraReads = 0;

  remote.read.mockImplementation(async (key: string) => {
    if (key === 'finance') return remoteDocument(finance, 7);
    if (key !== 'finance-camera-views') throw new Error(`Unexpected Finance document key: ${key}`);
    cameraReads += 1;
    if (cameraReads === 1) return remoteDocument(initial, 3);
    if (conflictReadFails) throw new Error('Supabase is unavailable');
    return remoteDocument(remoteCopy, 4);
  });
  remote.write.mockImplementation(
    async (key: string, payload: unknown, expectedRevision: number) => {
      if (key === 'finance-camera-views') {
        if (expectedRevision === 3) throw new remote.RevisionConflict();
        return remoteDocument(payload as CameraViews, 5);
      }
      if (key === 'finance') return remoteDocument(finance, 8);
      throw new Error(`Unexpected Finance document key: ${key}`);
    },
  );
}

function renderPage() {
  return render(<FinancePage />, { wrapper: queryWrapper() });
}

async function createConflict() {
  const addAccount = await screen.findByRole('button', { name: 'Add account' });
  await waitFor(() => expect(addAccount).toBeEnabled());
  fireEvent.click(addAccount);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Pending…'));
  window.dispatchEvent(new Event('pagehide'));
  return screen.findByText(
    "Finance changed in another session. Your unsaved version is still in this tab. Choose the Supabase version or deliberately replace it with this tab's version.",
  );
}

async function createCameraConflict() {
  const addAccount = await screen.findByRole('button', { name: 'Add account' });
  await waitFor(() => expect(addAccount).toBeEnabled());
  fireEvent.wheel(screen.getByRole('region', { name: 'Diagram canvas' }), {
    clientX: 120,
    clientY: 80,
    deltaY: -100,
  });
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Pending…'));
  window.dispatchEvent(new Event('pagehide'));
  return screen.findByText(
    "Diagram view changed in another session. Your unsaved view is still in this tab. Choose the Supabase version or deliberately replace it with this tab's version.",
  );
}

describe('FinancePage', () => {
  it('opens a duplicated diagram with the original camera and saves that view', async () => {
    const sourceCamera = { x: -300, y: 125, zoom: 1.4 };
    remote.read.mockImplementation(async (key: string) =>
      key === 'finance'
        ? remoteDocument(createEmptyDocument('default'), 1)
        : remoteDocument({ version: 1, cameras: { default: sourceCamera } }, 1),
    );
    remote.write.mockImplementation(async (_key: string, payload: unknown) =>
      remoteDocument(payload, 2),
    );

    renderPage();
    const duplicate = await screen.findByRole('button', { name: 'Duplicate Cash flow' });
    await waitFor(() => expect(duplicate).toBeEnabled());
    const canvas = screen.getByRole('region', { name: 'Diagram canvas' });
    const surface = canvas.querySelector<HTMLElement>('div[style*="translate"]');
    fireEvent.wheel(canvas, { clientX: 120, clientY: 80, deltaY: -100 });
    await waitFor(() =>
      expect(surface?.style.transform).not.toBe('translate(-300px, 125px) scale(1.4)'),
    );
    const currentTransform = surface?.style.transform;
    fireEvent.click(duplicate);

    await screen.findByRole('button', { name: 'Cash flow copy' });
    expect(surface?.style.transform).toBe(currentTransform);

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(remote.write).toHaveBeenCalledWith('finance', expect.anything(), 1));
    const financeWrite = remote.write.mock.calls.find(([key]) => key === 'finance')?.[1] as
      ReturnType<typeof createEmptyDocument> | undefined;
    const copyId = financeWrite?.activeDiagramId;
    expect(copyId).toBeTruthy();
    await waitFor(() =>
      expect(
        remote.write.mock.calls.some(
          ([key, payload]) =>
            key === 'finance-camera-views' && Boolean((payload as CameraViews).cameras[copyId!]),
        ),
      ).toBe(true),
    );
    const copiedViews = remote.write.mock.calls.find(
      ([key, payload]) =>
        key === 'finance-camera-views' && Boolean((payload as CameraViews).cameras[copyId!]),
    )?.[1] as CameraViews;
    expect(copiedViews.cameras[copyId!]).toEqual(copiedViews.cameras.default);
  });

  it('adds a job at the center of the current camera view', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    remote.read.mockImplementation(async (key: string) =>
      key === 'finance'
        ? remoteDocument(createEmptyDocument('default'), 1)
        : remoteDocument({ version: 1, cameras: { default: { x: -300, y: -200, zoom: 2 } } }, 1),
    );
    remote.write.mockImplementation(async (_key: string, payload: unknown) =>
      remoteDocument(payload, 2),
    );

    try {
      renderPage();
      const add = await screen.findByRole('button', { name: 'Add job' }, { timeout: 5000 });
      await waitFor(() => expect(add).toBeEnabled(), { timeout: 5000 });
      fireEvent.click(add);

      const node = await screen.findByRole('article', { name: 'Job Job' }, { timeout: 5000 });
      expect(parseFloat(node.style.left) + parseFloat(node.style.width) / 2).toBeCloseTo(350, 0);
      expect(parseFloat(node.style.top) + parseFloat(node.style.height) / 2).toBeCloseTo(250, 0);
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('loads Finance and camera documents in parallel from Supabase', async () => {
    const waiting = new Map<string, (value: unknown) => void>();
    remote.read.mockImplementation(
      (key: string) =>
        new Promise((resolve) => {
          waiting.set(key, resolve);
        }),
    );
    remote.write.mockResolvedValue(undefined);

    renderPage();

    expect(screen.getByRole('status', { name: 'Loading finance' })).toBeInTheDocument();

    await waitFor(() =>
      expect([...waiting.keys()].sort()).toEqual(['finance', 'finance-camera-views']),
    );
    waiting.get('finance')?.(remoteDocument(createEmptyDocument('default'), 7));
    waiting.get('finance-camera-views')?.(null);
    await screen.findByRole('button', { name: 'Add account' });
  });

  it('keeps the page blocked when the initial camera document read fails', async () => {
    remote.read.mockImplementation(async (key: string) => {
      if (key === 'finance') return remoteDocument(createEmptyDocument('default'), 7);
      if (key === 'finance-camera-views') throw new Error('Supabase is unavailable');
      throw new Error(`Unexpected Finance document key: ${key}`);
    });
    remote.write.mockResolvedValue(undefined);
    renderPage();

    expect(await screen.findByText('Could not load the diagram view from Supabase.')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Reload to save');
    expect(screen.getByRole('button', { name: 'Add account' })).toBeDisabled();
    expect(remote.write).not.toHaveBeenCalled();
  });

  it('has no browser backup import or export surface', async () => {
    stubPageDocuments();
    renderPage();

    await screen.findByRole('button', { name: 'Add account' });
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('keeps the local conflict value visible, does not claim Saved, and blocks edits', async () => {
    stubPageDocuments();
    renderPage();

    await createConflict();

    expect(screen.getByRole('article', { name: 'Account Account' })).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add account' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use Supabase version' })).toBeEnabled();
    expect(screen.getByRole('button', { name: "Replace with this tab's version" })).toBeEnabled();
  });

  it('accepts the fetched Supabase version only after the user chooses it', async () => {
    stubPageDocuments();
    renderPage();
    await createConflict();

    fireEvent.click(screen.getByRole('button', { name: 'Use Supabase version' }));

    await waitFor(() =>
      expect(
        screen.queryByText(
          "Finance changed in another session. Your unsaved version is still in this tab. Choose the Supabase version or deliberately replace it with this tab's version.",
        ),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Add account' })).toBeEnabled();
  });

  it('overwrites only against the conflict row revision after the user chooses it', async () => {
    stubPageDocuments();
    renderPage();
    await createConflict();

    fireEvent.click(screen.getByRole('button', { name: "Replace with this tab's version" }));

    await waitFor(() =>
      expect(remote.write).toHaveBeenLastCalledWith('finance', expect.anything(), 8),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('offers a Supabase retry without reconciliation choices when loading a conflict copy fails', async () => {
    stubPageDocuments({ conflictReadFails: true });
    renderPage();
    await createConflict();

    expect(screen.getByRole('button', { name: 'Retry loading Supabase version' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Use Supabase version' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: "Replace with this tab's version" }),
    ).not.toBeInTheDocument();
  });

  it('keeps a camera conflict visible, blocks Finance edits, and offers its ready actions', async () => {
    stubCameraConflictDocuments();
    renderPage();

    await createCameraConflict();

    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add account' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use Supabase view' })).toBeEnabled();
    expect(screen.getByRole('button', { name: "Replace with this tab's view" })).toBeEnabled();
  });

  it('accepts the camera Supabase version only after the user chooses it', async () => {
    stubCameraConflictDocuments();
    renderPage();
    await createCameraConflict();

    fireEvent.click(screen.getByRole('button', { name: 'Use Supabase view' }));

    await waitFor(() =>
      expect(
        screen.queryByText(
          "Diagram view changed in another session. Your unsaved view is still in this tab. Choose the Supabase version or deliberately replace it with this tab's version.",
        ),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Add account' })).toBeEnabled();
  });

  it('overwrites the camera only against the fetched view revision after the user chooses it', async () => {
    stubCameraConflictDocuments();
    renderPage();
    await createCameraConflict();

    fireEvent.click(screen.getByRole('button', { name: "Replace with this tab's view" }));

    await waitFor(() =>
      expect(remote.write).toHaveBeenLastCalledWith('finance-camera-views', expect.anything(), 4),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('retries a failed camera conflict read without offering a destructive choice', async () => {
    stubCameraConflictDocuments({ conflictReadFails: true });
    renderPage();
    await createCameraConflict();

    expect(screen.getByRole('button', { name: 'Retry loading Supabase view' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Use Supabase view' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: "Replace with this tab's view" }),
    ).not.toBeInTheDocument();
  });

  it('does not import the retired browser persistence surfaces from production Finance code', () => {
    const production = import.meta.glob(
      ['./**/*.ts', './**/*.tsx', '!./**/*.test.ts', '!./**/*.test.tsx'],
      {
        eager: true,
        query: '?raw',
        import: 'default',
      },
    );

    for (const [path, source] of Object.entries(production)) {
      expect(source, path).not.toMatch(
        /shared\/(api\/kv|storage\/storage|storage\/useStoredDocument)/,
      );
    }
  });
});
