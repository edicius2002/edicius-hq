import { useState, type ChangeEvent } from 'react';

import { useGreenlightData } from '@/features/greenlight/hooks/useGreenlightData';
import {
  buildMonthGroups,
  buildWeeklySeries,
  computeTotals,
} from '@/features/greenlight/lib/aggregate';
import { formatCount, formatMoney } from '@/features/greenlight/lib/format';
import { MonthWeekList } from '@/features/greenlight/ui/MonthWeekList';
import { WeeklyChart } from '@/features/greenlight/ui/WeeklyChart';
import { Button } from '@/shared/ui/Button';
import buttonStyles from '@/shared/ui/Button.module.css';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';
import { Stat } from '@/shared/ui/Stat';

import styles from './ui/GreenlightPage.module.css';

export function GreenlightPage() {
  const [localError, setLocalError] = useState<string | null>(null);
  const { state, isLoading, isError, importCsv, isImporting, clearData, isClearing } =
    useGreenlightData();

  const totals = computeTotals(state.stats);
  const weekly = buildWeeklySeries(state.stats);
  const months = buildMonthGroups(state.stats);
  const hasData = Object.keys(state.stats).length > 0;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setLocalError(null);
    try {
      const content = await file.text();
      await importCsv({ fileName: file.name, content });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to import CSV.');
    }
  }

  async function handleClear() {
    setLocalError(null);
    await clearData();
  }

  return (
    <section className={styles.page} aria-labelledby="greenlight-title">
      <PageHeader
        title="Greenlight"
        subtitle="CSV weekly analytics for deliverable amounts and tasks."
        titleId="greenlight-title"
        actions={
          <>
            <label
              className={`${buttonStyles.button} ${buttonStyles.primary} ${styles.fileButton} ${
                isImporting ? styles.fileButtonDisabled : ''
              }`}
            >
              {isImporting ? 'Importing…' : 'Import CSV'}
              <input
                type="file"
                accept=".csv,text/csv"
                disabled={isImporting}
                onChange={handleFileChange}
              />
            </label>
            <Button
              variant="danger"
              disabled={!hasData || isClearing}
              onClick={() => void handleClear()}
            >
              Clear data
            </Button>
          </>
        }
      />

      {(localError || isError) && (
        <p className={styles.error} role="alert">
          {localError || 'Could not load Greenlight data from storage.'}
        </p>
      )}

      {isLoading ? (
        <p className={styles.muted}>Loading…</p>
      ) : (
        <>
          <div className={styles.totals}>
            <Stat
              label="Total amount"
              value={formatMoney(totals.amount, totals.currency)}
              tone="accent"
            />
            <Stat label="Delivered tasks" value={formatCount(totals.tasks)} tone="income" />
          </div>

          <Panel aria-labelledby="weekly-title">
            <h2 id="weekly-title" className={styles.panelTitle}>
              By week
            </h2>
            <WeeklyChart points={weekly} />
          </Panel>

          <Panel aria-labelledby="months-title">
            <h2 id="months-title" className={styles.panelTitle}>
              By month
            </h2>
            {months.length ? (
              <MonthWeekList months={months} />
            ) : (
              <p className={styles.muted}>No monthly groups yet.</p>
            )}
          </Panel>

          <Panel aria-labelledby="import-status-title">
            <h2 id="import-status-title" className={styles.panelTitle}>
              Import status
            </h2>
            {state.meta ? (
              <ul className={styles.statusList}>
                <li>File: {state.meta.fileName}</li>
                <li>Rows read: {formatCount(state.meta.rowsRead)}</li>
                <li>Days generated: {formatCount(state.meta.daysGenerated)}</li>
                <li>Updated: {new Date(state.meta.updatedAt).toLocaleString()}</li>
              </ul>
            ) : (
              <p className={styles.muted}>No CSV imported yet.</p>
            )}
          </Panel>
        </>
      )}
    </section>
  );
}
