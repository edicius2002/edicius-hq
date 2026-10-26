import {
  INDICATOR_IDS,
  isActive,
  type IndicatorId,
  type Indicators,
} from '@/features/investing/data/indicators';

import styles from './IndicatorBar.module.css';

/**
 * The indicator toggles.
 *
 * Labels carry their period, because "RSI" and "RSI 14" are different claims
 * and the second is the one being drawn. The periods are fixed constants, not
 * settings — decision 8.23.
 */
const LABELS: Record<IndicatorId, string> = {
  volume: 'Volume',
  sma: 'SMA 20',
  ema: 'EMA 20',
  bollinger: 'BB 20/2',
  rsi: 'RSI 14',
  macd: 'MACD',
};

type IndicatorBarProps = {
  indicators: Indicators;
  onToggle: (id: IndicatorId) => void;
};

export function IndicatorBar({ indicators, onToggle }: IndicatorBarProps) {
  return (
    <div className={styles.bar} role="group" aria-label="Indicators">
      {INDICATOR_IDS.map((id) => {
        const on = isActive(indicators, id);

        return (
          <button
            key={id}
            type="button"
            className={`${styles.toggle} ${on ? styles.on : ''}`}
            aria-pressed={on}
            onClick={() => onToggle(id)}
          >
            {LABELS[id]}
          </button>
        );
      })}
    </div>
  );
}
