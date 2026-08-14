import { useMemo, useState, type ChangeEvent } from 'react';

import {
  formatImportPlan,
  importPlanHasChanges,
  planGreenlightImport,
  type ImportPlan,
} from '@/features/greenlight/lib/importPlan';
import { importGreenlightCsv } from '@/features/greenlight/lib/processRows';
import type { DayStats, GreenlightMeta, ReplaceMode } from '@/features/greenlight/model/types';
import { Button } from '@/shared/ui/Button';
import buttonStyles from '@/shared/ui/Button.module.css';
import { Panel } from '@/shared/ui/Panel';

import styles from './ImportPanel.module.css';

type PendingClear = { kind: 'clear' };
type PendingImport = {
  kind: 'import';
  fileName: string;
  incoming: Record<string, DayStats>;
};
type Pending = PendingClear | PendingImport | null;

type ImportPanelProps = {
  replaceMode: ReplaceMode;
  onReplaceModeChange: (mode: ReplaceMode) => void;
  /** Clock month, e.g. "August 2026" — same instant as current-month replace. */
  replaceMonthLabel: string;
  /** Clock month key `YYYY-MM`, so a preview can freeze the same month the persist uses. */
  monthKey: string;
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
  replaceMode,
  onReplaceModeChange,
  replaceMonthLabel,
  monthKey,
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
      replaceMode,
      monthKey,
    });
  }, [pending, stats, replaceMode, monthKey]);

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
        fileName: file.name,
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

        <fieldset className={styles.modes} aria-label="Replace mode" disabled={busy}>
          <label className={styles.mode}>
            <input
              type="radio"
              name="greenlightReplaceMode"
              value="all"
              checked={replaceMode === 'all'}
              onChange={() => onReplaceModeChange('all')}
            />
            <span>Replace all</span>
          </label>
          <label
            className={styles.mode}
            title={`Replaces ${replaceMonthLabel} entirely: days in that month missing from the CSV are removed. Other months are kept.`}
          >
            <input
              type="radio"
              name="greenlightReplaceMode"
              value="current-month"
              checked={replaceMode === 'current-month'}
              onChange={() => onReplaceModeChange('current-month')}
            />
            <span>Replace {replaceMonthLabel} only</span>
          </label>
        </fieldset>

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

      {replaceMode === 'current-month' ? (
        <p className={styles.modeHint}>
          Replaces {replaceMonthLabel} entirely — days missing from the CSV are removed. Other
          months are kept.
        </p>
      ) : (
        <p className={styles.modeHint}>Replaces every stored day with this CSV.</p>
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
