import { useMemo, useState, type ChangeEvent } from 'react';

import {
  formatImportPlan,
  importPlanHasChanges,
  planGreenlightImport,
  type ImportPlan,
} from '@/features/greenlight/lib/importPlan';
import { importGreenlightCsv } from '@/features/greenlight/lib/processRows';
import type { DayStats } from '@/features/greenlight/model/types';
import { Button } from '@/shared/ui/Button';
import buttonStyles from '@/shared/ui/Button.module.css';

import styles from './ImportPanel.module.css';

type PendingImport = {
  kind: 'import';
  incoming: Record<string, DayStats>;
};
type Pending = PendingImport | null;

type ImportPanelProps = {
  stats: Record<string, DayStats>;
  isImporting: boolean;
  onImport: (file: File) => void;
  onParseError: (message: string | null) => void;
};

export function ImportPanel({ stats, isImporting, onImport, onParseError }: ImportPanelProps) {
  const [pending, setPending] = useState<Pending>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const importPlan: ImportPlan | null = useMemo(() => {
    if (pending?.kind !== 'import') return null;
    return planGreenlightImport({
      existing: stats,
      incoming: pending.incoming,
    });
  }, [pending, stats]);

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

  function handleConfirm() {
    if (
      pending?.kind === 'import' &&
      pendingFile &&
      importPlan &&
      importPlanHasChanges(importPlan)
    ) {
      const file = pendingFile;
      setPending(null);
      setPendingFile(null);
      onImport(file);
      return;
    }
  }

  function handleCancel() {
    setPending(null);
    setPendingFile(null);
  }

  const copy = importPlan ? formatImportPlan(importPlan) : null;
  const canApplyImport = Boolean(importPlan && importPlanHasChanges(importPlan));

  return (
    <div className={styles.importPanel}>
      <div className={styles.row}>
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
      </div>

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
    </div>
  );
}
