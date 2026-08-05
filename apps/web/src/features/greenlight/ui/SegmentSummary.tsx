import { formatCount, formatMoney } from '@/features/greenlight/lib/format';
import type { SegmentSummaryItem } from '@/features/greenlight/model/types';

import styles from './SegmentSummary.module.css';

type SegmentSummaryProps = {
  segments: SegmentSummaryItem[];
};

export function SegmentSummary({ segments }: SegmentSummaryProps) {
  if (!segments.length) return null;

  return (
    <div className={styles.list}>
      {segments.map((segment) => (
        <article
          key={`${segment.rangeLabel}-${segment.closed ? 'closed' : 'open'}`}
          className={`${styles.card} ${segment.closed ? '' : styles.open}`}
        >
          <header className={styles.header}>
            <span className={styles.range}>{segment.rangeLabel}</span>
            <span className={styles.eyebrow}>
              {segment.closed
                ? `${segment.dayCount} day${segment.dayCount === 1 ? '' : 's'}`
                : 'In progress'}
            </span>
          </header>
          <div className={styles.metrics}>
            <div className={styles.metric}>
              <span>Gross</span>
              <strong className={styles.income}>
                {formatMoney(segment.amount, segment.currency)}
              </strong>
            </div>
            <div className={styles.metric}>
              <span>Fee (10%)</span>
              <strong>{formatMoney(segment.fee, segment.currency)}</strong>
            </div>
            <div className={styles.metric}>
              <span>Net</span>
              <strong className={styles.income}>
                {formatMoney(segment.net, segment.currency)}
              </strong>
            </div>
            <div className={styles.metric}>
              <span>Delivered tasks</span>
              <strong>{formatCount(segment.tasks)}</strong>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
