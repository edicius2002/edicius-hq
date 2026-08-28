import type { Granularity } from '@/features/airfare/lib/buckets';

import styles from './PeriodSwitch.module.css';

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

type PeriodSwitchProps = {
  granularity: Granularity;
  onChange: (granularity: Granularity) => void;
};

/**
 * How much calendar one period covers, in the top-right corner of whichever
 * chart is open.
 *
 * It unfolds beside the date-cost chart button, which makes the period choice
 * visibly belong to that chart without giving it a permanent second corner.
 *
 * Chart A remains day-drawn; while it is open the period controls are folded,
 * and the table keeps its last selected grouping until the date-cost button
 * unfolds them again.
 */
export function PeriodSwitch({ granularity, onChange }: PeriodSwitchProps) {
  return (
    <div className={styles.switch} role="group" aria-label="How much time one period covers">
      {GRANULARITIES.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={granularity === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
