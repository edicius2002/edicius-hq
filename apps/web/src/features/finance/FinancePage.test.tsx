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
    ) as Record<string, string>;

    for (const [path, source] of Object.entries(production)) {
      expect(source, path).not.toMatch(
        /shared\/(api\/kv|storage\/storage|storage\/useStoredDocument)/,
      );
    }
  });
});
