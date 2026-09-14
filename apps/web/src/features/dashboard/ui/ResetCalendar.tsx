import { useMemo, useState } from 'react';

import type { CodexReset } from '@/shared/api/codexResets';

import { buildResetCalendar, formatBogotaDateTime } from '../lib/codexResetCalendar';
import styles from './ResetCalendar.module.css';

const WEEKDAYS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

function labelFor(day: ReturnType<typeof buildResetCalendar>['weeks'][number][number]): string {
  if (day.future) return `${day.key}, future date in Bogotá`;
  if (!day.resetType) return `No reset on ${day.key} (Bogotá)`;
  const count = day.resets.length;
  return `${count} ${day.resetType} reset${count === 1 ? '' : 's'} on ${day.key} (Bogotá)`;
}

export function ResetCalendar({ resets, now }: { resets: CodexReset[]; now: Date }) {
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
              {calendar.monthLabels.map((month) => (
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
        <div className={styles.detail} aria-live="polite">
          {selected ? (
            <>
              <strong>{labelFor(selected)}</strong>
              {selected.resets.map((reset) => (
                <span key={reset.id}>
                  {reset.text}{' '}
                  <a href={reset.source.url} target="_blank" rel="noreferrer">
                    View on X
                  </a>
                  <small>{formatBogotaDateTime(reset.announcedAt)}</small>
                </span>
              ))}
            </>
          ) : (
            <strong>No confirmed resets in this window.</strong>
          )}
        </div>
      </div>
    </section>
  );
}
