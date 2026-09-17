import { describe, expect, it, vi } from 'vitest';

import {
  FinanceRevisionConflict,
  readFinanceDocument,
  writeFinanceDocument,
} from '@/features/finance/data/financeDocuments';

type FinanceRow = {
  payload: { label: string };
  revision: number;
  updated_at: string;
};

/**
 * The boundary is deliberately given only the two Supabase operations it needs.
 * The chain is permissive about method ordering so these tests assert the
 * contract rather than an incidental fluent-builder detail.
 */
function financeClient(response: { data: FinanceRow | null; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(response);
  const abortSignal = vi.fn();
  const eq = vi.fn();
  const select = vi.fn();
  const from = vi.fn();
  const rpc = vi.fn();
  const query = { select, eq, abortSignal, maybeSingle };

  select.mockReturnValue(query);
  eq.mockReturnValue(query);
  abortSignal.mockReturnValue(query);
  from.mockReturnValue(query);

  return { client: { from, rpc }, from, select, eq, abortSignal, rpc };
}

describe('Finance Supabase documents', () => {
  it('reads only the caller row through RLS and honours cancellation', async () => {
    const row: FinanceRow = {
      payload: { label: 'from Supabase' },
      revision: 7,
      updated_at: '2026-09-16T12:00:00.000Z',
    };
    const api = financeClient({ data: row, error: null });
    const controller = new AbortController();

    await expect(
      readFinanceDocument<{ label: string }>('finance', controller.signal, api.client),
    ).resolves.toEqual({
      payload: { label: 'from Supabase' },
      revision: 7,
      updatedAt: '2026-09-16T12:00:00.000Z',
    });

    expect(api.from).toHaveBeenCalledWith('finance_documents');
    expect(api.select).toHaveBeenCalledWith('payload, revision, updated_at');
    expect(api.eq).toHaveBeenNthCalledWith(1, 'document_key', 'finance');
    expect(api.eq).toHaveBeenCalledTimes(1);
    expect(api.abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it('treats a missing caller row as a revision-zero document', async () => {
    const api = financeClient({ data: null, error: null });

    await expect(
      readFinanceDocument('finance-camera-views', undefined, api.client),
    ).resolves.toBeNull();
    expect(api.eq).toHaveBeenCalledWith('document_key', 'finance-camera-views');
  });

  it('writes through the compare-and-swap RPC and maps its acknowledgement', async () => {
    const document = { label: 'the optimistic value' };
    const api = financeClient({ data: null, error: null });
    api.rpc.mockResolvedValue({
      data: {
        payload: document,
        revision: 8,
        updated_at: '2026-09-16T12:01:00.000Z',
      },
      error: null,
    });

    await expect(writeFinanceDocument('finance', document, 7, api.client)).resolves.toEqual({
      payload: document,
      revision: 8,
      updatedAt: '2026-09-16T12:01:00.000Z',
    });
    expect(api.rpc).toHaveBeenCalledWith('write_finance_document', {
      p_document_key: 'finance',
      p_payload: document,
      p_expected_revision: 7,
    });
  });

  it('turns only the database serialization conflict into the reconciliation error', async () => {
    const api = financeClient({ data: null, error: null });
    api.rpc.mockResolvedValue({
      data: null,
      error: { code: '40001', message: 'finance_revision_conflict' },
    });

    await expect(
      writeFinanceDocument('finance', { label: 'local' }, 7, api.client),
    ).rejects.toBeInstanceOf(FinanceRevisionConflict);
  });

  it('keeps a database error useful without exposing request credentials', async () => {
    const api = financeClient({ data: null, error: null });
    api.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '42501',
        message:
          'The database refused this request. Authorization: Bearer top.secret.token\\nX-Client-Info: client-token-123\\ntoken=also-secret',
      },
    });

    await expect(
      writeFinanceDocument('finance', { label: 'local' }, 7, api.client),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      return (
        message.includes('The database refused this request.') &&
        !/Authorization|Bearer|top\.secret|X-Client-Info|client-token|also-secret|token=/i.test(
          message,
        )
      );
    });
  });
});
