import type { SupabaseClient } from '@supabase/supabase-js';

import type { StorageKey } from '@/shared/storage/keys';
import { supabase } from '@/shared/supabase/client';
import type { Database, Json } from '@/shared/supabase/database.types';

export type RemoteDocument<T> = {
  key: StorageKey;
  payload: T;
  revision: number;
  updatedAt: string;
};

export type AppDocumentsClient = Pick<SupabaseClient<Database>, 'from' | 'rpc'>;

/** A write lost a compare-and-swap race and must be reconciled before retrying. */
export class RemoteDocumentConflict extends Error {
  constructor() {
    super('A newer document revision is already saved.');
    this.name = 'RemoteDocumentConflict';
  }
}

type AppDocumentRow = Pick<
  Database['public']['Tables']['app_documents']['Row'],
  'document_key' | 'payload' | 'revision' | 'updated_at'
>;

function fromRow<T>(row: AppDocumentRow): RemoteDocument<T> {
  return {
    key: row.document_key as StorageKey,
    payload: row.payload as T,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (('code' in error && error.code === 'PT409') || ('status' in error && error.status === 409))
  );
}

function mapStorageError(error: unknown): Error {
  if (isConflict(error)) return new RemoteDocumentConflict();
  return new Error('Application document request failed.');
}

/** Reads the signed-in owner's document; RLS supplies the ownership boundary. */
export async function readRemoteDocument<T>(
  key: StorageKey,
  signal?: AbortSignal,
  client: AppDocumentsClient = supabase,
): Promise<RemoteDocument<T> | null> {
  const query = client
    .from('app_documents')
    .select('document_key, payload, revision, updated_at')
    .eq('document_key', key);
  const { data, error } = await (signal ? query.abortSignal(signal) : query).maybeSingle();
  if (error) throw mapStorageError(error);
  return data === null ? null : fromRow<T>(data);
}

/** Writes a whole document through the owner-scoped revision RPC. */
export async function writeRemoteDocument<T>(
  key: StorageKey,
  payload: T,
  expectedRevision: number,
  client: AppDocumentsClient = supabase,
): Promise<RemoteDocument<T>> {
  const { data, error } = await client.rpc('write_app_document', {
    p_document_key: key,
    p_payload: payload as Json,
    p_expected_revision: expectedRevision,
  });
  if (error) throw mapStorageError(error);
  if (!data) throw new Error('Application document write did not return an acknowledgement.');
  return fromRow<T>(data);
}

/** Deletes a whole document through the owner-scoped revision RPC. */
export async function deleteRemoteDocument(
  key: StorageKey,
  expectedRevision: number,
  client: AppDocumentsClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('delete_app_document', {
    p_document_key: key,
    p_expected_revision: expectedRevision,
  });
  if (error) throw mapStorageError(error);
}
