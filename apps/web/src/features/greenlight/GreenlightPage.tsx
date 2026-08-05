import { useMemo, useState, type ChangeEvent } from 'react';

import { useGreenlightData } from '@/features/greenlight/hooks/useGreenlightData';
import {
  buildMonthGroupsFromWeeks,
  buildMonthlySeries,
  buildWeeklySeries,
  computeTotals,
} from '@/features/greenlight/lib/aggregate';
import { formatCount, formatMoney } from '@/features/greenlight/lib/format';
import { buildSegmentSummaries, dateRangeLabel } from '@/features/greenlight/lib/segments';
import type { ReplaceMode } from '@/features/greenlight/model/types';
import { ImportPanel } from '@/features/greenlight/ui/ImportPanel';
import { MoneyWeekChart } from '@/features/greenlight/ui/MoneyWeekChart';
import { MonthlyChart } from '@/features/greenlight/ui/MonthlyChart';
import { SegmentSummary } from '@/features/greenlight/ui/SegmentSummary';
import { WeeklyChart } from '@/features/greenlight/ui/WeeklyChart';
import { Button } from '@/shared/ui/Button';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';
import { Stat } from '@/shared/ui/Stat';

import styles from './ui/GreenlightPage.module.css';

export function GreenlightPage() {
  const [localError, setLocalError] = useState<string | null>(null);
  const [replaceMode, setReplaceMode] = useState<ReplaceMode>('all');
  const {
    state,
    isFetching,
    isError,
    importCsv,
    isImporting,
    clearData,
    isClearing,
    loadSample,
    isLoadingSample,
    setMarkers,
  } = useGreenlightData();

  const totals = useMemo(() => computeTotals(state.stats), [state.stats]);
  const weekly = useMemo(() => buildWeeklySeries(state.stats), [state.stats]);
  const monthly = useMemo(() => buildMonthlySeries(state.stats), [state.stats]);
  const months = useMemo(() => buildMonthGroupsFromWeeks(weekly), [weekly]);
  const segments = useMemo(
    () => buildSegmentSummaries(state.stats, state.markers),
    [state.stats, state.markers],
  );
  const hasData = Object.keys(state.stats).length > 0;
  const range = useMemo(() => dateRangeLabel(state.stats), [state.stats]);
  const showSyncing = isFetching && !isError;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setLocalError(null);
    try {
      await importCsv({ fileName: file.name, content: await file.text(), replaceMode });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to import CSV.');
    }
  }

  async function handleClear() {
    setLocalError(null);
    await clearData();
  }

  async function handleSample() {
    setLocalError(null);
    await loadSample();
  }

  function handleExport() {
    const blob = new Blob([JSON.stringify(state.stats, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `greenlight-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleToggleMarker(dayKey: string) {
    const next = state.markers.includes(dayKey)
      ? state.markers.filter((day) => day !== dayKey)
      : [...state.markers, dayKey];
    await setMarkers(next);
  }

  async function handleClearMarkers() {
    await setMarkers([]);
  }

  return (
    <section className={styles.page} aria-labelledby="greenlight-title">
      <PageHeader
        title="Greenlight"
        subtitle="Deliverable value and completed tasks."
        titleId="greenlight-title"
        actions={
          <>
            {showSyncing ? <span className={styles.syncing}>Syncing…</span> : null}
            <Button
              variant="secondary"
              disabled={isLoadingSample}
              onClick={() => void handleSample()}
            >
              Load sample
            </Button>
            <Button variant="secondary" disabled={!hasData} onClick={handleExport}>
              Export JSON
            </Button>
          </>
        }
      />

      {(localError || isError) && (
        <p className={styles.error} role="alert">
          {localError || 'Could not load Greenlight data from storage.'}
        </p>
      )}

      <div className={styles.totals}>
        <Stat
          label="Total tasks"
          value={
            <span className={styles.totalStack}>
              <span>{hasData ? formatMoney(totals.amount, totals.currency) : '—'}</span>
              <span className={styles.totalSecondary}>
                <strong>{hasData ? formatCount(totals.tasks) : '—'}</strong> delivered
              </span>
            </span>
          }
          tone="income"
        />
      </div>

      <div className={styles.overview} aria-label="Weekly and monthly overview">
        <Panel className={styles.overviewCard}>
          <div className={styles.panelHeading}>
            <div>
              <h2 className={styles.panelTitle}>By week</h2>
              <p className={styles.panelSubtitle}>Deliverable value across all weeks</p>
            </div>
            <span className={styles.legend}>Tasks</span>
          </div>
          {hasData ? (
            <WeeklyChart points={weekly} />
          ) : (
            <p className={styles.muted}>No weeks to chart yet.</p>
          )}
        </Panel>
        <Panel className={styles.overviewCard}>
          <div className={styles.panelHeading}>
            <div>
              <h2 className={styles.panelTitle}>By month</h2>
              <p className={styles.panelSubtitle}>Monthly deliverable totals</p>
            </div>
            <span className={styles.legend}>Tasks</span>
          </div>
          {hasData ? (
            <MonthlyChart points={monthly} />
          ) : (
            <p className={styles.muted}>No months to chart yet.</p>
          )}
        </Panel>
      </div>

      <Panel aria-labelledby="tasks-title">
        <div className={styles.panelHeading}>
          <h2 id="tasks-title" className={styles.panelTitle}>
            Tasks
          </h2>
          <div className={styles.tasksActions}>
            <span className={styles.range}>{range}</span>
            {state.markers.length > 0 ? (
              <Button variant="secondary" onClick={() => void handleClearMarkers()}>
                Clear markers
              </Button>
            ) : null}
          </div>
        </div>
        {hasData ? (
          <>
            <MoneyWeekChart
              months={months}
              stats={state.stats}
              markers={state.markers}
              onToggleMarker={(day) => void handleToggleMarker(day)}
            />
            <SegmentSummary segments={segments} />
          </>
        ) : (
          <p className={styles.muted}>No tasks to show.</p>
        )}
      </Panel>

      <ImportPanel
        replaceMode={replaceMode}
        onReplaceModeChange={setReplaceMode}
        meta={state.meta}
        isSyncing={showSyncing}
        isImporting={isImporting}
        isClearing={isClearing}
        hasData={hasData}
        onFileChange={(event) => void handleFileChange(event)}
        onClear={() => void handleClear()}
      />
    </section>
  );
}
