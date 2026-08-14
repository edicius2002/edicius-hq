import { useMemo, useState, type ChangeEvent } from 'react';

import {
  formatImportPlan,
  importPlanHasChanges,
  planGreenlightImport,
  type ImportPlan,
} from '@/features/greenlight/lib/importPlan';
import { importGreenlightCsv } from '@/features/greenlight/lib/processRows';
import type { DayStats, GreenlightMeta } from '@/features/greenlight/model/types';
import { Button } from '@/shared/ui/Button';
import buttonStyles from '@/shared/ui/Button.module.css';
import { Panel } from '@/shared/ui/Panel';

import styles from './ImportPanel.module.css';

type PendingClear = { kind: 'clear' };
type PendingImport = {
  kind: 'import';
  incoming: Record<string, DayStats>;
};
type Pending = PendingClear | PendingImport | null;

type ImportPanelProps = {
  stats: Record<string, DayStats>;
  meta: GreenlightMeta | null;
  isSyncing?: boolean;
  isImporting: boolean;
  isClearing: boolean;
  hasData: boolean;
  onImport: (file: File) => void;
  onParseError: (message: string | null) => void;
  onClear: () => void;
};

export function ImportPanel({
  stats,
  meta,
  isSyncing = false,
  isImporting,
  isClearing,
  hasData,
  onImport,
  onParseError,
  onClear,
}: ImportPanelProps) {
  const [pending, setPending] = useState<Pending>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const importPlan: ImportPlan | null = useMemo(() => {
    if (pending?.kind !== 'import') return null;
    return planGreenlightImport({
      existing: stats,
      incoming: pending.incoming,
    });
  }, [pending, stats]);

  const status = isSyncing
    ? 'Syncing…'
    : isImporting
      ? 'Importing…'
      : meta?.fileName
        ? meta.fileName
        : null;
  const showDetail = Boolean(meta?.statusDetail) && !isSyncing && !isImporting && pending === null;
  const previewOpen = pending?.kind === 'import';
  const busy = isImporting || isClearing || pending?.kind === 'clear';

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const imported = importGreenlightCsv(await file.text());
      onParseError(null);
      setPendingFile(file);
      setPending({
        kind: 'import',
        incoming: imported.stats,
      });
    } catch (error) {
      setPending(null);
      setPendingFile(null);
      onParseError(error instanceof Error ? error.message : 'Failed to import CSV.');
    }
  }

  function handleClearClick() {
    setPending({ kind: 'clear' });
  }

  function handleConfirm() {
    if (pending?.kind === 'import' && pendingFile && importPlan && importPlanHasChanges(importPlan)) {
      const file = pendingFile;
      setPending(null);
      setPendingFile(null);
      onImport(file);
      return;
    }
    if (pending?.kind === 'clear') {
      setPending(null);
      onClear();
    }
  }

  function handleCancel() {
    setPending(null);
    setPendingFile(null);
  }

  const copy = importPlan ? formatImportPlan(importPlan) : null;
  const canApplyImport = Boolean(importPlan && importPlanHasChanges(importPlan));

  return (
    <Panel aria-labelledby="import-title" className={styles.panel}>
      <div className={styles.row}>
        <h2 id="import-title" className={styles.title}>
          Update from CSV
        </h2>

        {!hasData ? <span className={styles.seedLabel}>Replace all</span> : null}

        <label
          className={`${buttonStyles.button} ${buttonStyles.primary} ${styles.fileButton} ${
            isImporting ? styles.fileDisabled : ''
          }`}
        >
          {isImporting ? 'Importing…' : 'Select CSV'}
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Select CSV"
            disabled={isImporting}
            onChange={(event) => void handleFileChange(event)}
          />
        </label>

        <Button variant="danger" disabled={!hasData || busy || previewOpen} onClick={handleClearClick}>
          Clear
        </Button>

        {status ? <span className={styles.status}>{status}</span> : null}
      </div>

      {hasData ? (
        <p className={styles.modeHint}>
          Rebuilds every week the CSV mentions (Monday–Sunday). Weeks not in the file are left as
          they are.
        </p>
      ) : (
        <p className={styles.modeHint}>
          No stored days yet — this CSV becomes the whole document. After that, imports only rebuild
          the weeks the file mentions, so history the CSV omits cannot be deleted by a partial
          export.
        </p>
      )}

      {pending?.kind === 'import' && copy ? (
        <div
          className={`${styles.confirm} ${importPlan?.removed.length ? styles.confirmDanger : ''}`}
          role="alert"
        >
          {copy.removedLine ? <p className={styles.removed}>{copy.removedLine}.</p> : null}
          <p>{copy.headline}</p>
          {canApplyImport ? (
            <Button variant="danger" onClick={handleConfirm}>
              Replace
            </Button>
          ) : null}
          <Button variant="secondary" onClick={handleCancel}>
            {canApplyImport ? 'Cancel' : 'OK'}
          </Button>
        </div>
      ) : null}

      {pending?.kind === 'clear' ? (
        <div className={styles.confirm} role="alert">
          <p>Clear all Greenlight data? This cannot be undone.</p>
          <Button variant="danger" onClick={handleConfirm}>
            Clear
          </Button>
          <Button variant="secondary" onClick={handleCancel}>
            Cancel
          </Button>
        </div>
      ) : null}

      {showDetail ? <p className={styles.statusDetail}>{meta?.statusDetail}</p> : null}
    </Panel>
  );
}
