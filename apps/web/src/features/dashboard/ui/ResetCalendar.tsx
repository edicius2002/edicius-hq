import { useMemo, useState } from 'react';

import type { CodexReset } from '@/shared/api/codexResets';

import { buildResetCalendar, formatBogotaDateTime } from '../lib/codexResetCalendar';
import styles from './ResetCalendar.module.css';

const WEEKDAYS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

function labelFor(day: ReturnType<typeof buildResetCalendar>['weeks'][number][number]): string {
  if (day.future) return `${day.key}, future date`;
  if (!day.resetType) return `No reset on ${day.key}`;
  const count = day.resets.length;
  return `${count} ${day.resetType} reset${count === 1 ? '' : 's'} on ${day.key}`;
}

export function ResetCalendar({
  resets,
  now,
  loading = false,
  unavailable = false,
}: {
  resets: CodexReset[];
  now: Date;
  loading?: boolean;
  unavailable?: boolean;
}) {
  const calendar = useMemo(() => buildResetCalendar(resets, now), [resets, now]);
  const latestDay = calendar.weeks
    .flat()
    .filter((day) => day.resets.length > 0)
    .at(-1);
  const [selectedKey, setSelectedKey] = useState<string | null>(latestDay?.key ?? null);
  const selected =
    calendar.weeks.flat().find((day) => day.key === selectedKey) ?? latestDay ?? null;

  return (
    <section className={styles.section} aria-labelledby="reset-history-title">
      <div className={styles.headingRow}>
        <h2 id="reset-history-title">Codex reset history</h2>
        <div className={styles.legend} aria-label="Calendar legend">
          <span>
            <i className={styles.regular} />
            regular
          </span>
          <span>
            <i className={styles.banked} />
            banked
          </span>
          <span>
            <i />
            no reset
          </span>
        </div>
      </div>
      <div className={styles.card}>
        <div className={styles.chart}>
          <div className={styles.weekdays} aria-hidden="true">
            <span />
            {WEEKDAYS.map((weekday, index) => (
              <span key={index}>{weekday}</span>
            ))}
          </div>
          <div className={styles.scroller}>
            <div className={styles.grid}>
              {calendar.monthLabels
                .filter(
                  (month, index, labels) =>
                    !labels[index + 1] || labels[index + 1].column - month.column >= 2,
                )
                .map((month) => (
                  <span
                    key={`${month.column}-${month.label}`}
                    className={styles.month}
                    style={{ gridColumn: month.column + 1, gridRow: 1 }}
                  >
                    {month.label}
                  </span>
                ))}
              {calendar.weeks.flatMap((week, column) =>
                week.map((day, weekday) => (
                  <button
                    key={day.key}
                    type="button"
                    className={styles.cell}
                    data-reset-type={day.resetType ?? undefined}
                    data-future={day.future || undefined}
                    aria-label={labelFor(day)}
                    aria-pressed={selected?.key === day.key}
                    aria-hidden={loading || unavailable || undefined}
                    disabled={loading || unavailable}
                    style={{ gridColumn: column + 1, gridRow: weekday + 2 }}
                    onFocus={() => setSelectedKey(day.key)}
                    onMouseEnter={() => setSelectedKey(day.key)}
                    onClick={() => setSelectedKey(day.key)}
                  />
                )),
              )}
            </div>
          </div>
        </div>
        <div className={styles.detailFrame}>
          <div className={styles.detailSizing} aria-hidden="true">
            {calendar.weeks
              .flat()
              .filter((day) => day.resets.length > 0)
              .map((day) => (
                <div className={styles.detailContent} key={day.key}>
                  <strong data-content={labelFor(day)} />
                  {day.resets.map((reset) => (
                    <small key={reset.id} data-content={formatBogotaDateTime(reset.announcedAt)} />
                  ))}
                </div>
              ))}
          </div>
          <div className={styles.detailContent} aria-live="polite">
            {loading ? (
              <strong role="status" aria-label="Loading Codex reset history">
                Loading Codex reset history…
              </strong>
            ) : unavailable ? (
              <strong role="status">Codex reset data unavailable.</strong>
            ) : selected ? (
              <>
                <strong>{labelFor(selected)}</strong>
                {selected.resets.map((reset) => (
                  <small key={reset.id}>{formatBogotaDateTime(reset.announcedAt)}</small>
                ))}
              </>
            ) : (
              <strong>No confirmed resets in this window.</strong>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
