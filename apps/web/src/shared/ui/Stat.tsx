import { type ReactNode } from 'react';

import styles from './Stat.module.css';

type StatTone = 'default' | 'income' | 'expense' | 'accent';
type StatSize = 'sm' | 'md';

type StatProps = {
  label: string;
  value: ReactNode;
  tone?: StatTone;
  size?: StatSize;
};

export function Stat({ label, value, tone = 'default', size = 'md' }: StatProps) {
  return (
    <article className={`${styles.stat} ${styles[tone]} ${size === 'sm' ? styles.compact : ''}`}>
      <span className={styles.label}>{label}</span>
      <strong className={styles.value}>{value}</strong>
    </article>
  );
}
