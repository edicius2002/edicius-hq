import { type ChangeEvent } from 'react';

import type { GreenlightMeta, ReplaceMode } from '@/features/greenlight/model/types';
import { Button } from '@/shared/ui/Button';
import buttonStyles from '@/shared/ui/Button.module.css';
import { Panel } from '@/shared/ui/Panel';

import styles from './ImportPanel.module.css';

type ImportPanelProps = {
  replaceMode: ReplaceMode;
  onReplaceModeChange: (mode: ReplaceMode) => void;
  meta: GreenlightMeta | null;
  isSyncing?: boolean;
  isImporting: boolean;
  isClearing: boolean;
  hasData: boolean;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
};

export function ImportPanel({
  replaceMode,
  onReplaceModeChange,
  meta,
  isSyncing = false,
  isImporting,
  isClearing,
  hasData,
  onFileChange,
  onClear,
}: ImportPanelProps) {
  const status = isSyncing
    ? 'Syncing…'
    : isImporting
      ? 'Importing…'
      : meta?.fileName
        ? meta.fileName
        : null;

  return (
    <Panel aria-labelledby="import-title" className={styles.panel}>
      <div className={styles.row}>
        <h2 id="import-title" className={styles.title}>
          Update from CSV
        </h2>

        <fieldset className={styles.modes} aria-label="Replace mode">
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
          <label className={styles.mode}>
            <input
              type="radio"
              name="greenlightReplaceMode"
              value="current-month"
              checked={replaceMode === 'current-month'}
              onChange={() => onReplaceModeChange('current-month')}
            />
            <span>Current month only</span>
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
            disabled={isImporting}
            onChange={onFileChange}
          />
        </label>

        <Button variant="danger" disabled={!hasData || isClearing} onClick={onClear}>
          Clear
        </Button>

        {status ? <span className={styles.status}>{status}</span> : null}
      </div>
    </Panel>
  );
}
