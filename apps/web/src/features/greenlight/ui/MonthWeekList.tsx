import { formatCount, formatMoney } from '@/features/greenlight/lib/format';
import type { MonthGroup } from '@/features/greenlight/model/types';

import styles from './MonthWeekList.module.css';

type MonthWeekListProps = {
  months: MonthGroup[];
};

export function MonthWeekList({ months }: MonthWeekListProps) {
  if (!months.length) {
    return null;
  }

  return (
    <div className={styles.list}>
      {months.map((month) => {
        const maxWeek = Math.max(...month.weeks.map((week) => week.amount), 1);
        return (
          <section key={month.key} className={styles.month}>
            <header className={styles.monthHeader}>
              <h3 className={styles.monthTitle}>{month.label}</h3>
              <p className={styles.monthMeta}>
                {formatMoney(month.amount, month.weeks[0]?.currency)} · {formatCount(month.tasks)}{' '}
                tasks
              </p>
            </header>
            <ul className={styles.weeks}>
              {month.weeks.map((week) => (
                <li key={week.key} className={styles.week}>
                  <div className={styles.weekLabel}>
                    <span>{week.label}</span>
                    <span>
                      {formatMoney(week.amount, week.currency)} · {formatCount(week.tasks)} tasks
                    </span>
                  </div>
                  <div className={styles.barTrack} aria-hidden="true">
                    <div
                      className={styles.barFill}
                      style={{ width: `${Math.max((week.amount / maxWeek) * 100, 4)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
