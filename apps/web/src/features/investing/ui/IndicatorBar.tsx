import {
  INDICATOR_IDS,
  isActive,
  type IndicatorId,
  type Indicators,
} from '@/features/investing/data/indicators';
import { isOffered } from '@/features/investing/hooks/useIndicatorSeries';

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
  vwap: 'VWAP',
  rsi: 'RSI 14',
  macd: 'MACD',
};

/** Said out loud on the one that is conditional, rather than left a mystery. */
const UNAVAILABLE: Partial<Record<IndicatorId, string>> = {
  vwap: 'Session VWAP needs intraday bars',
};

type IndicatorBarProps = {
  indicators: Indicators;
  timeframe: string;
  onToggle: (id: IndicatorId) => void;
};

export function IndicatorBar({ indicators, timeframe, onToggle }: IndicatorBarProps) {
  return (
    <div className={styles.bar} role="group" aria-label="Indicators">
      {INDICATOR_IDS.map((id) => {
        const offered = isOffered(id, timeframe);
        const on = offered && isActive(indicators, id);

        return (
          <button
            key={id}
            type="button"
            className={`${styles.toggle} ${on ? styles.on : ''}`}
            aria-pressed={on}
            disabled={!offered}
            title={offered ? undefined : UNAVAILABLE[id]}
            onClick={() => onToggle(id)}
          >
            {LABELS[id]}
          </button>
        );
      })}
    </div>
  );
}
