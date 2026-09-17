import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database, Json } from '@/shared/supabase/database.types';
import { supabase } from '@/shared/supabase/client';

export type FinanceDocumentKey = 'finance' | 'finance-camera-views';

export type RemoteDocument<T> = {
  payload: T;
  revision: number;
  updatedAt: string;
};

export type FinanceDocumentsClient = Pick<SupabaseClient<Database>, 'from' | 'rpc'>;

/** The only write error that asks the UI to reconcile two documents. */
export class FinanceRevisionConflict extends Error {
  constructor() {
    super('A newer Finance document is already saved.');
    this.name = 'FinanceRevisionConflict';
  }
}

type FinanceRow = Pick<
  Database['public']['Tables']['finance_documents']['Row'],
  'payload' | 'revision' | 'updated_at'
>;

function mapDocument<T>(row: FinanceRow): RemoteDocument<T> {
  return {
    payload: row.payload as T,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function sanitizedMessage(error: unknown): string {
  const raw =
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
      ? error.message
      : 'Finance document request failed.';

  const message = raw
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-client-info|x-api-key|api[-_]?key|access[-_ ]?token|refresh[-_ ]?token|token)\s*[:=]\s*[^\r\n]*/gi,
      '',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '')
    .replace(
      /\b(?:access[_ -]?token|refresh[_ -]?token|token|apikey|api[_ -]?key)\s*=\s*[^\s,;]+/gi,
      '',
    )
    .replace(/[ \t]*[\r\n]+[ \t]*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return message || 'Finance document request failed.';
}

function requestError(error: unknown): Error {
  return new Error(sanitizedMessage(error));
}

function isRevisionConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '40001';
}

/**
 * Reads the signed-in caller's document. RLS is the ownership boundary, so no
 * owner identifier is ever accepted or sent by this browser module.
 */
export async function readFinanceDocument<T>(
  key: FinanceDocumentKey,
  signal?: AbortSignal,
  client: FinanceDocumentsClient = supabase,
): Promise<RemoteDocument<T> | null> {
  const query = client
    .from('finance_documents')
    .select('payload, revision, updated_at')
    .eq('document_key', key);
  const { data, error } = await (signal ? query.abortSignal(signal) : query).maybeSingle();

  if (error) throw requestError(error);
  return data === null ? null : mapDocument<T>(data);
}

/** Writes one whole document against its acknowledged revision through the CAS RPC. */
export async function writeFinanceDocument<T>(
  key: FinanceDocumentKey,
  payload: T,
  expectedRevision: number,
  client: FinanceDocumentsClient = supabase,
): Promise<RemoteDocument<T>> {
  const { data, error } = await client.rpc('write_finance_document', {
    p_document_key: key,
    p_payload: payload as Json,
    p_expected_revision: expectedRevision,
  });

  if (error) {
    if (isRevisionConflict(error)) throw new FinanceRevisionConflict();
    throw requestError(error);
  }
  if (!data) throw new Error('Finance document write did not return an acknowledgement.');

  return mapDocument<T>(data);
}
