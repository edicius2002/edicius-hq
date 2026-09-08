import { useRef, useState } from 'react';

import { apiFetch } from '@/shared/api/http';
import { Button } from '@/shared/ui/Button';

import styles from './RouteTransfer.module.css';

type RouteTransferProps = {
  disabled: boolean;
  onImported: () => void | Promise<void>;
};

type ImportSummary = {
  routesAdded: number;
  routesUpdated: number;
  observationsImported: number;
  observationsSkipped: number;
  invalidRows: number;
};

function importMessage(summary: ImportSummary): string {
  return (
    `${summary.routesAdded} routes added, ${summary.routesUpdated} updated; ` +
    `${summary.observationsImported} observations imported, ${summary.observationsSkipped} skipped; ` +
    `${summary.invalidRows} invalid rows discarded.`
  );
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'detail' in body &&
      typeof body.detail === 'string'
    ) {
      return body.detail;
    }
  } catch {
    // An empty or non-JSON error still gets an actionable message below.
  }
  return fallback;
}

function downloadFilename(response: Response): string {
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return match?.[1] ?? 'airfare-watch.json.gz';
}

/** Transfer the watched-route archive through the authenticated API. */
export function RouteTransfer({ disabled, onImported }: RouteTransferProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setMessage(null);
    setExporting(true);
    try {
      const response = await apiFetch('/api/fares/watch/export');
      if (!response.ok) {
        throw new Error(
          await readError(response, 'Could not export the watched routes. Retry the download.'),
        );
      }
      const url = URL.createObjectURL(await response.blob());
      const link = window.document.createElement('a');
      link.href = url;
      link.download = downloadFilename(response);
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Could not export the watched routes. Retry.',
      );
    } finally {
      setExporting(false);
    }
  }

  async function handleFile(file: File | undefined) {
    setMessage(null);
    if (!file) return;

    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await apiFetch('/api/fares/watch/import', {
        method: 'POST',
        body: form,
      });
      if (!response.ok) {
        throw new Error(
          await readError(
            response,
            'Could not import the watched routes. Check the file and retry.',
          ),
        );
      }
      const summary = (await response.json()) as ImportSummary;
      await onImported();
      setMessage(importMessage(summary));
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Could not import the watched routes. Retry.',
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className={styles.controls}>
      <Button
        size="small"
        disabled={disabled || importing || exporting}
        onClick={() => void handleExport()}
      >
        {exporting ? 'Exporting…' : 'Export'}
      </Button>
      <Button
        size="small"
        disabled={disabled || importing || exporting}
        onClick={() => fileRef.current?.click()}
      >
        {importing ? 'Importing…' : 'Import'}
      </Button>
      <input
        ref={fileRef}
        className={styles.picker}
        type="file"
        accept="application/gzip,application/json,.gz,.json"
        aria-label="Airfare watch file"
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
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
