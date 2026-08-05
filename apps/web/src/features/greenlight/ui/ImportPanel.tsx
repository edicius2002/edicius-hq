import { type ChangeEvent } from 'react';

import { formatCount } from '@/features/greenlight/lib/format';
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
  const title = isSyncing
    ? 'Syncing…'
    : meta?.statusTitle || (meta ? 'Updated from CSV' : 'Waiting for CSV');
  const detail = isSyncing
    ? 'Loading Greenlight data from local storage.'
    : meta?.statusDetail ||
      (meta
        ? 'Visible totals were computed from the last imported CSV.'
        : 'Import a Greenlight time-records CSV to build the dashboard.');

  return (
    <Panel aria-labelledby="import-title">
      <div className={styles.heading}>
        <div>
          <h2 id="import-title" className={styles.title}>
            Update from CSV
          </h2>
          <p className={styles.subtitle}>
            Upload your time-records file. Choose full replace or current month only; markers are
            kept.
          </p>
        </div>
        <Button variant="danger" disabled={!hasData || isClearing} onClick={onClear}>
          Clear
        </Button>
      </div>

      <div className={styles.grid}>
        <div className={styles.dropzone}>
          <strong>Greenlight CSV</strong>
          <span>Recognized columns: Date/Start, Record Type, Amount, Currency, Notes.</span>
          <span>
            Only Deliverable / Entregable rows are kept; everything else in the file is ignored.
          </span>

          <fieldset className={styles.modes} aria-label="Replace mode">
            <legend>When selecting the CSV</legend>
            <label className={styles.mode}>
              <input
                type="radio"
                name="greenlightReplaceMode"
                value="all"
                checked={replaceMode === 'all'}
                onChange={() => onReplaceModeChange('all')}
              />
              <span>
                <strong>Replace all</strong>
                <small>The uploaded file fully replaces current data</small>
              </span>
            </label>
            <label className={styles.mode}>
              <input
                type="radio"
                name="greenlightReplaceMode"
                value="current-month"
                checked={replaceMode === 'current-month'}
                onChange={() => onReplaceModeChange('current-month')}
              />
              <span>
                <strong>Current month only</strong>
                <small>
                  Only updates dates in the current calendar month; other CSV rows ignored
                </small>
              </span>
            </label>
          </fieldset>

          <label
            className={`${buttonStyles.button} ${buttonStyles.primary} ${styles.fileButton} ${
              isImporting ? styles.fileDisabled : ''
            }`}
          >
            {isImporting ? 'Importing…' : 'Select CSV and replace'}
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={isImporting}
              onChange={onFileChange}
            />
          </label>
        </div>

        <div className={styles.statusCard}>
          <span className={styles.eyebrow}>Status</span>
          <strong className={styles.statusTitle}>{title}</strong>
          <p className={styles.statusDetail}>{detail}</p>
          <dl className={styles.meta}>
            <div>
              <dt>File</dt>
              <dd>{meta?.fileName || '—'}</dd>
            </div>
            <div>
              <dt>Rows read</dt>
              <dd>{formatCount(meta?.rowsRead || 0)}</dd>
            </div>
            <div>
              <dt>Days generated</dt>
              <dd>{formatCount(meta?.daysGenerated || 0)}</dd>
            </div>
            <div>
              <dt>Last update</dt>
              <dd>{meta?.updatedAt ? new Date(meta.updatedAt).toLocaleString() : '—'}</dd>
            </div>
          </dl>
        </div>
      </div>
    </Panel>
  );
}
