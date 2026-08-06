import { normalizeDocument } from '@/features/finance/lib/document';
import { err, ok, type Result } from '@/features/finance/lib/result';
import type { DiagramId, FinanceDocument } from '@/features/finance/model/types';

export const BACKUP_APP = 'edicius-hq';
export const BACKUP_KIND = 'finance';
export const BACKUP_VERSION = 1;

/**
 * What gets written to the file. The envelope exists so a file can say what it
 * is; the document inside is exactly what storage holds, with no second shape to
 * keep in step.
 */
export type FinanceBackup = {
  app: string;
  kind: string;
  version: number;
  exportedAt: string;
  document: FinanceDocument;
};

export function createBackup(document: FinanceDocument, exportedAt: string): FinanceBackup {
  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt,
    document,
  };
}

/** `finance-backup-2026-08-06.json` — sorts by date and says what it is. */
export function backupFilename(exportedAt: string): string {
  const day = exportedAt.slice(0, 10);
  return `finance-backup-${/^\d{4}-\d{2}-\d{2}$/.test(day) ? day : 'unknown'}.json`;
}

export type RestoreError = { code: 'unreadable' } | { code: 'not-a-backup' };

export function describeRestoreError(error: RestoreError): string {
  return error.code === 'unreadable'
    ? 'That file is not JSON, so there was nothing to read.'
    : 'That file is not a Finance backup. Nothing was changed.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasDiagrams(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.diagrams);
}

/**
 * Find the document inside a parsed file. A file we wrote keeps it under
 * `document`; a bare document is taken too, since that is the shape storage
 * itself holds and one will eventually be handed over.
 *
 * This runs *before* `normalizeDocument` on purpose. That parser turns anything
 * unusable into an empty document, which is right for storage and wrong here:
 * without this check, importing a holiday photo would succeed and quietly
 * replace every diagram with nothing.
 */
function pickDocument(parsed: unknown): unknown | null {
  if (!isRecord(parsed)) return null;
  if (hasDiagrams(parsed.document)) return parsed.document;
  if (hasDiagrams(parsed)) return parsed;
  return null;
}

/**
 * Read a backup file. Once it is established that this really is one, the
 * contents go through the same guard storage uses, so a file is trusted no
 * further than a value off the wire: a damaged diagram inside is repaired or
 * dropped rather than failing the whole restore.
 */
export function readBackup(
  text: string,
  fallbackId: DiagramId,
): Result<FinanceDocument, RestoreError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err({ code: 'unreadable' });
  }

  const source = pickDocument(parsed);
  if (!source) return err({ code: 'not-a-backup' });

  return ok(normalizeDocument(source, fallbackId));
}
