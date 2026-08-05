import { type CSSProperties } from 'react';

import { daysInWeek } from '@/features/greenlight/lib/aggregate';
import { formatMoney } from '@/features/greenlight/lib/format';
import { markerSegmentsForDays } from '@/features/greenlight/lib/segments';
import {
  MARKER_SEGMENT_STYLES,
  type DayStats,
  type MonthGroup,
} from '@/features/greenlight/model/types';

import styles from './MoneyWeekChart.module.css';

type MoneyWeekChartProps = {
  months: MonthGroup[];
  stats: Record<string, DayStats>;
  markers: string[];
  onToggleMarker: (dayKey: string) => void;
};

export function MoneyWeekChart({ months, stats, markers, onToggleMarker }: MoneyWeekChartProps) {
  if (!months.length) {
    return <p className={styles.empty}>No tasks to show.</p>;
  }

  const dayKeys = Object.keys(stats).sort();
  const { byDay, hasMarkers } = markerSegmentsForDays(dayKeys, markers);
  const allWeekKeys = months.flatMap((month) => month.weeks.map((week) => week.key));
  const lastWeekKey = allWeekKeys.at(-1);

  return (
    <div className={styles.list}>
      {months.map((month) => {
        const maxWeek = Math.max(...month.weeks.map((week) => week.amount), 0);
        return (
          <section key={month.key} className={styles.monthRow}>
            <h3 className={styles.monthTitle}>
              <span>{month.label}</span>
              <strong>{formatMoney(month.amount, month.currency)}</strong>
            </h3>
            <div className={styles.weeks}>
              {month.weeks.map((week) => {
                const weekDays = daysInWeek(stats, week.key);
                const segmentIndexes = [
                  ...new Set(
                    weekDays
                      .map((day) => byDay.get(day))
                      .filter((value): value is number => value !== undefined),
                  ),
                ];
                const segmentIndex = segmentIndexes.length === 1 ? segmentIndexes[0] : null;
                const segmentStyle =
                  hasMarkers && segmentIndex !== null
                    ? MARKER_SEGMENT_STYLES[segmentIndex % MARKER_SEGMENT_STYLES.length]
                    : null;

                const barHeight =
                  maxWeek > 0
                    ? Math.max((week.amount / maxWeek) * 100, week.amount > 0 ? 5 : 0)
                    : 0;
                const monthPct = month.amount > 0 ? (week.amount / month.amount) * 100 : 0;
                const pctLabel = `${monthPct.toFixed(1).replace(/\.0$/, '')}% of month`;

                const activeMarkerDay = weekDays.find((day) => markers.includes(day));
                const markerDay = activeMarkerDay || weekDays.at(-1);
                const isLastWeek = week.key === lastWeekKey;
                const segmentVars = segmentStyle
                  ? ({
                      '--segment-bg': segmentStyle.background,
                      '--segment-border': segmentStyle.border,
                      '--segment-color': segmentStyle.color,
                    } as CSSProperties)
                  : undefined;
                const markerVars = activeMarkerDay
                  ? ({
                      '--marker-color':
                        MARKER_SEGMENT_STYLES[
                          (byDay.get(markerDay!) || 0) % MARKER_SEGMENT_STYLES.length
                        ].color,
                    } as CSSProperties)
                  : undefined;

                return (
                  <div key={week.key} className={styles.weekCluster}>
                    <article
                      className={`${styles.weekCard} ${segmentStyle ? styles.segmented : ''}`}
                      style={segmentVars}
                    >
                      <strong className={styles.weekValue}>
                        {formatMoney(week.amount, week.currency)}
                      </strong>
                      <span className={styles.weekPct}>{pctLabel}</span>
                      <div
                        className={styles.barTrack}
                        role="img"
                        aria-label={`Tasks ${formatMoney(week.amount, week.currency)} in ${week.label}`}
                      >
                        <span className={styles.barFill} style={{ height: `${barHeight}%` }} />
                      </div>
                      <span className={styles.weekLabel}>Tasks</span>
                      <strong className={styles.weekRange}>{week.label}</strong>
                    </article>

                    {!isLastWeek && markerDay ? (
                      <button
                        type="button"
                        className={`${styles.markerSlot} ${activeMarkerDay ? styles.markerActive : ''}`}
                        title={activeMarkerDay ? 'Remove marker' : 'Add marker'}
                        aria-label={activeMarkerDay ? 'Remove marker' : 'Add marker'}
                        style={markerVars}
                        onClick={() => onToggleMarker(markerDay)}
                      >
                        <span className={styles.markerHandle}>{activeMarkerDay ? '✕' : '+'}</span>
                        <span className={styles.markerLine} />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
