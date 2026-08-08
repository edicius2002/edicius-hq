import { useMemo, useState, type ChangeEvent } from 'react';

import { useGreenlightData } from '@/features/greenlight/hooks/useGreenlightData';
import {
  buildMonthGroupsFromWeeks,
  buildMonthlySeries,
  buildWeeklySeries,
  computeTotals,
} from '@/features/greenlight/lib/aggregate';
import { formatMoney } from '@/shared/lib/money';
import {
  buildSegmentSummaries,
  computeSegmentedTotals,
  dateRangeLabel,
} from '@/features/greenlight/lib/segments';
import type { ReplaceMode, ToolId } from '@/features/greenlight/model/types';
import { ImportPanel } from '@/features/greenlight/ui/ImportPanel';
import { MoneyWeekChart } from '@/features/greenlight/ui/MoneyWeekChart';
import { MonthlyChart } from '@/features/greenlight/ui/MonthlyChart';
import { SegmentSummary } from '@/features/greenlight/ui/SegmentSummary';
import { WeeklyChart } from '@/features/greenlight/ui/WeeklyChart';
import { Button } from '@/shared/ui/Button';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';
import { SaveStatus } from '@/shared/ui/SaveStatus';
import { Stat } from '@/shared/ui/Stat';

import styles from './ui/GreenlightPage.module.css';

export function GreenlightPage() {
  const [localError, setLocalError] = useState<string | null>(null);
  const [replaceMode, setReplaceMode] = useState<ReplaceMode>('all');
  const {
    state,
    isFetching,
    isError,
    saveState,
    retrySave,
    importCsv,
    isImporting,
    clearData,
    isClearing,
    toggleMarker,
    clearMarkers,
    toggleWidget,
  } = useGreenlightData();

  const totals = useMemo(() => computeTotals(state.stats), [state.stats]);
  // Charged per marker period, so the headline figures match the segment cards.
  const moneyBreakdown = useMemo(
    () => computeSegmentedTotals(state.stats, state.markers),
    [state.stats, state.markers],
  );
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
      const message = error instanceof Error ? error.message : 'Failed to import CSV.';
      if (/failed to fetch|networkerror|abort/i.test(message)) {
        setLocalError(
          'Could not reach the API (http://localhost:8000). Start it with `npm run api:dev` or `docker compose up`, then try again.',
        );
        return;
      }
      setLocalError(message);
    }
  }

  async function handleClear() {
    setLocalError(null);
    await clearData();
  }

  async function handleToggleMarker(dayKey: string) {
    setLocalError(null);
    try {
      await toggleMarker(dayKey);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not save the marker.');
    }
  }

  async function handleClearMarkers() {
    setLocalError(null);
    try {
      await clearMarkers();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not clear the markers.');
    }
  }

  async function handleToggleWidget(monthKey: string, tool: ToolId) {
    setLocalError(null);
    try {
      await toggleWidget({ monthKey, tool });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not save the subscription.');
    }
  }

  return (
    <section className={styles.page} aria-labelledby="greenlight-title">
      <PageHeader
        title="Greenlight"
        subtitle="Deliverable value by week and month."
        titleId="greenlight-title"
        actions={<SaveStatus state={saveState} onRetry={retrySave} />}
      />

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

      {(localError || isError) && (
        <p className={styles.error} role="alert">
          {localError || 'Could not load Greenlight data from storage.'}
        </p>
      )}

      <div className={styles.totals}>
        <Stat
          label="Gross"
          value={hasData ? formatMoney(moneyBreakdown.gross, totals.currency) : '—'}
          tone="accent"
        />
        <Stat
          label={moneyBreakdown.charged ? 'Fee (10%)' : 'Fee (under min)'}
          value={hasData ? formatMoney(moneyBreakdown.fee, totals.currency) : '—'}
          tone="expense"
        />
        <Stat
          label="Net"
          value={hasData ? formatMoney(moneyBreakdown.net, totals.currency) : '—'}
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
          </div>
          {hasData ? (
            <MonthlyChart points={monthly} />
          ) : (
            <p className={styles.muted}>No months to chart yet.</p>
          )}
        </Panel>
      </div>

      <Panel aria-labelledby="weeks-title">
        <div className={styles.panelHeading}>
          <h2 id="weeks-title" className={styles.panelTitle}>
            Weeks
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
              widgets={state.widgets}
              onToggleMarker={(day) => void handleToggleMarker(day)}
              onToggleWidget={(monthKey, tool) => void handleToggleWidget(monthKey, tool)}
            />
            {/* Reserved so the first marker segments fill existing space instead
                of pushing the page height out from under the cursor. */}
            <div className={styles.segmentsSlot}>
              <SegmentSummary segments={segments} />
            </div>
          </>
        ) : (
          <p className={styles.muted}>No weeks to show.</p>
        )}
      </Panel>
    </section>
  );
}
