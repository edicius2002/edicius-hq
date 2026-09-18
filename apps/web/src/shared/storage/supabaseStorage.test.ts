import { afterEach, describe, expect, it, vi } from 'vitest';

const { rpc, maybeSingle, abortSignal, eq, select, from } = vi.hoisted(() => {
  const mockedMaybeSingle = vi.fn();
  const mockedAbortSignal = vi.fn(() => ({ maybeSingle: mockedMaybeSingle }));
  const mockedEq = vi.fn(() => ({
    abortSignal: mockedAbortSignal,
    maybeSingle: mockedMaybeSingle,
  }));
  const mockedSelect = vi.fn(() => ({ eq: mockedEq }));
  const mockedFrom = vi.fn(() => ({ select: mockedSelect }));
  return {
    rpc: vi.fn(),
    maybeSingle: mockedMaybeSingle,
    abortSignal: mockedAbortSignal,
    eq: mockedEq,
    select: mockedSelect,
    from: mockedFrom,
  };
});

vi.mock('@/shared/supabase/client', () => ({ supabase: { from, rpc } }));

import {
  deleteRemoteDocument,
  RemoteDocumentConflict,
  readRemoteDocument,
  writeRemoteDocument,
} from '@/shared/storage/supabaseStorage';

afterEach(() => {
  vi.clearAllMocks();
});

describe('Supabase application documents', () => {
  it('returns null for a missing document', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(readRemoteDocument('watchlist')).resolves.toBeNull();
    expect(from).toHaveBeenCalledWith('app_documents');
    expect(select).toHaveBeenCalledWith('document_key, payload, revision, updated_at');
    expect(eq).toHaveBeenCalledWith('document_key', 'watchlist');
  });

  it('passes an AbortSignal to the document query', async () => {
    const signal = new AbortController().signal;
    maybeSingle.mockResolvedValue({ data: null, error: null });

    await readRemoteDocument('watchlist', signal);

    expect(abortSignal).toHaveBeenCalledWith(signal);
  });

  it('writes through the revision RPC and returns the next revision', async () => {
    rpc.mockResolvedValue({
      data: {
        document_key: 'watchlist',
        payload: { version: 1 },
        revision: 2,
        updated_at: '2026-09-17T00:00:00.000Z',
      },
      error: null,
    });

    await expect(writeRemoteDocument('watchlist', { version: 1 }, 1)).resolves.toMatchObject({
      key: 'watchlist',
      revision: 2,
    });
    expect(rpc).toHaveBeenCalledWith('write_app_document', {
      p_document_key: 'watchlist',
      p_payload: { version: 1 },
      p_expected_revision: 1,
    });
  });

  it('maps HTTP 409 revision conflicts to a recoverable error', async () => {
    rpc.mockResolvedValue({ data: null, error: { status: 409, message: 'conflict' } });

    await expect(writeRemoteDocument('watchlist', { version: 2 }, 1)).rejects.toBeInstanceOf(
      RemoteDocumentConflict,
    );
  });

  it('removes through the revision RPC', async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    await expect(deleteRemoteDocument('watchlist', 2)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('delete_app_document', {
      p_document_key: 'watchlist',
      p_expected_revision: 2,
    });
  });
});
