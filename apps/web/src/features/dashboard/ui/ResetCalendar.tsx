import { useEffect, useMemo, useRef, useState } from 'react';

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
  const days = calendar.weeks.flat();
  const latestDay = days.filter((day) => day.resets.length > 0).at(-1);
  const [pointerKey, setPointerKey] = useState<string | null>(null);
  const [keyboardKey, setKeyboardKey] = useState<string | null>(null);
  const [touchKey, setTouchKey] = useState<string | null>(null);
  const [lastInput, setLastInput] = useState<'pointer' | 'keyboard' | 'touch'>('pointer');
  const chartRef = useRef<HTMLDivElement>(null);
  const activeKey =
    (lastInput === 'keyboard' ? keyboardKey : lastInput === 'touch' ? touchKey : pointerKey) ??
    pointerKey ??
    keyboardKey ??
    touchKey;
  const selected = days.find((day) => day.key === activeKey) ?? latestDay ?? null;
  const active = activeKey !== null && selected?.key === activeKey;

  useEffect(() => {
    if (touchKey === null) return;
    const dismissTouch = (event: PointerEvent) => {
      if (!chartRef.current?.contains(event.target as Node)) setTouchKey(null);
    };
    document.addEventListener('pointerdown', dismissTouch);
    return () => document.removeEventListener('pointerdown', dismissTouch);
  }, [touchKey]);

  function selectPointer(dayKey: string, pointerType: string) {
    if (pointerType === 'touch') return;
    setPointerKey(dayKey);
    setTouchKey(null);
    setLastInput('pointer');
  }

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
        <div
          ref={chartRef}
          className={styles.chart}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'touch') setPointerKey(null);
          }}
          onPointerDown={(event) => {
            if (event.pointerType !== 'touch') setTouchKey(null);
          }}
        >
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
                    data-active={(active && selected?.key === day.key) || undefined}
                    aria-hidden={loading || unavailable || undefined}
                    disabled={loading || unavailable}
                    style={{ gridColumn: column + 1, gridRow: weekday + 2 }}
                    onFocus={(event) => {
                      if (event.currentTarget.matches(':focus-visible')) {
                        setKeyboardKey(day.key);
                        setLastInput('keyboard');
                      }
                    }}
                    onBlur={() => setKeyboardKey(null)}
                    onKeyDown={() => {
                      setKeyboardKey(day.key);
                      setLastInput('keyboard');
                    }}
                    onClick={(event) => {
                      if (event.detail === 0) {
                        event.currentTarget.focus();
                        setKeyboardKey(day.key);
                        setLastInput('keyboard');
                      }
                    }}
                    onPointerEnter={(event) => selectPointer(day.key, event.pointerType)}
                    onPointerMove={(event) => selectPointer(day.key, event.pointerType)}
                    onPointerDown={(event) => {
                      if (event.pointerType === 'touch') {
                        setTouchKey(day.key);
                        setLastInput('touch');
                      } else {
                        setPointerKey(day.key);
                        setKeyboardKey(null);
                        setLastInput('pointer');
                      }
                    }}
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
                  <strong>{labelFor(day)}</strong>
                  {day.resets.map((reset) => (
                    <small key={reset.id}>{formatBogotaDateTime(reset.announcedAt)}</small>
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
            ) : active && selected ? (
              <>
                <strong>{labelFor(selected)}</strong>
                {selected.resets.map((reset) => (
                  <small key={reset.id}>{formatBogotaDateTime(reset.announcedAt)}</small>
                ))}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
