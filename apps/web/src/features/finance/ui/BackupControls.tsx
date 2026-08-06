import { useRef, useState } from 'react';

import { backupFilename, createBackup } from '@/features/finance/lib/backup';
import type { FinanceDocument } from '@/features/finance/model/types';
import { Button } from '@/shared/ui/Button';

import styles from './BackupControls.module.css';

type BackupControlsProps = {
  document: FinanceDocument;
  /** Resolves to a message when the file could not be used, or null on success. */
  onRestore: (text: string) => Promise<string | null>;
};

type Pending = { name: string; text: string };

export function BackupControls({ document: financeDocument, onRestore }: BackupControlsProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  function handleExport() {
    setMessage(null);
    const exportedAt = new Date().toISOString();
    const backup = createBackup(financeDocument, exportedAt);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
    );

    const link = window.document.createElement('a');
    link.href = url;
    link.download = backupFilename(exportedAt);
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleFile(file: File | undefined) {
    setMessage(null);
    if (!file) return;
    // Read now, ask after: the file is held in memory, so nothing depends on the
    // picker still being open when the confirmation is answered.
    setPending({ name: file.name, text: await file.text() });
  }

  async function confirmRestore() {
    if (!pending) return;
    setRestoring(true);
    const problem = await onRestore(pending.text);
    setRestoring(false);
    setPending(null);
    setMessage(problem);
  }

  return (
    <div className={styles.controls}>
      {pending ? (
        /*
         * An inline question rather than a browser confirm: restore replaces
         * every diagram and cannot be undone, so it is worth showing which file
         * is about to do it.
         */
        <div className={styles.confirm} role="alert">
          <span className={styles.file} title={pending.name}>
            {pending.name}
          </span>
          <span className={styles.warning}>replaces every diagram</span>
          <Button variant="danger" disabled={restoring} onClick={() => void confirmRestore()}>
            {restoring ? 'Restoring…' : 'Replace'}
          </Button>
          <Button disabled={restoring} onClick={() => setPending(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <Button onClick={handleExport}>Export</Button>
          <Button onClick={() => fileRef.current?.click()}>Import</Button>
        </>
      )}

      <input
        ref={fileRef}
        className={styles.picker}
        type="file"
        accept="application/json,.json"
        aria-label="Backup file"
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
          // Cleared so choosing the same file twice still fires a change.
          event.target.value = '';
        }}
      />

      {message ? (
        <p className={styles.error} role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
