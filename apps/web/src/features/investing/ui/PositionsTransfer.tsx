import { useRef, useState } from 'react';

import {
  createPositionsFile,
  describePositionsFileError,
  positionsFilename,
  readPositionsFile,
  type PositionsMerge,
} from '@/features/investing/lib/positionsFile';
import type { Portfolio, Position } from '@/features/investing/data/portfolio';
import { Button } from '@/shared/ui/Button';

import styles from './PositionsTransfer.module.css';

type PositionsTransferProps = {
  portfolio: Portfolio;
  disabled: boolean;
  onImport: (positions: Position[]) => Promise<Pick<PositionsMerge, 'added' | 'updated'>>;
};

export function PositionsTransfer({ portfolio, disabled, onImport }: PositionsTransferProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  function handleExport() {
    setMessage(null);
    const exportedAt = new Date().toISOString();
    const file = createPositionsFile(portfolio, exportedAt);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
    );
    const link = window.document.createElement('a');
    link.href = url;
    link.download = positionsFilename(exportedAt);
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleFile(file: File | undefined) {
    setMessage(null);
    if (!file) return;

    const parsed = readPositionsFile(await file.text());
    if (!parsed.ok) {
      setMessage(describePositionsFileError(parsed.error));
      return;
    }

    setImporting(true);
    try {
      const summary = await onImport(parsed.value.positions);
      const discarded = parsed.value.discarded;
      setMessage(
        `${summary.added + summary.updated} positions imported, ${summary.updated} updated` +
          (discarded === 0 ? '.' : `; ${discarded} invalid rows discarded.`),
      );
    } catch {
      setMessage('Could not save the imported positions. Retry saving before leaving this page.');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className={styles.controls}>
      <Button size="small" disabled={disabled || importing} onClick={handleExport}>
        Export
      </Button>
      <Button
        size="small"
        disabled={disabled || importing}
        onClick={() => fileRef.current?.click()}
      >
        {importing ? 'Importing…' : 'Import'}
      </Button>
      <input
        ref={fileRef}
        className={styles.picker}
        type="file"
        accept="application/json,.json"
        aria-label="Positions file"
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
          // Clearing lets a corrected version of the same file be selected again.
          event.target.value = '';
        }}
      />
      {message ? (
        <p className={styles.message} role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
