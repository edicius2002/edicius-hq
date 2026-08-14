import { useState, type ChangeEvent } from 'react';

import type { GreenlightMeta, ReplaceMode } from '@/features/greenlight/model/types';
import { Button } from '@/shared/ui/Button';
import buttonStyles from '@/shared/ui/Button.module.css';
import { Panel } from '@/shared/ui/Panel';

import styles from './ImportPanel.module.css';

type PendingClear = { kind: 'clear' };
type PendingReplaceAll = { kind: 'replace-all'; file: File };
type Pending = PendingClear | PendingReplaceAll | null;

type ImportPanelProps = {
  replaceMode: ReplaceMode;
  onReplaceModeChange: (mode: ReplaceMode) => void;
  /** Clock month, e.g. "August 2026" — same instant as current-month replace. */
  replaceMonthLabel: string;
  meta: GreenlightMeta | null;
  isSyncing?: boolean;
  isImporting: boolean;
  isClearing: boolean;
  hasData: boolean;
  onImport: (file: File) => void;
  onClear: () => void;
};

export function ImportPanel({
  replaceMode,
  onReplaceModeChange,
  replaceMonthLabel,
  meta,
  isSyncing = false,
  isImporting,
  isClearing,
  hasData,
  onImport,
  onClear,
}: ImportPanelProps) {
  const [pending, setPending] = useState<Pending>(null);

  const status = isSyncing
    ? 'Syncing…'
    : isImporting
      ? 'Importing…'
      : meta?.fileName
        ? meta.fileName
        : null;
  const showDetail = Boolean(meta?.statusDetail) && !isSyncing && !isImporting && pending === null;
  const busy = isImporting || isClearing || pending !== null;

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (replaceMode === 'all') {
      setPending({ kind: 'replace-all', file });
      return;
    }

    onImport(file);
  }

  function handleClearClick() {
    setPending({ kind: 'clear' });
  }

  function handleConfirm() {
    if (pending?.kind === 'replace-all') {
      const file = pending.file;
      setPending(null);
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
  }

  const confirmMessage =
    pending?.kind === 'replace-all'
      ? `Replace all Greenlight data with ${pending.file.name}? Existing days not in the file will be lost.`
      : pending?.kind === 'clear'
        ? 'Clear all Greenlight data? This cannot be undone.'
        : null;

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
            isImporting || pending !== null ? styles.fileDisabled : ''
          }`}
        >
          {isImporting ? 'Importing…' : 'Select CSV'}
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Select CSV"
            disabled={isImporting || pending !== null}
            onChange={handleFileChange}
          />
        </label>

        <Button variant="danger" disabled={!hasData || busy} onClick={handleClearClick}>
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

      {pending && confirmMessage ? (
        <div className={styles.confirm} role="alert">
          <p>{confirmMessage}</p>
          <Button variant="danger" onClick={handleConfirm}>
            {pending.kind === 'clear' ? 'Clear' : 'Replace'}
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
