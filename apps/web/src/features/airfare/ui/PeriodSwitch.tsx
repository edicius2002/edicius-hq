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
 * **One component because there is one control, and it is rendered twice.**
 * `period-switch-is-in-its-chart` put it in the departure chart's corner and
 * took it off chart A altogether, which the owner read — correctly — as the
 * control disappearing. It is drawn in both corners now, and a shared component
 * is what stops that being two switches: two copies of this markup would drift
 * the moment one of them was restyled, and the reader would meet a different
 * control depending on which chart they came from.
 *
 * **It is live on chart A too, and that is not the dead control 12.242
 * described.** Chart A is drawn by day and by nothing else, so this does not
 * move the plot beside it — but it has never only moved a plot. It decides the
 * period the flight table below the panel is grouped by, which that table says
 * on its own heading, and it decides the frame the departure chart will open on
 * when the reader goes there. `period-switch-follows-its-chart` conceded both
 * points while folding the control away anyway; what it could not concede was
 * that a reader looking for a control they used a moment ago should find it
 * where they left it.
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
