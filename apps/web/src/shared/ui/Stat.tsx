import { type ReactNode } from 'react';

import styles from './Stat.module.css';

type StatTone = 'default' | 'income' | 'expense' | 'accent';

type StatProps = {
  label: string;
  value: ReactNode;
  tone?: StatTone;
};

export function Stat({ label, value, tone = 'default' }: StatProps) {
  return (
    <article className={`${styles.stat} ${styles[tone]}`}>
      <span className={styles.label}>{label}</span>
      <strong className={styles.value}>{value}</strong>
    </article>
  );
}
